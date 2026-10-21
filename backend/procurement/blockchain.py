"""Blockchain anchoring layer.

Turns each procurement status transition into a deterministic SHA-256 hash of
the record + its key document, stores that hash locally as a BlockchainAnchor,
and (in the browser, via MetaMask) writes it to the ProcurementLedger contract on
the Sepolia testnet.

Design rules this module exists to enforce:

1. **Hashes only.** Nothing but a SHA-256 digest and minimal event metadata ever
   reaches the chain — no documents, no PII, no bid amounts.
2. **Never break the business flow.** Every public helper here swallows its own
   exceptions, exactly like accounts.audit.log_action. Anchoring is a side
   effect: if hashing a file on remote storage fails, the approval still stands
   and the anchor is simply missing (and retryable).
3. **Deterministic.** The same record must hash to the same value on any machine,
   any Python version, forever — so payloads are built from explicit primitive
   fields (never Django objects, floats, or dict ordering) and serialized with
   json.dumps(sort_keys=True, separators=(",", ":")).
"""
import hashlib
import json
import logging
import os
from datetime import timedelta

from django.utils import timezone

from .models import AWARD_DOCUMENT_ISSUED_FIELDS, BlockchainAnchor

logger = logging.getLogger(__name__)

# Anchoring can be turned off entirely (e.g. in CI) without touching any view.
ANCHORING_ENABLED = os.environ.get("BLOCKCHAIN_ANCHORING_ENABLED", "True").lower() == "true"

# Server-side signing (stretch goal): when true, the backend submits the
# transaction itself with web3.py instead of waiting for a MetaMask signature.
# Off by default — MetaMask is the demo path.
SERVER_SIGNING_ENABLED = os.environ.get("BLOCKCHAIN_SERVER_SIGNING", "False").lower() == "true"

LEDGER_CONTRACT_ADDRESS = os.environ.get("LEDGER_CONTRACT_ADDRESS", "")
SEPOLIA_RPC_URL = os.environ.get("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com")
SEPOLIA_CHAIN_ID = int(os.environ.get("SEPOLIA_CHAIN_ID", "11155111"))
# Only read when SERVER_SIGNING_ENABLED is on. Never hardcode this, never commit it.
BLOCKCHAIN_PRIVATE_KEY = os.environ.get("BLOCKCHAIN_PRIVATE_KEY", "")

ETHERSCAN_TX_URL = "https://sepolia.etherscan.io/tx/"

# Which document is the "evidence" for each stage. The whole point of hashing a
# document alongside the record is that swapping the file after the fact breaks
# the hash — so each stage names the file that mattered at that moment.
STAGE_DOCUMENT_FIELD = {
    BlockchainAnchor.Stage.SUBMITTED: "purchase_request",
    BlockchainAnchor.Stage.HEAD_APPROVED: "approved_budget_document",
    BlockchainAnchor.Stage.HEAD_REJECTED: "purchase_request",
    BlockchainAnchor.Stage.REVISION_REQUESTED: "purchase_request",
    BlockchainAnchor.Stage.BIDDING_OPEN: "bid_evaluation_criteria",
    BlockchainAnchor.Stage.BID_SUBMITTED: "quotation_document",
    BlockchainAnchor.Stage.BID_QUALIFIED: "quotation_document",
    BlockchainAnchor.Stage.BID_DISQUALIFIED: "quotation_document",
    BlockchainAnchor.Stage.AWARDED: "quotation_document",
    # Post-award documents live on the Award itself, not on the winning bid.
    BlockchainAnchor.Stage.RESOLUTION_ISSUED: "award_resolution",
    BlockchainAnchor.Stage.NOA_ISSUED: "notice_of_award",
    BlockchainAnchor.Stage.NTP_ISSUED: "notice_to_proceed",
}

# Stages whose evidence document is a field on the Award row rather than on the
# winning bid — anchor_award() reads the file from `award` for these.
AWARD_OWN_DOCUMENT_STAGES = {
    BlockchainAnchor.Stage.RESOLUTION_ISSUED,
    BlockchainAnchor.Stage.NOA_ISSUED,
    BlockchainAnchor.Stage.NTP_ISSUED,
}


