"""Verification packets: everything needed to check ONE anchor without trusting
this server.

WHY THIS EXISTS
---------------
On-chain, an anchor is only (entityType, procurement code, stage, dataHash).
`dataHash` is the SHA-256 of a canonical JSON payload, and the evidence
document's hash sits INSIDE that payload. So "this file belongs to that
blockchain record" can only be checked by someone who also holds the payload:

    sha256(file bytes)            == payload.document_hash
    sha256(canonical(payload))    == dataHash
    getAnchor(id) on the ledger   == (entityType, code, stage, dataHash, signer, time)

A packet is that payload plus the rules and the on-chain identity. It is served
EXACTLY as stored when the anchor was created (BlockchainAnchor.payload — the
same dict whose hash was recorded): never rebuilt from the live record, never
re-serialized under newer rules. If the stored payload does not reproduce the
recorded hash, the packet says so instead of "fixing" it.

WHO GETS WHICH PACKET (enforced here, never by the UI)
------------------------------------------------------
Payloads can't be redacted — removing a field changes the hash — so a packet
is either served whole or not at all:

    public        project-stage anchors (filed, Head decisions, published) of a
                  procurement that is itself public, and only if every payload
                  key is on PUBLIC_PROJECT_KEYS (all already shown publicly)
    admin, head   every anchor of the procurement
    supplier      (only one who bid — see record.viewer_for)
                  the public ones; the evaluation commitment with THEIR OWN
                  inclusion receipt; and, only if they won, the award anchors
                  and their own winning-bid anchor
    anyone else   404, the same answer as "no such anchor"
"""
from .blockchain import (
    EVALUATION_STAGE,
    LEDGER_CONTRACT_ADDRESS,
    SEPOLIA_CHAIN_ID,
    chain_identity,
    hash_payload,
    inclusion_receipt,
    superseding_anchor,
)
from .models import Award, Bid, BlockchainAnchor
from .record import PUBLIC_STATUSES

PACKET_VERSION = 1

Stage = BlockchainAnchor.Stage
EntityType = BlockchainAnchor.EntityType

PUBLIC_PROJECT_STAGES = frozenset({
    Stage.SUBMITTED, Stage.HEAD_APPROVED, Stage.HEAD_REJECTED, Stage.REVISION_REQUESTED, Stage.BIDDING_OPEN,
})
# Every key a project-stage payload has ever had (v2, plus v1's retired
# lifecycle fields). All of it is already on the public procurement pages
# (name, category, type, ABC budget, periods) or harmless (dates, the stage's
# document hash). A payload with any OTHER key is withheld from the public,
# so a future field can never leak just because it was added to the payload.
PUBLIC_PROJECT_KEYS = frozenset({
    "v", "entity", "stage", "code", "name", "category", "type", "budget",
    "bidding_period_days", "delivery_period_days", "created_at", "document_hash",
    "status", "deadline", "reviewed_at", "published_at",
})

# The exact rules blockchain.hash_payload / hash_file apply. Shipped in every
# packet so a verifier needs nothing else.
HASHING = {
    "algorithm": "SHA-256",
    "data_hash": "0x followed by the lowercase hex SHA-256 of the UTF-8 bytes of canonical_json(payload)",
    "canonical_json": (
        "Python json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=True): "
        "object keys sorted by code point at every level; no whitespace; every non-ASCII character "
        "escaped as \\uXXXX (UTF-16 code units, lowercase hex); integers as plain digits; money and "
        "dates are already strings in the payload"
    ),
    "document_hash": (
        "0x followed by the lowercase hex SHA-256 of the exact file bytes as stored by the system. "
        "Use the copy downloaded from the system: uploaded images are re-encoded to strip metadata."
    ),
    "reference_implementation": "backend/procurement/blockchain.py hash_payload; "
                                "frontend/src/blockchain/receipt.js canonicalJson",
}


# ── Access ───────────────────────────────────────────────────────────────────

def is_public_packet(anchor, project):
    """May anyone, logged in or not, have this anchor's packet?"""
    payload = anchor.payload if isinstance(anchor.payload, dict) else {}
    return (
        project.status in PUBLIC_STATUSES
        and anchor.entity_type == EntityType.PROJECT
        and anchor.stage in PUBLIC_PROJECT_STAGES
        and payload.get("entity") == EntityType.PROJECT
        and set(payload) <= PUBLIC_PROJECT_KEYS
    )


def _winning_award(project, supplier):
    return Award.objects.filter(project=project, supplier=supplier).order_by("-id").first()


