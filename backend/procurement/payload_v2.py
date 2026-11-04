"""Payload version 2 — FROZEN. Do not edit.

These builders define exactly what a v2 anchor hashed. Every v2 anchor already
on Sepolia is verified by rebuilding its payload through THIS module, so any
change here — a field added, renamed, reformatted or reordered in meaning —
would make honest v2 records verify as altered. A new payload shape goes in a
new module (payload_v3, …) registered in blockchain.PAYLOAD_RULES; this one
stays as it is for as long as v2 anchors exist.

History (moved here from blockchain.py):

v2 — removed the mutable lifecycle fields (project: status/deadline/
     reviewed_at/published_at, bid: status/reviewed_at). They changed as a
     procurement advanced, so re-hashing an earlier stage produced a different
     value and verify_anchor branded untouched records as altered. A verifier
     that cries tampering on every normal procurement is worse than no
     verifier, so only fields that are final at anchor time are hashed.
v1 — original shape. Anchors written under it are still on-chain and are
     verified by the compatibility path in blockchain.py (_legacy_record_ok),
     which compares them against the fields THIS module still produces —
     never re-hashed under v2 rules.

The evaluation commitment (EVALUATION_COMPLETED) was introduced while v2 was
current, so its payload and leaf shape are part of v2 as well.
"""
from .canonical import hash_payload

VERSION = 2

# Payload keys that re-issuing a post-award document is EXPECTED to change.
# Everything else in an award payload (amount, winner, bid, award date…) must
# still equal the live record on a superseded issue (blockchain._superseded_record_ok).
REISSUE_KEYS = frozenset({"v", "document_hash", "issued_at"})


def iso(value):
    """Stable ISO-8601 text for dates/datetimes (or "" for None), exactly as v2
    formats them. Frozen with the builders: a payload's date format is part of
    its version."""
    if value is None:
        return ""
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)


def project_payload(project, stage, document_hash=""):
    """What a procurement WAS at `stage`, as a hashable snapshot.

    Only fields that are already final when the anchor is taken belong here.
    `status`, `deadline`, `reviewed_at` and `published_at` were in v1 and had to
    come out: they keep changing as the procurement advances, so re-hashing an
    early stage later produced a different value and the verifier reported
    honest records as altered — every project that got past its first step lit
    up red.

    Nothing meaningful is lost. `stage` already says what the status was, the
    ordering and timing of the steps are proven by the anchors' own on-chain
    timestamps — which are far harder to forge than a database column — and the
    deadline that matters is the one bound into the AWARD stages.
    """
    return {
        "v": VERSION,
        "entity": "PROJECT",
        "stage": str(stage),
        "code": project.code,
        "name": project.name,
        "category": project.category or "",
        "type": project.type or "",
        "budget": f"{project.budget:.2f}",
        "bidding_period_days": project.bidding_period_days or 0,
        "delivery_period_days": project.delivery_period_days or 0,
        "created_at": iso(project.created_at),
        "document_hash": document_hash,
    }


def bid_payload(bid, stage, document_hash=""):
    return {
        "v": VERSION,
        "entity": "BID",
        "stage": str(stage),
        "project_code": bid.project.code,
        "bid_id": bid.id,
        # The supplier is referenced by id only — the company name is personal /
        # commercial data and is not needed to prove the record is unaltered.
        "supplier_id": bid.supplier_id,
        "amount": f"{bid.amount:.2f}",
        "delivery_timeline": bid.delivery_timeline or "",
        "submitted_at": iso(bid.submitted_at),
        # `status` and `reviewed_at` were dropped in v2 for the same reason as
        # the project's: they change after the anchor is taken (under_review →
        # qualified → winner), which made an honest bid verify as altered.
        "document_hash": document_hash,
    }


def award_payload(award, stage, document_hash="", issued_at=""):
    return {
        "v": VERSION,
        "entity": "AWARD",
        "stage": str(stage),
        "project_code": award.project.code,
        "award_id": award.id,
        "bid_id": award.bid_id or 0,
        "supplier_id": award.supplier_id,
        "amount": f"{award.amount:.2f}",
        "status": award.status,
        "awarded_at": iso(award.awarded_at),
        # When this document was issued. Inside the hash on purpose: it is the
        # single field a backdated Notice to Proceed would have to change, and
        # changing it breaks the anchor.
        "issued_at": issued_at,
        "document_hash": document_hash,
    }


# ── Evaluation commitment (EVALUATION_COMPLETED) ─────────────────────────────
#   leaf(bid) = SHA-256 of {bid_id, supplier_id, amount, submitted_at,
#                           document_hash (the quotation file), status, salt}
#   payload   = {v, entity, stage, code, bid_count, leaves: [leaf, ...]}  (by bid id)
# See blockchain.py for why the salt makes this private.

def bid_leaf_fields(bid):
    """Exactly what goes into one bid's leaf, in the shape the receipt shows."""
    return {
        "bid_id": bid.id,
        "supplier_id": bid.supplier_id,
        "amount": f"{bid.amount:.2f}",
        "submitted_at": iso(bid.submitted_at),
        "document_hash": bid.committed_document_hash or "",
        "status": bid.status,
        "salt": bid.commitment_salt or "",
    }


def bid_leaf(bid):
    return hash_payload(bid_leaf_fields(bid))


def evaluation_payload(project, bids, stage="EVALUATION_COMPLETED"):
    rows = sorted(bids, key=lambda b: b.id)
    return {
        "v": VERSION,
        "entity": "PROJECT",
        "stage": str(stage),
        "code": project.code,
        "bid_count": len(rows),
        "leaves": [bid_leaf(b) for b in rows],
    }