# ── Hashing ──────────────────────────────────────────────────────────────────
def hash_payload(payload):
    """Deterministic SHA-256 of a dict, "0x"-prefixed.

    sort_keys makes it independent of insertion order and the compact separators
    remove any whitespace ambiguity, so the frontend / an external auditor can
    reproduce this byte-for-byte from the same JSON."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return "0x" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def hash_file(file_field):
    """SHA-256 of an uploaded file's contents, "0x"-prefixed, or "" when there is
    no file. Streams via .chunks() so a large document is never fully loaded into
    memory. Returns "" (not an error) if the file is missing from storage — a
    document that has been lost simply can't be attested to."""
    if not file_field:
        return ""
    digest = hashlib.sha256()
    try:
        file_field.open("rb")
        try:
            for chunk in file_field.chunks():
                digest.update(chunk)
        finally:
            file_field.close()
    except Exception:
        logger.warning("Could not hash file %r for anchoring", getattr(file_field, "name", "?"))
        return ""
    return "0x" + digest.hexdigest()


def _iso(value):
    """Stable ISO-8601 text for dates/datetimes (or "" for None), so a payload
    never depends on the local timezone rendering of a repr()."""
    if value is None:
        return ""
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)


# ── Canonical payloads (one per entity) ──────────────────────────────────────
# Only stable, business-meaningful fields go in. Adding a field here changes
# every future hash, so treat these as a versioned schema: `v` is bumped if the
# shape ever has to change, and old anchors stay verifiable against their own
# version (see _legacy_record_ok).
#
# v2 — removed the mutable lifecycle fields (project: status/deadline/
#      reviewed_at/published_at, bid: status/reviewed_at). They changed as a
#      procurement advanced, so re-hashing an earlier stage produced a different
#      value and verify_anchor branded untouched records as altered. A verifier
#      that cries tampering on every normal procurement is worse than no
#      verifier, so only fields that are final at anchor time are hashed now.
# v1 — original shape. Anchors written under it are still on-chain and are
#      verified by the compatibility path below, never re-hashed under v2 rules.
PAYLOAD_VERSION = 2


def project_payload(project, stage, document_hash=""):
    """What a procurement WAS at `stage`, as a hashable snapshot.

    Only fields that are already final when the anchor is taken belong here.
    `status`, `deadline`, `reviewed_at` and `published_at` were in v1 and had to
    come out: they keep changing as the procurement advances, so re-hashing an
    early stage later produced a different value and the verifier reported
    honest records as altered — every project that got past its first step lit
    up red. (See PAYLOAD_VERSION.)

    Nothing meaningful is lost. `stage` already says what the status was, the
    ordering and timing of the steps are proven by the anchors' own on-chain
    timestamps — which are far harder to forge than a database column — and the
    deadline that matters is the one bound into the AWARD stages.
    """
    return {
        "v": PAYLOAD_VERSION,
        "entity": "PROJECT",
        "stage": str(stage),
        "code": project.code,
        "name": project.name,
        "category": project.category or "",
        "type": project.type or "",
        "budget": f"{project.budget:.2f}",
        "bidding_period_days": project.bidding_period_days or 0,
        "delivery_period_days": project.delivery_period_days or 0,
        "created_at": _iso(project.created_at),
        "document_hash": document_hash,
    }


def bid_payload(bid, stage, document_hash=""):
    return {
        "v": PAYLOAD_VERSION,
        "entity": "BID",
        "stage": str(stage),
        "project_code": bid.project.code,
        "bid_id": bid.id,
        # The supplier is referenced by id only — the company name is personal /
        # commercial data and is not needed to prove the record is unaltered.
        "supplier_id": bid.supplier_id,
        "amount": f"{bid.amount:.2f}",
        "delivery_timeline": bid.delivery_timeline or "",
        "submitted_at": _iso(bid.submitted_at),
        # `status` and `reviewed_at` were dropped in v2 for the same reason as
        # the project's: they change after the anchor is taken (under_review →
        # qualified → winner), which made an honest bid verify as altered.
        "document_hash": document_hash,
    }


