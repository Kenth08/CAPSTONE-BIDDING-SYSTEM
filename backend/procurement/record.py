"""The procurement record: one composed, role-scoped view of a procurement from
filing to final award, with the blockchain evidence for each step.

WHY THIS EXISTS
---------------
The pieces already existed but were scattered: the project, its bids, the
award and its documents, and the anchor trail each came from a different
endpoint and were combined (or not) in the browser. That made it impossible to
answer "what happened in this procurement, and which of it is provable on the
blockchain?" in one place — and it left visibility rules to the UI.

Every rule here is enforced on the SERVER, per role:

    admin     everything, including anchor payloads
    head      all bids with amounts and outcomes (decision D3), award and award
              documents; never bid files, never payloads
    supplier  only a procurement they bid on (404 otherwise): their OWN bid in
              full plus its inclusion receipt, the winner's name, the contract
              amount only if they are the winner, award documents only if they
              are the winner; never another bidder's amount, identity, outcome
              or anchor, never the bid count
    public    see public_record() — winner and date only (decision D2)

Every timeline event says where its evidence lives: "database" (an
application record, audit-logged) or "blockchain" (one or more anchors, whose
own state says whether a transaction is verified, reported or pending).
"""
from django.utils import timezone

from .blockchain import (
    ETHERSCAN_TX_URL,
    EVALUATION_STAGE,
    LEDGER_CONTRACT_ADDRESS,
    SEPOLIA_CHAIN_ID,
    anchor_summary,
    inclusion_receipt,
    superseding_anchor,
    verify_anchor,
)
from .files import protected_file_url
from .models import AWARD_DOCUMENT_FIELDS, Award, Bid, BlockchainAnchor, Project, Supplier

Stage = BlockchainAnchor.Stage
HEAD_STAGES = {Stage.HEAD_APPROVED, Stage.HEAD_REJECTED, Stage.REVISION_REQUESTED}
HEAD_LABELS = {
    Stage.HEAD_APPROVED: "Approved by the Head",
    Stage.HEAD_REJECTED: "Rejected by the Head",
    Stage.REVISION_REQUESTED: "Revision requested by the Head",
}
DOC_LABELS = {stage: label for _, label, stage, _ in AWARD_DOCUMENT_FIELDS}


# ── Who may open which record ────────────────────────────────────────────────

def viewer_for(user, project):
    """("admin" | "head" | "supplier", supplier_or_None), or None when this user
    may not see this procurement's record at all."""
    role = getattr(user, "role", None)
    if role in {"admin", "head"}:
        return role, None
    if role == "supplier":
        supplier = Supplier.objects.filter(user=user).first()
        if supplier and Bid.objects.filter(project=project, supplier=supplier).exists():
            return "supplier", supplier
    return None


# ── Pieces ───────────────────────────────────────────────────────────────────

def _bid_row(bid):
    return {
        "id": bid.id,
        "supplier_name": bid.supplier.company,
        "amount": f"{bid.amount:.2f}",
        "status": bid.status,
        "status_label": bid.get_status_display(),
        "submitted_at": bid.submitted_at,
        "reviewed_at": bid.reviewed_at,
        "delivery_timeline": bid.delivery_timeline,
        "brand_name": bid.brand_name or "",
        "model_number": bid.model_number or "",
        "is_winner": bid.status == Bid.Status.WINNER,
        # Whether this bid's leaf is inside the EVALUATION_COMPLETED anchor.
        "committed": bool(bid.commitment_salt),
    }


def _visible_anchors(anchors, role, own_bid_ids):
    """Suppliers see the procurement's and the award's anchors, the evaluation
    commitment (it is opaque), and their OWN bid's anchor — never a rival's."""
    if role != "supplier":
        return anchors
    return [a for a in anchors
            if a.entity_type != BlockchainAnchor.EntityType.BID or a.entity_id in own_bid_ids]


def _anchor_row(anchor, *, include_payload, deep):
    data = anchor_summary(anchor, include_payload=include_payload)
    data["integrity"] = verify_anchor(anchor, deep=deep)
    newer = superseding_anchor(anchor)
    data["superseded_by"] = newer.id if newer else None
    return data


def _event(key, label, at, *, anchors=(), detail="", tone="neutral"):
    ids = [a["id"] for a in anchors]
    return {
        "key": key,
        "label": label,
        "at": at,
        "detail": detail,
        "tone": tone,
        # "blockchain" only when an anchor actually exists for it. The anchor's
        # own state (verified / reported / pending) is in blockchain.anchors.
        "source": "blockchain" if ids else "database",
        "anchor_ids": ids,
    }