def may_see_packet(anchor, project, role, supplier=None):
    """True when `role` (None = public) may have this anchor's packet. The
    anchor must belong to `project` — callers look it up by code first."""
    if anchor.entity_ref != project.code:
        return False
    if role in {"admin", "head"}:
        return True
    if is_public_packet(anchor, project):
        return True
    if role != "supplier" or supplier is None:
        return False
    if anchor.stage == EVALUATION_STAGE:
        # Opaque salted leaves; useful to a bidder only with their own receipt.
        return Bid.objects.filter(project=project, supplier=supplier).exclude(commitment_salt="").exists()
    award = _winning_award(project, supplier)
    if award is None:
        return False                     # a losing bidder: their receipt only
    if anchor.entity_type == EntityType.AWARD:
        return anchor.entity_id == str(award.id)
    if anchor.entity_type == EntityType.BID:
        return anchor.entity_id == str(award.bid_id or "")
    return False


# ── Building ─────────────────────────────────────────────────────────────────

def build_packet(anchor, *, receipt_bid=None):
    """The packet for one anchor (access already decided by the caller).

    `receipt_bid` attaches that bid's inclusion receipt (its own leaf inputs,
    salt included) to an EVALUATION_COMPLETED packet — only ever the caller's
    own bid."""
    payload = anchor.payload if isinstance(anchor.payload, dict) else {}
    reproduces = bool(payload) and hash_payload(payload) == anchor.data_hash
    document_hash = payload.get("document_hash", "") if payload else ""
    newer = superseding_anchor(anchor)

    limitations = []
    if not payload:
        limitations.append("The payload for this record was not stored, so it cannot be verified independently.")
    elif not reproduces:
        limitations.append("The stored payload does not reproduce the recorded fingerprint. It is shown exactly "
                           "as stored; treat this record as unverified.")
    if payload and payload.get("v") == 1:
        limitations.append("Legacy (v1) payload: it is verified exactly as it was stored, including fields "
                           "that later versions no longer hash.")
    if not anchor.tx_hash:
        limitations.append("No transaction has been reported for this record: it is not on the blockchain yet.")
    elif anchor.chain_anchor_id is None:
        limitations.append("The server has not linked this record to an on-chain id yet; a verifier has to "
                           "find it by searching the contract for this code, stage and fingerprint.")
    if anchor.stage != EVALUATION_STAGE and not document_hash:
        limitations.append("This record does not fingerprint a document.")
    if newer is not None:
        limitations.append(f"Superseded: this document was issued again later (anchor {newer.id}).")

    packet = {
        "packet_version": PACKET_VERSION,
        "anchor": {
            "id": anchor.id,
            "entity_type": anchor.entity_type,
            "entity_ref": anchor.entity_ref,
            "stage": anchor.stage,
            "stage_label": anchor.get_stage_display(),
            "created_at": anchor.created_at,
            "superseded_by": newer.id if newer else None,
        },
        "payload": payload or None,
        "payload_version": payload.get("v") if payload else None,
        "data_hash": anchor.data_hash,
        "document_hash": document_hash,
        "hashing": HASHING,
        # What a verifier must check against: the network and contract THIS
        # deployment uses. A verifier should compare them with its own
        # configuration, not take them from the packet on trust.
        "expected": {
            "network": "sepolia",
            "chain_id": SEPOLIA_CHAIN_ID,
            "contract": LEDGER_CONTRACT_ADDRESS,
        },
        # What the server has recorded/verified about the transaction. Claims
        # until a verifier reads the chain itself.
        "recorded": {
            "tx_hash": anchor.tx_hash,
            "block_number": anchor.block_number,
            "actor_address": anchor.actor_address,
            "chain_status": anchor.chain_status,
            "verified_by_server": anchor.verified_on_chain,
            **chain_identity(anchor),
        },
        "server_check": {
            "payload_reproduces_data_hash": reproduces,
            "document_hash_matches_anchor": document_hash == (anchor.document_hash or ""),
        },
        "limitations": limitations,
    }
    if receipt_bid is not None and anchor.stage == EVALUATION_STAGE:
        receipt = inclusion_receipt(receipt_bid)
        if receipt is not None:
            packet["receipt"] = {"leaf_fields": receipt["leaf_fields"], "leaf": receipt["leaf"]}
    return packet


def packet_for(anchor, project, role, supplier=None):
    """The packet `role` may have for `anchor`, or None (→ 404)."""
    if not may_see_packet(anchor, project, role, supplier):
        return None
    own_bid = None
    if role == "supplier" and anchor.stage == EVALUATION_STAGE:
        own_bid = Bid.objects.filter(project=project, supplier=supplier).exclude(commitment_salt="").first()
    return build_packet(anchor, receipt_bid=own_bid)