def award_payload(award, stage, document_hash="", issued_at=""):
    return {
        "v": PAYLOAD_VERSION,
        "entity": "AWARD",
        "stage": str(stage),
        "project_code": award.project.code,
        "award_id": award.id,
        "bid_id": award.bid_id or 0,
        "supplier_id": award.supplier_id,
        "amount": f"{award.amount:.2f}",
        "status": award.status,
        "awarded_at": _iso(award.awarded_at),
        # When this document was issued. Inside the hash on purpose: it is the
        # single field a backdated Notice to Proceed would have to change, and
        # changing it breaks the anchor.
        "issued_at": issued_at,
        "document_hash": document_hash,
    }


# ── Recording ────────────────────────────────────────────────────────────────
def record_anchor(entity_type, entity_ref, stage, payload, *, entity_id="", document_hash=""):
    """Create one BlockchainAnchor (tx_hash blank) and return it, or None.

    Never raises: a failure here must not turn a successful approval into an
    error, same contract as accounts.audit.log_action."""
    if not ANCHORING_ENABLED:
        return None
    try:
        anchor = BlockchainAnchor.objects.create(
            entity_type=entity_type,
            entity_ref=entity_ref,
            entity_id=str(entity_id or ""),
            stage=stage,
            data_hash=hash_payload(payload),
            document_hash=document_hash or "",
            payload=payload,
        )
    except Exception:  # pragma: no cover — anchoring must never break the request
        logger.exception("Failed to record blockchain anchor for %s/%s", entity_ref, stage)
        return None

    if SERVER_SIGNING_ENABLED:
        # Optional production path: sign and submit right here, so no wallet is
        # involved. Best-effort — a failure leaves the anchor un-anchored and
        # the frontend/retry path still works.
        submit_anchor_server_side(anchor)
    return anchor


# ── Payload builders, shared by anchoring AND verification ───────────────────
# Both paths MUST go through these. If verification rebuilt the payload with its
# own copy of this logic, the two would eventually drift and honest records would
# start reporting as tampered — the worst possible failure for this feature.
#
# `document_hash=None` means "read the file and hash it"; passing a hash instead
# reuses the one already recorded, which is how the cheap record-only check
# avoids touching storage.

def project_parts(project, stage, document_hash=None, document_field=None):
    field = document_field or STAGE_DOCUMENT_FIELD.get(stage, "")
    doc_hash = (
        document_hash if document_hash is not None
        else (hash_file(getattr(project, field, None)) if field else "")
    )
    return project_payload(project, stage, doc_hash), doc_hash


def bid_parts(bid, stage, document_hash=None, document_field=None):
    field = document_field or STAGE_DOCUMENT_FIELD.get(stage, "")
    doc_hash = (
        document_hash if document_hash is not None
        else (hash_file(getattr(bid, field, None)) if field else "")
    )
    return bid_payload(bid, stage, doc_hash), doc_hash


def award_parts(award, stage, document_hash=None):
    """AWARDED binds the winning bid's quotation (what was actually promised);
    the post-award stages each bind their own signed instrument on the Award,
    together with the date it was issued."""
    issued_at = ""
    if stage in AWARD_OWN_DOCUMENT_STAGES:
        field = STAGE_DOCUMENT_FIELD.get(stage, "")
        source = getattr(award, field, None) if field else None
        issued_field = AWARD_DOCUMENT_ISSUED_FIELDS.get(field)
        issued_at = _iso(getattr(award, issued_field, None)) if issued_field else ""
    else:
        source = getattr(award.bid, "quotation_document", None) if award.bid else None

    doc_hash = document_hash if document_hash is not None else hash_file(source)
    return award_payload(award, stage, doc_hash, issued_at), doc_hash


def anchor_project(project, stage, *, document_field=None):
    """Hash a project at `stage` (with its key document) and record the anchor."""
    payload, doc_hash = project_parts(project, stage, document_field=document_field)
    return record_anchor(
        BlockchainAnchor.EntityType.PROJECT, project.code, stage, payload,
        entity_id=project.id, document_hash=doc_hash,
    )


def anchor_bid(bid, stage, *, document_field=None):
    """Hash a bid at `stage` (with its quotation document) and record the anchor.

    entity_ref is the PROJECT code, not the bid id — the contract indexes by
    procurement code so one lookup returns the whole lifecycle."""
    payload, doc_hash = bid_parts(bid, stage, document_field=document_field)
    return record_anchor(
        BlockchainAnchor.EntityType.BID, bid.project.code, stage, payload,
        entity_id=bid.id, document_hash=doc_hash,
    )