def _timeline(project, role, bids, award, anchors, *, winner_amount_visible):
    by_stage = {}
    for a in anchors:
        by_stage.setdefault(a["stage"], []).append(a)

    events = [_event("filed", "Procurement filed for Head approval", project.created_at,
                     anchors=by_stage.get(Stage.SUBMITTED, []))]

    head_anchors = [a for a in anchors if a["stage"] in HEAD_STAGES]
    for a in head_anchors:
        events.append(_event(
            f"head-{a['id']}", HEAD_LABELS.get(a["stage"], a["stage_label"]), a["created_at"],
            anchors=[a], tone="danger" if a["stage"] == Stage.HEAD_REJECTED else "success"))
    if not head_anchors and project.reviewed_at:
        events.append(_event("head", f"Reviewed by the Head ({project.get_status_display()})",
                             project.reviewed_at))

    if project.published_at:
        events.append(_event("published", "Published — open for bidding", project.published_at,
                             anchors=by_stage.get(Stage.BIDDING_OPEN, []),
                             detail=f"Bid deadline {project.deadline:%b %d, %Y}" if project.deadline else ""))

    for bid in bids:
        who = "Your bid" if role == "supplier" else f"Bid from {bid.supplier.company}"
        events.append(_event(f"bid-{bid.id}", f"{who} received", bid.submitted_at,
                             detail="Database record — bids are not anchored one by one."))
        if bid.reviewed_at and bid.status in {Bid.Status.QUALIFIED, Bid.Status.DISQUALIFIED,
                                              Bid.Status.WINNER}:
            outcome = "disqualified" if bid.status == Bid.Status.DISQUALIFIED else "qualified"
            events.append(_event(
                f"eval-{bid.id}", f"{who} {outcome}", bid.reviewed_at,
                tone="danger" if outcome == "disqualified" else "success",
                detail="Database record (audit-logged); fixed on-chain by the evaluation commitment at award."))

    # Only once the deadline has really passed: a procurement can be awarded
    # before its deadline, and "Bidding closed" dated in the future is false.
    if project.deadline and project.deadline < timezone.localdate():
        events.append(_event("closed", "Bidding closed", project.deadline))

    for a in by_stage.get(EVALUATION_STAGE, []):
        events.append(_event("evaluation", "Evaluation committed — every bid and its outcome fixed",
                             a["created_at"], anchors=[a], tone="success",
                             detail="One salted fingerprint covering all bids; no amounts or names on-chain."))

    if award:
        detail = f"Awarded to {award.supplier.company}"
        if winner_amount_visible:
            detail += f" for ₱{award.amount:,.2f}"
        award_anchors = by_stage.get(Stage.BID_SUBMITTED, []) + by_stage.get(Stage.AWARDED, [])
        # Dated by the AWARDED anchor when there is one, so the award sorts after
        # the evaluation commitment it was recorded with (project.awarded_at is
        # stamped inside the award transaction, a moment before either anchor).
        awarded_at = next((a["created_at"] for a in award_anchors if a["stage"] == Stage.AWARDED),
                          project.awarded_at or award.awarded_at)
        events.append(_event("awarded", "Contract awarded", awarded_at,
                             anchors=award_anchors, detail=detail, tone="success"))
        for stage in (Stage.RESOLUTION_ISSUED, Stage.NOA_ISSUED, Stage.NTP_ISSUED):
            issues = by_stage.get(stage, [])
            for i, a in enumerate(issues):
                again = i > 0
                events.append(_event(
                    f"doc-{a['id']}", f"{DOC_LABELS[stage]} {'re-issued' if again else 'issued'}",
                    a["created_at"], anchors=[a],
                    detail="Earlier version superseded by a later issue." if a.get("superseded_by") else ""))

    return sorted(events, key=lambda e: (str(e["at"] or ""), e["key"]))


def _award_documents(award, request, anchors, *, can_read):
    """The three post-award documents with their full issue history. File links
    only for roles that may read them (files._can_read is still the gate)."""
    out = []
    for key, label, stage, issued_field in AWARD_DOCUMENT_FIELDS:
        history = [a for a in anchors
                   if a["entity_type"] == BlockchainAnchor.EntityType.AWARD
                   and a["entity_id"] == str(award.id) and a["stage"] == stage]
        out.append({
            "key": key,
            "label": label,
            "stage": stage,
            "issued_at": getattr(award, issued_field, None),
            "url": protected_file_url(request, "award", award, key) if can_read else None,
            "current_anchor_id": history[-1]["id"] if history else None,
            "anchor_ids": [a["id"] for a in history],
        })
    return out


def _counts(anchors):
    def n(test):
        return sum(1 for a in anchors if test(a))
    return {
        "total": len(anchors),
        "verified": n(lambda a: a["verified_on_chain"]),
        "reported": n(lambda a: a["tx_hash"] and not a["verified_on_chain"]
                      and a["chain_status"] != BlockchainAnchor.ChainStatus.MISMATCH),
        "mismatch": n(lambda a: a["chain_status"] == BlockchainAnchor.ChainStatus.MISMATCH),
        "pending": n(lambda a: not a["tx_hash"]),
        "altered": n(lambda a: a["integrity"]["status"] == "mismatch"),
        "superseded": n(lambda a: a["integrity"]["status"] == "superseded"),
    }


# ── The authenticated record ─────────────────────────────────────────────────

