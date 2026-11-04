"""One blockchain record (anchor), in full: what it is, which document and
which version it vouches for, and every piece of chain evidence the server
holds about it — the data behind the record details page.

Visibility mirrors what each viewer already sees in the procurement's trail
(record._visible_anchors and the public trail): public → any anchor of a
public procurement (bid document hashes withheld, as in the public trail);
admin/head → all; a supplier who bid → everything but a rival's bid anchor.
Seeing a record's chain evidence is NOT the same as getting its payload: the
verification packet stays behind packets.may_see_packet, and
`packet_available` says whether this viewer can verify it independently.

Nothing here is inferred. A value the server does not have (no transaction,
no on-chain id yet, finality unknown) is returned as null/empty, and the page
says so rather than filling it in.
"""
import os

from .blockchain import (
    ETHERSCAN_TX_URL,
    LEDGER_CONTRACT_ADDRESS,
    SEPOLIA_CHAIN_ID,
    chain_identity,
    superseding_anchor,
    verify_anchor,
)
from .document_versions import document_slot, versions_for
from .files import _can_read, _is_public, display_name, protected_file_url
from .models import Bid, BlockchainAnchor
from .packets import may_see_packet
from .record import PUBLIC_STATUSES, public_date
from .verification import summarize

EntityType = BlockchainAnchor.EntityType

EVIDENCE_TEXT = {
    "verified": "Confirmed on-chain: the server read this transaction from Sepolia and found this exact record "
                "in an event emitted by the ledger contract, and the contract's stored record agrees.",
    "reported": "Transaction reported: a transaction hash was submitted for this record but the server has not "
                "confirmed it on Sepolia yet. Treat it as a claim.",
    "mismatch": "The reported transaction does not record this entry. It is not on-chain evidence for this record.",
    "database": "Database record only: the fingerprint is stored in this system but has not been written to the "
                "blockchain.",
}


def may_view_anchor(anchor, project, role, supplier=None):
    if anchor.entity_ref != project.code:
        return False
    if role is None:
        return project.status in PUBLIC_STATUSES
    if role in {"admin", "head"}:
        return True
    if role == "supplier" and supplier is not None:
        if anchor.entity_type != EntityType.BID:
            return True
        return Bid.objects.filter(pk=anchor.entity_id or 0, supplier=supplier, project=project).exists()
    return False


def _evidence(anchor):
    if anchor.chain_status == BlockchainAnchor.ChainStatus.MISMATCH:
        return "mismatch"
    if anchor.verified_on_chain:
        return "verified"
    if anchor.tx_hash:
        return "reported"
    return "database"


def _file_finder(request, project, role):
    """file_for(kind, record, field) → (url, name) under files.py's rules."""
    user = getattr(request, "user", None)

    def file_for(kind, record, field):
        if role is None:
            # The public may download exactly one file: the current Notice of
            # Award of an awarded procurement, through its own public route —
            # whether it is addressed as the award's field or as the version
            # row that holds the same stored file. Earlier issues stay private.
            if kind == "awardversion":
                award, key = record.award, record.key
                current = getattr(award, key, None)
                if current and current.name == record.file.name and _is_public("award", award, key):
                    path = f"/api/public/procurement/{project.code}/notice-of-award/"
                    return request.build_absolute_uri(path), None
                return None, None
            if kind == "award" and _is_public(kind, record, field):
                path = f"/api/public/procurement/{project.code}/notice-of-award/"
                return request.build_absolute_uri(path), None
            return None, None
        if not _can_read(user, kind, record, field):
            return None, None
        field_file = getattr(record, field, None)
        return protected_file_url(request, kind, record, field), display_name(record, field, field_file)

    return file_for


def build_anchor_detail(anchor, project, role, supplier, request):
    public = role is None
    hide_doc_hash = public and anchor.entity_type == EntityType.BID   # as the public trail does
    field, label = document_slot(anchor)
    versions = versions_for(anchor, file_for=_file_finder(request, project, role)) if field else []
    for v in versions:
        if public:
            v["issued_at"] = public_date(v["issued_at"])
        if hide_doc_hash:
            v["document_hash"] = ""
        if public and v["file_note"] == "You do not have access to this file.":
            v["file_note"] = "Not available to the public."
    this_version = next((v for v in versions if v["anchor_id"] == anchor.id), None)
    newer = superseding_anchor(anchor)
    file_name = (this_version or {}).get("file_name")
    stored_payload = isinstance(anchor.payload, dict) and bool(anchor.payload)
    # A record whose payload was never stored can't be verified by anyone; for
    # the rest, the packet rule decides.
    packet_ok = stored_payload and may_see_packet(anchor, project, role, supplier)

    visible = [a for a in BlockchainAnchor.objects.filter(entity_ref=project.code).order_by("id")
               if may_view_anchor(a, project, role, supplier)]
    slot_counts, records = {}, []
    for a in visible:
        slot = (a.entity_type, a.entity_id, a.stage)
        slot_counts[slot] = slot_counts.get(slot, 0) + 1
        records.append({"id": a.id, "stage": a.stage, "stage_label": a.get_stage_display(),
                        "document_label": document_slot(a)[1], "issue": slot_counts[slot],
                        "_slot": slot})
    for r in records:
        r["issues"] = slot_counts[r.pop("_slot")]

    integrity = verify_anchor(anchor)
    chain = chain_identity(anchor)
    if public:
        chain["chain_timestamp"] = public_date(chain["chain_timestamp"])

    return {
        "viewer": role or "public",
        "procurement": {
            "id": None if public else project.id,
            "code": project.code,
            "name": project.name,
            "status": project.status,
            "status_label": project.get_status_display(),
        },
        "record": {
            "id": anchor.id,
            "entity_type": anchor.entity_type,
            "stage": anchor.stage,
            "stage_label": anchor.get_stage_display(),
            "created_at": public_date(anchor.created_at) if public else anchor.created_at,
            "data_hash": anchor.data_hash,
            "document_hash": "" if hide_doc_hash else anchor.document_hash,
            "tx_hash": anchor.tx_hash,
            # Only ever built from the hash actually stored for this record.
            "explorer_url": (ETHERSCAN_TX_URL + anchor.tx_hash) if anchor.tx_hash else "",
            "block_number": anchor.block_number,
            "actor_address": anchor.actor_address,
            "chain_status": anchor.chain_status,
            "chain_checked_at": public_date(anchor.chain_checked_at) if public else anchor.chain_checked_at,
            "verified_on_chain": anchor.verified_on_chain,
            "superseded_by": newer.id if newer else None,
            **chain,
        },
        "evidence": _evidence(anchor),
        "evidence_text": EVIDENCE_TEXT[_evidence(anchor)],
        "integrity": integrity,
        "verification": summarize(anchor, integrity),
        "network": {
            "name": "Sepolia",
            "chain_id": SEPOLIA_CHAIN_ID,
            "contract": LEDGER_CONTRACT_ADDRESS,
        },
        "document": None if field is None else {
            "field": field,
            "label": label,
            "file_name": file_name,
            "file_type": (os.path.splitext(file_name)[1].lstrip(".").upper() or None) if file_name else None,
            "version": this_version,
        },
        "versions": versions,
        "records": records,
        "packet_available": packet_ok,
        # Why not, when not: the payload was never stored (nobody can verify
        # it), or this viewer may not have it (confidential to other roles).
        "packet_unavailable_reason": (
            None if packet_ok else "missing_payload" if not stored_payload else "restricted"),
    }