def anchor_award(award, stage=BlockchainAnchor.Stage.AWARDED):
    """Hash the award at `stage` together with the document that governs it, and
    record the anchor."""
    payload, doc_hash = award_parts(award, stage)
    return record_anchor(
        BlockchainAnchor.EntityType.AWARD, award.project.code, stage, payload,
        entity_id=award.id, document_hash=doc_hash,
    )


# ── Integrity re-check: does the LIVE record still match what was anchored? ──
#
# Comparing a stored data_hash with the one on-chain only proves the anchor row
# wasn't touched. It says nothing about the record the hash was taken FROM. This
# is what closes that gap: rebuild the payload from the record as it stands right
# now and see whether it still hashes to the value published on the blockchain.
#
# Two separate checks, because they cost very different amounts:
#   RECORD   — rebuild the payload reusing the recorded document_hash. Catches an
#              edited budget, amount, status or date. No file I/O.
#   DOCUMENT — re-read the file from storage and hash it. Catches a document
#              swapped after the fact. Costs a full read per anchor, so it's
#              opt-in ("deep") rather than run on every page load.

MATCH = "match"
MISMATCH = "mismatch"
UNAVAILABLE = "unavailable"   # record or file is gone — reported, never guessed at
SKIPPED = "skipped"


def live_record(anchor):
    """The row this anchor was taken from, as it stands now (None if deleted)."""
    from .models import Award, Bid, Project  # noqa: PLC0415 — kept local; only verification needs these

    if not anchor.entity_id:
        return None
    model = {
        BlockchainAnchor.EntityType.PROJECT: Project,
        BlockchainAnchor.EntityType.BID: Bid,
        BlockchainAnchor.EntityType.AWARD: Award,
    }.get(anchor.entity_type)
    if model is None:
        return None
    return model.objects.filter(pk=anchor.entity_id).first()


def rebuild_payload(anchor, record, document_hash=None):
    """Re-derive this anchor's payload from `record`, through the SAME builders
    the anchoring path uses."""
    if anchor.entity_type == BlockchainAnchor.EntityType.PROJECT:
        return project_parts(record, anchor.stage, document_hash)
    if anchor.entity_type == BlockchainAnchor.EntityType.BID:
        return bid_parts(record, anchor.stage, document_hash)
    return award_parts(record, anchor.stage, document_hash)


def _legacy_record_ok(anchor, rebuilt):
    """Record check for anchors written before PAYLOAD_VERSION 2.

    Their hash covered fields that have since legitimately changed, so it can
    never be reproduced from the live record — re-hashing under v2 rules would
    fail every one of them. Verified in two steps instead, which is weaker only
    in that it cannot prove the retired fields are untouched:

      1. The stored snapshot must itself hash to the value that went on-chain.
         That is what rules out someone editing the anchor row after the fact —
         data_hash is public on Sepolia and cannot be edited to match.
      2. Every field v2 still hashes must equal what that snapshot recorded, so
         an edited budget, name or document is caught exactly as it is today.
    """
    stored = anchor.payload or {}
    if not stored or hash_payload(stored) != anchor.data_hash:
        return False
    # v2's keys are a subset of v1's apart from "v" itself, which is expected to
    # differ — comparing it would fail every legacy anchor by construction.
    return all(value == stored.get(key) for key, value in rebuilt.items() if key != "v")