def build_record(project, role, supplier, request, *, deep=False):
    all_bids = list(project.bids.select_related("supplier").order_by("submitted_at", "id"))
    own_bids = [b for b in all_bids if supplier and b.supplier_id == supplier.id]
    bids = own_bids if role == "supplier" else all_bids
    award = (Award.objects.select_related("supplier", "bid")
             .filter(project=project, status=Award.Status.WON).first())
    is_winner = bool(award and supplier and award.supplier_id == supplier.id)

    raw = list(BlockchainAnchor.objects.filter(entity_ref=project.code).order_by("created_at", "id"))
    raw = _visible_anchors(raw, role, {str(b.id) for b in own_bids})
    anchors = [_anchor_row(a, include_payload=(role == "admin"), deep=deep and role != "supplier")
               for a in raw]

    winner_amount_visible = role in {"admin", "head"} or is_winner

    result = None
    if award:
        result = {
            "state": "awarded",
            "winner": award.supplier.company,
            "awarded_at": project.awarded_at or award.awarded_at,
            "expected_delivery_date": project.expected_delivery_date,
            "amount": f"{award.amount:.2f}" if winner_amount_visible else None,
            "you_won": is_winner if role == "supplier" else None,
        }
    elif project.status == Project.Status.CLOSED:
        result = {"state": "closed", "detail": "Bidding closed — no award has been made yet."}

    record = {
        "viewer": role,
        "project": {
            "id": project.id,
            "code": project.code,
            "name": project.name,
            "category": project.category,
            "type": project.type,
            "budget": f"{project.budget:.2f}",
            "status": project.status,
            "status_label": project.get_status_display(),
            "delivery_location": project.delivery_location,
            "bidding_period_days": project.bidding_period_days,
            "delivery_period_days": project.delivery_period_days,
            "deadline": project.deadline,
            "created_at": project.created_at,
            "reviewed_at": project.reviewed_at,
            "published_at": project.published_at,
            "awarded_at": project.awarded_at,
            "expected_delivery_date": project.expected_delivery_date,
            "reject_reason": project.reject_reason if role != "supplier" else "",
        },
        "timeline": _timeline(project, role, bids, award, anchors,
                              winner_amount_visible=winner_amount_visible),
        "bids": [_bid_row(b) for b in bids],
        "result": result,
        "award_documents": (
            _award_documents(award, request, anchors, can_read=(role != "supplier" or is_winner))
            if award and (role != "supplier" or is_winner) else []
        ),
        "blockchain": {
            "network": "Ethereum Sepolia testnet",
            "chain_id": SEPOLIA_CHAIN_ID,
            "contract_address": LEDGER_CONTRACT_ADDRESS,
            "explorer_tx_url": ETHERSCAN_TX_URL,
            "deep_checked": deep and role != "supplier",
            "anchors": anchors,
            "counts": _counts(anchors),
            "what_is_on_chain": (
                "Only SHA-256 fingerprints with the entity type, procurement code and stage. "
                "No amounts, names or documents are ever written to the blockchain."
            ),
        },
    }
    if role != "supplier":
        record["bid_count"] = len(all_bids)
    else:
        record["receipts"] = [
            {"bid_id": b.id, "receipt": inclusion_receipt(b)} for b in own_bids
        ]
    return record


# ── The public record (no login) ─────────────────────────────────────────────

PUBLIC_STATUSES = (Project.Status.PUBLISHED, Project.Status.CLOSED, Project.Status.AWARDED)


def public_award_date(project, award):
    """The award date the public sees: a date, never the exact time. Taken as a
    Philippine date, like every other date in the system, so an award at 01:30 in
    Manila isn't shown as the day before. The exact time stays in
    Project.awarded_at for the private commitment and for signed-in viewers."""
    return timezone.localdate(project.awarded_at) if project.awarded_at else award.awarded_at


def public_record(project):
    """Decision D2: the public sees WHO won and on what DATE — no contract amount, no
    bid count after award, no bids, no payloads. The ABC and the deadline are
    already public on the results page. The hash-only trail (with its
    verification) is served by PublicAnchorTrailView alongside this."""
    award = (Award.objects.select_related("supplier")
             .filter(project=project, status=Award.Status.WON).first())
    if project.status == Project.Status.AWARDED and award:
        result = {"state": "awarded", "winner": award.supplier.company,
                  "awarded_at": public_award_date(project, award)}
    elif project.status == Project.Status.CLOSED:
        result = {"state": "closed", "detail": "Bidding closed — no award has been made yet."}
    else:
        result = {"state": "open", "detail": "Open for bidding."}
    data = {
        "code": project.code,
        "name": project.name,
        "category": project.category,
        "type": project.type,
        "budget": f"{project.budget:.2f}",
        "status": project.status,
        "status_label": project.get_status_display(),
        "delivery_location": project.delivery_location,
        "published_at": project.published_at,
        "deadline": project.deadline,
        "result": result,
    }
    if project.status == Project.Status.PUBLISHED:
        # Same as the public list already shows for open biddings.
        data["bids_received"] = project.bids.count()
    return data