def verify_anchor(anchor, deep=False):
    """Check the live record against what was anchored.

    Returns {status, record, document, detail}. `status` is the worst of the two
    checks, so a caller can act on one field. Never raises — a verifier that
    crashes on odd data is worse than one that reports "unavailable"."""
    result = {"status": UNAVAILABLE, "record": UNAVAILABLE, "document": SKIPPED, "detail": ""}
    try:
        record = live_record(anchor)
        if record is None:
            result["detail"] = "The record this anchor was taken from no longer exists."
            return result

        # ── Record check ──────────────────────────────────────────────────
        payload, _ = rebuild_payload(anchor, record, document_hash=anchor.document_hash)
        if (anchor.payload or {}).get("v", 1) < PAYLOAD_VERSION:
            record_ok = _legacy_record_ok(anchor, payload)
        else:
            record_ok = hash_payload(payload) == anchor.data_hash
        result["record"] = MATCH if record_ok else MISMATCH
        if not record_ok:
            result["detail"] = "This record has been altered since it was recorded on-chain."

        # ── Document check (opt-in) ───────────────────────────────────────
        if deep and anchor.document_hash:
            _, current_doc_hash = rebuild_payload(anchor, record, document_hash=None)
            if not current_doc_hash:
                result["document"] = UNAVAILABLE
                result["detail"] = result["detail"] or "The anchored document is missing from storage."
            elif current_doc_hash == anchor.document_hash:
                result["document"] = MATCH
            else:
                result["document"] = MISMATCH
                result["detail"] = "The attached document has been replaced since it was recorded."

        checks = [result["record"]] + ([result["document"]] if result["document"] != SKIPPED else [])
        if MISMATCH in checks:
            result["status"] = MISMATCH
        elif UNAVAILABLE in checks:
            result["status"] = UNAVAILABLE
        else:
            result["status"] = MATCH
        return result
    except Exception:  # pragma: no cover — a verifier must never 500 a page
        logger.exception("Integrity check failed for anchor %s", getattr(anchor, "id", "?"))
        result["detail"] = "This record could not be checked."
        return result


def attach_transaction(anchor, tx_hash, block_number=None, actor_address=""):
    """Record the confirmed on-chain transaction for an anchor.

    Returns the updated anchor. Raises ValueError on a malformed tx hash — this
    one DOES raise, because it runs from an explicit "here is my transaction"
    request whose caller wants to know it was rejected."""
    tx_hash = (tx_hash or "").strip()
    if not _is_hex32(tx_hash):
        raise ValueError("tx_hash must be a 0x-prefixed 32-byte hex string.")
    anchor.tx_hash = tx_hash
    anchor.block_number = int(block_number) if str(block_number or "").strip().isdigit() else None
    anchor.actor_address = (actor_address or "").strip()[:42]
    anchor.anchored_at = timezone.now()
    anchor.save(update_fields=["tx_hash", "block_number", "actor_address", "anchored_at"])
    return anchor


def _is_hex32(value):
    return (
        isinstance(value, str)
        and len(value) == 66
        and value.startswith("0x")
        and all(c in "0123456789abcdefABCDEF" for c in value[2:])
    )


def anchor_summary(anchor, *, include_payload=False):
    """API shape for one anchor. `attach_url` lets the frontend post its tx hash
    back without having to know which entity kind it is holding."""
    if anchor is None:
        return None
    data = {
        "id": anchor.id,
        "entity_type": anchor.entity_type,
        "entity_ref": anchor.entity_ref,
        "entity_id": anchor.entity_id,
        "stage": anchor.stage,
        "stage_label": anchor.get_stage_display(),
        "data_hash": anchor.data_hash,
        "document_hash": anchor.document_hash,
        "tx_hash": anchor.tx_hash,
        "block_number": anchor.block_number,
        "actor_address": anchor.actor_address,
        "anchored": anchor.anchored,
        "explorer_url": (ETHERSCAN_TX_URL + anchor.tx_hash) if anchor.tx_hash else "",
        "created_at": anchor.created_at,
        "attach_url": attach_url_for(anchor),
        # Tells the browser to ask the server to sign a retry ("Anchor now")
        # instead of opening MetaMask.
        "server_signing": SERVER_SIGNING_ENABLED,
    }
    if include_payload:
        data["payload"] = anchor.payload
    return data


def _resolve(record, path):
    """getattr() along a dotted path ("project.code"), None if anything is unset."""
    value = record
    for part in path.split("."):
        value = getattr(value, part, None)
        if value is None:
            return None
    return value


def attach_anchors(records, ref_attr="code", entity_type=None, id_attr=None):
    """Bulk-load anchors onto a list of records as `_anchors`, in ONE query.

    Called from the list endpoints so serializing 50 projects doesn't fire 50
    anchor queries. Without it the serializer falls back to querying per object.

    With no entity_type, a project gets its FULL trail (its own anchors plus its
    bids' and its award's) — which is exactly what the "3 of 5 anchored" badge on
    a procurement should count."""
    records = list(records)
    if not records:
        return records
    refs = {ref for ref in (_resolve(r, ref_attr) for r in records) if ref}
    qs = BlockchainAnchor.objects.filter(entity_ref__in=refs)
    if entity_type:
        qs = qs.filter(entity_type=entity_type)

    grouped = {}
    for anchor in qs:
        key = (anchor.entity_ref, anchor.entity_id) if id_attr else anchor.entity_ref
        grouped.setdefault(key, []).append(anchor)

    for record in records:
        ref = _resolve(record, ref_attr)
        key = (ref, str(_resolve(record, id_attr))) if id_attr else ref
        record._anchors = grouped.get(key, [])
    return records


def anchors_for(entity_ref, entity_type=None, entity_id=None):
    """Query one record's anchors (fallback when attach_anchors wasn't used)."""
    qs = BlockchainAnchor.objects.filter(entity_ref=entity_ref)
    if entity_type:
        qs = qs.filter(entity_type=entity_type)
    if entity_id is not None:
        qs = qs.filter(entity_id=str(entity_id))
    return list(qs)


def attach_url_for(anchor):
    """Endpoint the frontend posts the confirmed tx hash to. Bid and award
    anchors both hang off endpoints the acting role already has access to."""
    if anchor.entity_type == BlockchainAnchor.EntityType.PROJECT and anchor.entity_id:
        return f"/projects/{anchor.entity_id}/anchor/"
    if anchor.entity_type == BlockchainAnchor.EntityType.BID and anchor.entity_id:
        return f"/bids/{anchor.entity_id}/anchor/"
    if anchor.entity_type == BlockchainAnchor.EntityType.AWARD and anchor.entity_id:
        return f"/awards/{anchor.entity_id}/anchor/"
    return ""


# ── Stretch goal: server-side signing with web3.py ───────────────────────────
def _load_web3():
    """Import web3 lazily so it stays an optional dependency: the MetaMask demo
    path must work on a machine where web3.py was never installed."""
    try:
        from web3 import Web3  # noqa: PLC0415 — optional dependency, imported on demand
    except ImportError:
        logger.warning(
            "BLOCKCHAIN_SERVER_SIGNING is on but web3.py is not installed "
            "(pip install web3). Anchors will stay un-anchored."
        )
        return None
    return Web3


def _ledger_abi():
    """The contract ABI, read from contracts/ProcurementLedger.abi.json at the
    repo root — one copy, shared with the frontend, never duplicated here."""
    from django.conf import settings  # noqa: PLC0415 — avoid an import cycle at module load

    path = os.path.join(os.path.dirname(settings.BASE_DIR), "contracts", "ProcurementLedger.abi.json")
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


# Margin on top of the node's gas estimate: the estimate is exact for the
# current chain state, and a little headroom covers the trail growing between
# estimating and mining. Unused gas is refunded, so this costs nothing extra.
GAS_HEADROOM = 1.25


def _fee_fields(w3):
    """EIP-1559 fee fields that are always valid together.

    The old version paired a fixed 1.5 gwei tip with `gas_price * 2` as the
    cap. Sepolia's gas price often sits well under 0.75 gwei, which made the
    cap lower than the tip, and the node rejected every transaction with
    "max priority fee per gas higher than max fee per gas". Building the cap
    as `2 x base fee + tip` keeps it above the tip whatever the network does,
    and leaves room for the base fee to rise for a block or two."""
    try:
        tip = int(w3.eth.max_priority_fee)       # the node's suggested tip
    except Exception:
        tip = int(w3.to_wei(1, "gwei"))
    block = w3.eth.get_block("latest")
    base_fee = int(block.get("baseFeePerGas") or 0) or int(w3.eth.gas_price)
    return {"maxPriorityFeePerGas": tip, "maxFeePerGas": base_fee * 2 + tip}


def submit_anchor_server_side(anchor):
    """Sign and submit `anchor` from the server with web3.py (no wallet).

    Enabled with BLOCKCHAIN_SERVER_SIGNING=True plus BLOCKCHAIN_PRIVATE_KEY and
    LEDGER_CONTRACT_ADDRESS in the environment. Best-effort by design: any
    failure (no funds, RPC down, package missing) just leaves the anchor
    un-anchored and retryable, exactly like a declined MetaMask prompt.

    Deliberately does NOT wait for the transaction to be mined. This runs inside
    the request that approved/published/awarded something, and a Sepolia block
    takes ~12-30s — longer than gunicorn's 30s worker timeout, so waiting would
    get the worker killed and turn a successful approval into a 502. Broadcasting
    is enough: the transaction is signed, accepted by the network and final in
    the next block or two, and its hash is what proves the anchor. The trade-off
    is that `block_number` stays NULL until confirm_anchor() reads the receipt
    (the `confirm_anchors` command runs on every deploy). Until then the record
    has been SENT but not yet CONFIRMED — and a transaction that later fails
    on-chain is cleared there, so it can never keep showing as anchored.

    Returns the updated anchor, or None if nothing was submitted."""
    if not (SERVER_SIGNING_ENABLED and BLOCKCHAIN_PRIVATE_KEY and LEDGER_CONTRACT_ADDRESS):
        if SERVER_SIGNING_ENABLED:
            logger.warning(
                "Server-side anchoring is on but BLOCKCHAIN_PRIVATE_KEY / "
                "LEDGER_CONTRACT_ADDRESS are not both set."
            )
        return None

    Web3 = _load_web3()
    if Web3 is None:
        return None

    try:
        w3 = Web3(Web3.HTTPProvider(SEPOLIA_RPC_URL))
        account = w3.eth.account.from_key(BLOCKCHAIN_PRIVATE_KEY)
        ledger = w3.eth.contract(
            address=Web3.to_checksum_address(LEDGER_CONTRACT_ADDRESS), abi=_ledger_abi(),
        )
        call = ledger.functions.recordEvent(
            anchor.entity_type, anchor.entity_ref, anchor.stage, anchor.data_hash,
        )
        # Ask the node what this call really costs instead of guessing. Storing
        # the strings on-chain takes ~1.17M gas; the old fixed 400k limit ran
        # every transaction out of gas, so it reverted on-chain while the app
        # still showed "On-chain". estimate_gas also raises if the call would
        # revert, which leaves the anchor un-anchored and retryable instead.
        gas = int(call.estimate_gas({"from": account.address}) * GAS_HEADROOM)
        tx = call.build_transaction({
            "from": account.address,
            # "pending", not the default "latest": awarding issues three
            # documents (BAC Resolution, NOA, NTP) back to back, so the earlier
            # transactions are still unmined when the next nonce is read. Off
            # "latest" all three would claim the same nonce and two would be
            # rejected as duplicates.
            "nonce": w3.eth.get_transaction_count(account.address, "pending"),
            "chainId": SEPOLIA_CHAIN_ID,
            "gas": gas,
            **_fee_fields(w3),
        })
        signed = account.sign_transaction(tx)
        # web3.py v6 exposes .rawTransaction, v7 renamed it to .raw_transaction.
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        tx_hash = w3.eth.send_raw_transaction(raw)
        # Web3.to_hex, not tx_hash.hex(): hexbytes >= 1.0 (what web3 v7 pins)
        # dropped the "0x" prefix from .hex(), which attach_transaction rejects.
        # to_hex is prefixed on every version.
        return attach_transaction(
            anchor, Web3.to_hex(tx_hash), actor_address=account.address,
        )
    except Exception:  # pragma: no cover — never break the request
        logger.exception("Server-side anchoring failed for anchor %s", anchor.id)
        return None


# ── Confirmation: did a sent transaction actually succeed? ───────────────────
# Server-signed anchors are recorded as soon as the transaction is broadcast,
# because waiting for a block would outlast gunicorn's worker timeout (see
# submit_anchor_server_side). That leaves a gap: a transaction can be sent and
# still fail on-chain (out of gas, contract rejects it) or be dropped by the
# network. confirm_anchor() closes that gap by reading the receipt afterwards.

CONFIRMED = "confirmed"   # mined and succeeded — block number saved
REVERTED = "reverted"     # mined but failed — cleared so it can be retried
DROPPED = "dropped"       # the network never mined it — cleared likewise
PENDING = "pending"       # not mined yet — check again later
UNKNOWN = "unknown"       # the node couldn't be asked — check again later

# A transaction the node has never heard of is only treated as dropped after
# this long. A freshly broadcast one can take a moment to show up everywhere.
DROPPED_AFTER = timedelta(hours=1)


def web3_client():
    """A read-only Sepolia connection, or None when web3.py isn't installed."""
    Web3 = _load_web3()
    if Web3 is None:
        return None
    return Web3(Web3.HTTPProvider(SEPOLIA_RPC_URL))


def _not_found(exc):
    # web3.exceptions.TransactionNotFound, matched by name so web3 stays an
    # optional import and tests don't need the real package.
    return exc.__class__.__name__ == "TransactionNotFound"


def confirm_anchor(anchor, *, w3, apply=True):
    """Check one sent anchor against the chain and record what really happened.

    Only meaningful for an anchor that has a tx_hash but no block_number yet.
    Returns one of CONFIRMED / REVERTED / DROPPED / PENDING / UNKNOWN. With
    apply=False nothing is saved, so the caller can preview the changes.

    A failed or dropped transaction is CLEARED rather than deleted: the anchor
    row (and the business record) stays, it simply reads as "not yet anchored"
    again and can be retried. The failed hash is kept in the audit log, so the
    history of what was attempted is never lost. Never raises."""
    tx_hash = anchor.tx_hash
    if not tx_hash or anchor.block_number is not None:
        return CONFIRMED if tx_hash else PENDING
    try:
        try:
            receipt = w3.eth.get_transaction_receipt(tx_hash)
        except Exception as exc:  # noqa: BLE001 — see _not_found
            if not _not_found(exc):
                raise
            receipt = None

        if receipt is not None:
            if int(receipt["status"]) == 1:
                if apply:
                    anchor.block_number = int(receipt["blockNumber"])
                    anchor.save(update_fields=["block_number"])
                return CONFIRMED
            outcome = REVERTED
        else:
            try:
                w3.eth.get_transaction(tx_hash)
                return PENDING            # known to the network, not mined yet
            except Exception as exc:  # noqa: BLE001
                if not _not_found(exc):
                    raise
            sent_at = anchor.anchored_at or anchor.created_at
            if sent_at and timezone.now() - sent_at < DROPPED_AFTER:
                return PENDING
            outcome = DROPPED

        if apply:
            _clear_failed_transaction(anchor, outcome)
        return outcome
    except Exception:  # noqa: BLE001 — a confirmation pass must never break anything
        logger.warning("Could not confirm anchor %s (tx %s)", anchor.id, tx_hash, exc_info=True)
        return UNKNOWN


def _clear_failed_transaction(anchor, outcome):
    """Undo a transaction that never made it on-chain, and say so in the audit log."""
    from accounts.audit import log_action  # noqa: PLC0415 — avoid an import cycle

    failed_hash = anchor.tx_hash
    anchor.tx_hash = ""
    anchor.block_number = None
    anchor.actor_address = ""
    anchor.anchored_at = None
    anchor.save(update_fields=["tx_hash", "block_number", "actor_address", "anchored_at"])
    reason = "failed on-chain" if outcome == REVERTED else "was never mined"
    log_action(
        None, f"blockchain.{outcome}",
        entity_type=anchor.entity_type, entity_id=anchor.entity_id,
        description=(
            f"{anchor.entity_ref} {anchor.stage}: transaction {failed_hash} {reason}; "
            "cleared so the record can be anchored again."
        ),
    )


def read_chain_anchors(entity_ref):
    """Read a procurement's trail straight from the contract (server-side, no
    wallet). Used by the public verification endpoint as a fallback for browsers
    that can't reach an RPC endpoint. Returns [] when unavailable rather than
    raising — the DB view of the trail is always shown regardless."""
    if not LEDGER_CONTRACT_ADDRESS:
        return []
    Web3 = _load_web3()
    if Web3 is None:
        return []
    try:
        w3 = Web3(Web3.HTTPProvider(SEPOLIA_RPC_URL))
        ledger = w3.eth.contract(
            address=Web3.to_checksum_address(LEDGER_CONTRACT_ADDRESS), abi=_ledger_abi(),
        )
        rows = ledger.functions.getAnchorsByRef(entity_ref).call()
        return [
            {
                "entity_type": r[0], "entity_ref": r[1], "stage": r[2],
                "data_hash": r[3], "actor": r[4], "timestamp": r[5],
            }
            for r in rows
        ]
    except Exception:
        logger.warning("Could not read on-chain anchors for %s", entity_ref, exc_info=True)
        return []
