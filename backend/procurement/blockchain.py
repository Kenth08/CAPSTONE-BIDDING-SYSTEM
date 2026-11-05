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
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone

from django.core.exceptions import ImproperlyConfigured
from django.utils import timezone

from . import document_evidence, payload_v2, payload_v3, payload_v3_reader
from .canonical import hash_payload  # noqa: F401 — re-exported: `from .blockchain import hash_payload`
from .models import AWARD_DOCUMENT_ISSUED_FIELDS, BlockchainAnchor
from .openings import commitment_key_problems
from .project_documents import document_manifest

logger = logging.getLogger(__name__)

# Anchoring can be turned off entirely (e.g. in CI) without touching any view.
ANCHORING_ENABLED = os.environ.get("BLOCKCHAIN_ANCHORING_ENABLED", "True").lower() == "true"

# Server-side signing (stretch goal): when true, the backend submits the
# transaction itself with web3.py instead of waiting for a MetaMask signature.
# Off by default — MetaMask is the demo path.
SERVER_SIGNING_ENABLED = os.environ.get("BLOCKCHAIN_SERVER_SIGNING", "False").lower() == "true"

# Read-only switch for the whole "write it on-chain" step. When False, the
# /anchor/ endpoints refuse every write — a MetaMask tx hash AND a server_submit
# — and each anchor tells the browser `signing_enabled: false`, so no "Anchor
# now" button ever opens a wallet. Anchors are still computed and stored, and
# reading/verifying the chain still works. Default True: production unchanged.
# Turning off BLOCKCHAIN_SERVER_SIGNING alone is NOT enough for a read-only
# deployment — that only stops the server's wallet, not the browser's.
def _env_flag(name, default):
    """True/False environment switch; anything but "true" (any case) is False."""
    return os.environ.get(name, default).strip().lower() == "true"


WALLET_SIGNING_ENABLED = _env_flag("BLOCKCHAIN_WALLET_SIGNING", "True")
SIGNING_DISABLED_DETAIL = (
    "Blockchain signing is disabled on this deployment (read-only). "
    "The record is saved, but it cannot be anchored here."
)

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
# hash_payload (the canonical JSON encoding, identical for every payload
# version) lives in canonical.py and is imported above, so the frozen
# per-version builders can use it too.

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


# ── Payload versions ─────────────────────────────────────────────────────────
# Only stable, business-meaningful fields go into a payload. Adding a field
# changes every future hash, so payloads are a versioned schema: each version's
# builders live in their own FROZEN module (payload_v2, …) and every anchor is
# verified with the builders of ITS OWN version — the `v` stored in its payload —
# never with whatever version is written today.
#
# That is the point of PAYLOAD_RULES. Before it, verification rebuilt every
# anchor with the CURRENT builders and picked the legacy path with
# `v < PAYLOAD_VERSION`. Introducing new builders would then have rebuilt every
# existing v2 anchor in the new shape and reported honest records as altered.
#
#   v2 — current. Exact check: the rebuilt payload must hash to data_hash.
#   v1 — original shape, still on Sepolia. Checked by _legacy_record_ok against
#        the fields the v2 builders still produce (see payload_v2's history).
#
# A payload whose `v` is not an integer with rules here is never guessed at:
# verify_anchor reports it as UNAVAILABLE ("unsupported payload version"),
# not as altered.

class PayloadRules:
    """How anchors of one payload version are rebuilt and compared.

    `builders` is the frozen module for the shape (project_payload, bid_payload,
    award_payload, evaluation_payload, bid_leaf_fields, iso, REISSUE_KEYS).
    `legacy` = the stored snapshot is checked field-by-field against what the
    builders produce, because the builders no longer produce its exact shape.
    `reader` = this version has its own verify(anchor, record, deep=) instead."""

    __slots__ = ("version", "builders", "legacy", "reader")

    def __init__(self, version, builders, *, legacy=False, reader=None):
        self.version = version
        self.builders = builders
        self.legacy = legacy
        self.reader = reader

    def __repr__(self):
        return f"PayloadRules(v{self.version}{', legacy' if self.legacy else ''})"


PAYLOAD_RULES = {
    1: PayloadRules(1, payload_v2, legacy=True),
    2: PayloadRules(2, payload_v2),
}

# The version NEW anchors are written in. Changing it is a release decision of
# its own (it must have rules above, and old versions keep theirs).
PAYLOAD_VERSION = 2


def check_writer_version(version, rules):
    """Refuse to run with a writer version that has no rules: every anchor it
    wrote would be unverifiable. An explicit raise, not an `assert`, so it still
    runs under `python -O` (which strips asserts)."""
    if version not in rules:
        raise ImproperlyConfigured(
            f"PAYLOAD_VERSION = {version!r} has no entry in PAYLOAD_RULES "
            f"(supported: {sorted(rules)}). Register its rules before writing anchors in it."
        )


check_writer_version(PAYLOAD_VERSION, PAYLOAD_RULES)

# Versions this server can verify but must never write. Kept out of PAYLOAD_RULES
# on purpose: check_writer_version still refuses PAYLOAD_VERSION = 3, so being able
# to READ v3 opens no path to writing it.
READ_ONLY_RULES = {
    3: PayloadRules(3, payload_v3, reader=payload_v3_reader.verify),
}

# Writes project-stage/3 anchors instead of v2 when on (anchor_project). Off, and
# refused at start-up while its release gates are open (SECURITY.md, "Open gaps").
# Verifying v3 does not depend on it: see READ_ONLY_RULES.
PAYLOAD_V3_ENABLED = _env_flag("PAYLOAD_V3_ENABLED", "False")


def check_v3_gate(enabled):
    """Refuse to start with v3 writing on. Run from ProcurementConfig.ready(), so
    it fires at process start and on `migrate`, not at the first request. A valid
    COMMITMENT_KEY does not lift the refusal; its absence is reported as well."""
    if enabled:
        raise ImproperlyConfigured(" ".join([
            "PAYLOAD_V3_ENABLED is on, but v3 writing is not available yet: its release "
            "gates are open, and an anchor written now could not be corrected. Unset it.",
            *commitment_key_problems(),
        ]))


class UnsupportedPayload(Exception):
    """An anchor's payload version has no rules on this server."""


def current_rules():
    """Rules for anchors written now. Read at call time, so the version can be
    switched in one place (and in tests)."""
    return PAYLOAD_RULES[PAYLOAD_VERSION]


def payload_rules(anchor):
    """The rules for THIS anchor, chosen by the `v` in its own stored payload.

    No payload, or a payload without `v`, is version 1 (as it always was). A
    stored payload that is not a JSON object, a `v` that is not a plain integer,
    or an integer without rules here, raises UnsupportedPayload — it is never
    coerced, treated as another version, or reported as altered."""
    stored = anchor.payload
    if stored and not isinstance(stored, dict):
        kind = {list: "an array", str: "a string", bool: "a boolean"}.get(type(stored), "a number")
        raise UnsupportedPayload(f"a malformed payload ({kind}, not a JSON object)")
    payload = stored if isinstance(stored, dict) else {}
    if "v" not in payload:
        return PAYLOAD_RULES[1]
    version = payload["v"]
    if type(version) is not int:  # noqa: E721 — bool and float must not pass
        raise UnsupportedPayload(f"a malformed payload version ({version!r})")
    rules = PAYLOAD_RULES.get(version) or READ_ONLY_RULES.get(version)
    if rules is None:
        raise UnsupportedPayload(f"payload version {version}, which this server has no rules for")
    return rules


# The builders written today, under their historical names (callers and tests
# import these from here). They are the v2 builders: see payload_v2.
project_payload = payload_v2.project_payload
bid_payload = payload_v2.bid_payload
award_payload = payload_v2.award_payload


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

    if SERVER_SIGNING_ENABLED and WALLET_SIGNING_ENABLED:
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
#
# `rules=None` means the version written today (anchoring); verification passes
# the anchor's own rules (payload_rules), so an old anchor is rebuilt in the
# shape it was hashed in.

def project_parts(project, stage, document_hash=None, document_field=None, rules=None):
    builders = (rules or current_rules()).builders
    field = document_field or STAGE_DOCUMENT_FIELD.get(stage, "")
    doc_hash = (
        document_hash if document_hash is not None
        else (hash_file(getattr(project, field, None)) if field else "")
    )
    return builders.project_payload(project, stage, doc_hash), doc_hash


def bid_parts(bid, stage, document_hash=None, document_field=None, rules=None):
    builders = (rules or current_rules()).builders
    field = document_field or STAGE_DOCUMENT_FIELD.get(stage, "")
    doc_hash = (
        document_hash if document_hash is not None
        else (hash_file(getattr(bid, field, None)) if field else "")
    )
    return builders.bid_payload(bid, stage, doc_hash), doc_hash


def award_parts(award, stage, document_hash=None, rules=None):
    """AWARDED binds the winning bid's quotation (what was actually promised);
    the post-award stages each bind their own signed instrument on the Award,
    together with the date it was issued."""
    builders = (rules or current_rules()).builders
    issued_at = ""
    if stage in AWARD_OWN_DOCUMENT_STAGES:
        field = STAGE_DOCUMENT_FIELD.get(stage, "")
        source = getattr(award, field, None) if field else None
        issued_field = AWARD_DOCUMENT_ISSUED_FIELDS.get(field)
        issued_at = builders.iso(getattr(award, issued_field, None)) if issued_field else ""
    else:
        source = getattr(award.bid, "quotation_document", None) if award.bid else None

    doc_hash = document_hash if document_hash is not None else hash_file(source)
    return builders.award_payload(award, stage, doc_hash, issued_at), doc_hash


def anchor_project(project, stage, *, document_field=None):
    """Hash a project at `stage` (with its key document) and record the anchor."""
    if PAYLOAD_V3_ENABLED:
        return _anchor_project_v3(project, stage)
    payload, doc_hash = project_parts(project, stage, document_field=document_field)
    return record_anchor(
        BlockchainAnchor.EntityType.PROJECT, project.code, stage, payload,
        entity_id=project.id, document_hash=doc_hash,
    )


def _anchor_project_v3(project, stage):
    """project-stage/3: the stage with all five documents. Never raises."""
    if not ANCHORING_ENABLED:
        return None
    try:
        payload = payload_v3.project_payload(project, stage, document_manifest(project))
    except Exception:  # noqa: BLE001 — anchoring must never break the request
        logger.exception("Failed to build the v3 payload for %s/%s", project.code, stage)
        return None
    return record_anchor(
        BlockchainAnchor.EntityType.PROJECT, project.code, stage, payload,
        entity_id=project.id, document_hash=payload["document_hash"],
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


# ── Evaluation commitment (EVALUATION_COMPLETED) ─────────────────────────────
# Bids are deliberately not anchored one by one (that would publish a
# fingerprint of every losing offer), and qualify/disqualify isn't either. What
# the chain CAN usefully prove is that, at the moment of award, the set of bids
# received and their outcomes were fixed — so a bid can't be slipped in,
# dropped, re-priced or re-graded afterwards. One anchor at award time does
# that:
#
#   leaf(bid) = SHA-256 of {bid_id, supplier_id, amount, submitted_at,
#                           document_hash (the quotation file), status, salt}
#   payload   = {v, entity, stage, code, bid_count, leaves: [leaf, ...]}  (by bid id)
#
# The 256-bit random salt is what keeps this private: without it a leaf — and so
# the public data_hash — could be brute-forced back to an amount (the ABC
# bounds the search). The salt and the committed document hash are stored on
# the Bid, never published; a bidder gets their own as an inclusion receipt.
#
# A new payload shape for a NEW stage: no existing payload changes, so
# PAYLOAD_VERSION stays as it is.

EVALUATION_STAGE = BlockchainAnchor.Stage.EVALUATION_COMPLETED


# The leaf and payload shapes are part of the payload version (payload_v2).
# These names are the version written today, kept for callers and tests.
bid_leaf_fields = payload_v2.bid_leaf_fields
bid_leaf = payload_v2.bid_leaf


def evaluation_payload(project, bids, rules=None):
    return (rules or current_rules()).builders.evaluation_payload(project, bids, EVALUATION_STAGE)


def _commit_bids(bids):
    """Give every bid its salt and quotation hash, once. A bid that already has
    a salt keeps it (and its hash), so this can never rewrite a commitment."""
    import secrets  # noqa: PLC0415 — only needed here

    from .models import Bid  # noqa: PLC0415

    for bid in bids:
        if bid.commitment_salt:
            continue
        bid.commitment_salt = secrets.token_hex(32)
        bid.committed_document_hash = hash_file(bid.quotation_document)
        Bid.objects.filter(pk=bid.pk, commitment_salt="").update(
            commitment_salt=bid.commitment_salt, committed_document_hash=bid.committed_document_hash)


def anchor_evaluation(project):
    """Commit to every bid on `project` and its outcome, and record the anchor.

    Called by select_winner after the award has committed, so the statuses are
    final (winner / qualified / disqualified / under_review). Never raises."""
    if not ANCHORING_ENABLED:
        return None
    try:
        bids = list(project.bids.all())
        _commit_bids(bids)
        payload = evaluation_payload(project, bids)
    except Exception:  # pragma: no cover — anchoring must never break the request
        logger.exception("Failed to build the evaluation commitment for %s", project.code)
        return None
    return record_anchor(
        BlockchainAnchor.EntityType.PROJECT, project.code, EVALUATION_STAGE, payload,
        entity_id=project.id, document_hash="",
    )


def evaluation_documents_check(project):
    """Deep check for the commitment: does every bid's quotation file still hash
    to what was committed? MATCH / MISMATCH / UNAVAILABLE."""
    worst = MATCH
    for bid in project.bids.all():
        if not bid.committed_document_hash:
            continue
        current = hash_file(bid.quotation_document)
        if not current:
            worst = UNAVAILABLE if worst == MATCH else worst
        elif current != bid.committed_document_hash:
            return MISMATCH
    return worst


def inclusion_receipt(bid):
    """What a bidder needs to check, on their own, that THEIR bid is inside the
    procurement's EVALUATION_COMPLETED anchor: their leaf inputs (incl. salt),
    the full list of (opaque, salted) leaves and the anchored hash. Nothing in
    it reveals another bidder's amount, identity or outcome. None when the
    procurement has no commitment."""
    anchor = (BlockchainAnchor.objects
              .filter(entity_ref=bid.project.code, stage=EVALUATION_STAGE)
              .order_by("-id").first())
    if anchor is None or not bid.commitment_salt:
        return None
    try:
        rules = payload_rules(anchor)
    except UnsupportedPayload:
        return None   # no rules for that version here: no receipt rather than a wrong one
    if rules.reader is not None:
        return None   # a v3 leaf is an opening, and no route serves openings yet
    fields = rules.builders.bid_leaf_fields(bid)
    return {
        "leaf_fields": fields,
        "leaf": hash_payload(fields),
        "payload": anchor.payload,          # {v, entity, stage, code, bid_count, leaves}
        "anchor": anchor_summary(anchor),
        "how_to_verify": (
            "1) SHA-256 of leaf_fields serialized as JSON with sorted keys and no spaces "
            "equals `leaf`. 2) `leaf` appears in payload.leaves. 3) SHA-256 of payload, "
            "serialized the same way, equals anchor.data_hash. 4) That data_hash is in the "
            "AnchorRecorded event of anchor.tx_hash on Sepolia."
        ),
    }


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
# An award document that was legitimately issued again (generated draft →
# signed copy). The newer anchor is the live one; the older one can no longer
# be rebuilt from the record because the file and its issue date moved on.
SUPERSEDED = "superseded"

# Which payload keys a re-issue is EXPECTED to change is part of each payload
# version (REISSUE_KEYS in payload_v2, …). Everything else in an award payload
# (amount, winner, bid, award date…) must still be unchanged.


def superseding_anchor(anchor):
    """The newer anchor that replaced this award-document anchor, or None.

    Only the post-award documents can be re-issued (AwardViewSet._issue_document
    appends a new anchor every time), so every other anchor returns None."""
    if (anchor.entity_type != BlockchainAnchor.EntityType.AWARD
            or anchor.stage not in AWARD_OWN_DOCUMENT_STAGES or not anchor.entity_id):
        return None
    return (BlockchainAnchor.objects
            .filter(entity_type=anchor.entity_type, entity_id=anchor.entity_id,
                    stage=anchor.stage, id__gt=anchor.id)
            .order_by("id").first())


def _superseded_record_ok(anchor, rebuilt, rules):
    """Record check for a superseded award-document anchor.

    Same two steps as the legacy path: the stored snapshot must still hash to
    what went on-chain (so the anchor row itself is untouched), and every field
    a re-issue does NOT change must equal the live record — so an edited award
    amount or winner is still caught on the old anchor too."""
    stored = anchor.payload or {}
    if not stored or hash_payload(stored) != anchor.data_hash:
        return False
    reissue_keys = rules.builders.REISSUE_KEYS
    return all(value == stored.get(key) for key, value in rebuilt.items() if key not in reissue_keys)


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


def rebuild_payload(anchor, record, document_hash=None, rules=None):
    """Re-derive this anchor's payload from `record`, through the SAME builders
    the anchoring path used — those of the anchor's own payload version.

    Raises UnsupportedPayload when that version has no rules here."""
    rules = rules or payload_rules(anchor)
    if anchor.stage == EVALUATION_STAGE:
        # Rebuilt from the bids AS THEY ARE NOW, with their stored salts — an
        # added, deleted, re-priced or re-graded bid changes the hash.
        return evaluation_payload(record, list(record.bids.all()), rules=rules), ""
    if anchor.entity_type == BlockchainAnchor.EntityType.PROJECT:
        return project_parts(record, anchor.stage, document_hash, rules=rules)
    if anchor.entity_type == BlockchainAnchor.EntityType.BID:
        return bid_parts(record, anchor.stage, document_hash, rules=rules)
    return award_parts(record, anchor.stage, document_hash, rules=rules)


def _legacy_record_ok(anchor, rebuilt):
    """Record check for version-1 anchors (PAYLOAD_RULES[1], `legacy`).

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

    Returns {status, record, document, detail}, plus what was added in Stage 5:
    `completeness` (what the anchor recorded about the five documents),
    `document_evidence` (with deep: the exact version it fingerprinted, which for
    v1/v2 stands beside `document` and does not change it) and, for a commitment,
    `openings`. `status` is the worst of the record and document checks, so a
    caller can act on one field. Never raises — a verifier that crashes on odd
    data is worse than one that reports "unavailable"."""
    result = {"status": UNAVAILABLE, "record": UNAVAILABLE, "document": SKIPPED, "detail": ""}
    try:
        result = _verify_anchor(anchor, deep, result)
    except Exception:  # pragma: no cover — a verifier must never 500 a page
        logger.exception("Integrity check failed for anchor %s", getattr(anchor, "id", "?"))
        result["detail"] = "This record could not be checked."
    result.setdefault("completeness", payload_v3_reader.completeness(anchor.payload))
    if "document_evidence" not in result:
        result["document_evidence"] = (
            _single_document_evidence(anchor) if deep else document_evidence.not_checked())
    return result


def _single_document_evidence(anchor):
    """The one document a v1/v2 anchor binds, by version. Never raises."""
    try:
        record = live_record(anchor)
        if record is None or anchor.stage == EVALUATION_STAGE:
            return document_evidence.not_applicable()
        return document_evidence.check_single_document(
            anchor, record, STAGE_DOCUMENT_FIELD.get(anchor.stage),
            own_award_document=anchor.stage in AWARD_OWN_DOCUMENT_STAGES)
    except Exception:  # noqa: BLE001 — the checks above keep their own result
        logger.exception("Document evidence check failed for anchor %s", getattr(anchor, "id", "?"))
        return {"checked": True, "state": document_evidence.FILE_UNREADABLE, "entries": []}


def _verify_anchor(anchor, deep, result):
    """verify_anchor's checks. Exceptions are verify_anchor's to report."""
    record = live_record(anchor)
    if record is None:
        result["detail"] = "The record this anchor was taken from no longer exists."
        result["reason"] = "record_gone"
        return result

    # ── Which rules? The anchor's own payload version, never today's ──
    try:
        rules = payload_rules(anchor)
    except UnsupportedPayload as exc:
        # Not evidence of tampering — this server simply can't interpret
        # it. Reported as unavailable, never as altered.
        result["detail"] = f"This record uses {exc}, so it can't be checked here."
        result["reason"] = "unsupported_version"
        return result

    if rules.reader is not None:
        return rules.reader(anchor, record, deep=deep)

    # ── Record check ──────────────────────────────────────────────────
    payload, _ = rebuild_payload(anchor, record, document_hash=anchor.document_hash, rules=rules)

    # A re-issued award document: check the old anchor against its own
    # snapshot instead of the live record, which has legitimately moved on.
    # Its file was replaced on purpose, so the deep document check doesn't
    # apply either.
    newer = superseding_anchor(anchor)
    if newer is not None:
        if _superseded_record_ok(anchor, payload, rules):
            result.update(
                status=SUPERSEDED, record=SUPERSEDED, document=SKIPPED,
                detail=f"Replaced by a later issue of this document on {timezone.localdate(newer.created_at)}.",
                superseded_by=newer.id,
            )
        else:
            result.update(
                status=MISMATCH, record=MISMATCH,
                detail="This record has been altered since it was recorded on-chain.",
            )
        return result

    if rules.legacy:
        record_ok = _legacy_record_ok(anchor, payload)
    else:
        record_ok = hash_payload(payload) == anchor.data_hash
    result["record"] = MATCH if record_ok else MISMATCH
    if not record_ok:
        result["detail"] = "This record has been altered since it was recorded on-chain."

    # ── Document check (opt-in) ───────────────────────────────────────
    if deep and anchor.stage == EVALUATION_STAGE:
        result["document"] = evaluation_documents_check(record)
        if result["document"] == MISMATCH:
            result["detail"] = result["detail"] or "A bid's quotation document has been replaced since the award."
        elif result["document"] == UNAVAILABLE:
            result["detail"] = result["detail"] or "A committed quotation document is missing from storage."
    elif deep and anchor.document_hash:
        _, current_doc_hash = rebuild_payload(anchor, record, document_hash=None, rules=rules)
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


def attach_transaction(anchor, tx_hash, block_number=None, actor_address=""):
    """Record the confirmed on-chain transaction for an anchor.

    Returns the updated anchor. Raises ValueError on a malformed tx hash — this
    one DOES raise, because it runs from an explicit "here is my transaction"
    request whose caller wants to know it was rejected."""
    tx_hash = (tx_hash or "").strip()
    if not _is_hex32(tx_hash):
        raise ValueError("tx_hash must be a 0x-prefixed 32-byte hex string.")
    anchor.tx_hash = tx_hash
    # The block number the BROWSER reports is kept for display only; the
    # server overwrites it from the receipt when it confirms the transaction.
    anchor.block_number = int(block_number) if str(block_number or "").strip().isdigit() else None
    anchor.actor_address = (actor_address or "").strip()[:42]
    anchor.anchored_at = timezone.now()
    # A newly reported transaction has not been checked by anyone yet.
    anchor.chain_status = BlockchainAnchor.ChainStatus.UNCHECKED
    anchor.chain_checked_at = None
    _reset_chain_identity(anchor)    # it described the previous transaction
    anchor.save(update_fields=[
        "tx_hash", "block_number", "actor_address", "anchored_at", "chain_status", "chain_checked_at",
        *CHAIN_IDENTITY_FIELDS,
    ])
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
        # `anchored` = a transaction has been REPORTED. Only `verified_on_chain`
        # (the server read the receipt and found this exact event) is proof.
        "anchored": anchor.anchored,
        "chain_status": anchor.chain_status,
        "chain_checked_at": anchor.chain_checked_at,
        "verified_on_chain": anchor.verified_on_chain,
        # What this anchor recorded about the five documents; read from the payload.
        "completeness": payload_v3_reader.completeness(anchor.payload),
        # The record's on-chain identity, filled only by the server's own
        # confirmation (null until then, and for receipts a node has pruned).
        **chain_identity(anchor),
        # A reported transaction that turned out not to record this anchor
        # may be signed again (see attach_anchor_transaction).
        "can_reanchor": (not anchor.anchored)
                        or anchor.chain_status == BlockchainAnchor.ChainStatus.MISMATCH,
        "explorer_url": (ETHERSCAN_TX_URL + anchor.tx_hash) if anchor.tx_hash else "",
        "created_at": anchor.created_at,
        "attach_url": attach_url_for(anchor),
        # Tells the browser to ask the server to sign a retry ("Anchor now")
        # instead of opening MetaMask.
        "server_signing": SERVER_SIGNING_ENABLED and WALLET_SIGNING_ENABLED,
        # False = read-only deployment: the browser must not offer "Anchor now"
        # or contact a wallet, and the /anchor/ endpoints would refuse anyway.
        "signing_enabled": WALLET_SIGNING_ENABLED,
    }
    if include_payload:
        data["payload"] = anchor.payload
    return data


def chain_identity(anchor):
    """Where this anchor lives on-chain, as the server last verified it.
    Public data only: the same values anyone can read from the contract."""
    return {
        "chain_anchor_id": anchor.chain_anchor_id,
        "chain_log_index": anchor.chain_log_index,
        "chain_timestamp": anchor.chain_timestamp,
        "chain_id": anchor.chain_id,
        "chain_contract": anchor.chain_contract,
        "chain_confirmations": anchor.chain_confirmations,
        "chain_finalized": anchor.chain_finalized,
    }


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
    """The contract ABI, read from the copy next to this module.

    It lives inside the backend because Heroku deploys backend/ on its own, so
    the repo's contracts/ folder doesn't exist in production. Looking there made
    every server write and receipt check fail. Tests keep it identical to the
    copies in contracts/ and frontend/ (LedgerAbiLocationTests in
    test_regressions.py, and frontend/src/blockchain/ledgerAbi.test.js)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ProcurementLedger.abi.json")
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
    if not WALLET_SIGNING_ENABLED:
        return None  # read-only deployment: nothing is ever sent
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


# ── Confirmation: is the reported transaction really on-chain? ───────────────
# A tx_hash on an anchor is only ever a CLAIM until the server reads it back:
#   * server-signed anchors are recorded when the transaction is broadcast,
#     because waiting for a block would outlast gunicorn's worker timeout (see
#     submit_anchor_server_side) — it can still revert or be dropped;
#   * MetaMask anchors are attached with whatever tx hash the browser posted,
#     and attach_transaction only checks that it is well-formed.
# confirm_anchor() closes both gaps. It only reports CONFIRMED when
#   1. the node it asks really is Sepolia (eth_chainId), so a misconfigured
#      RPC can't vouch for another network;
#   2. the transaction succeeded, and OUR ledger contract emitted (in it) an
#      AnchorRecorded event carrying exactly this anchor's entity type,
#      procurement code, stage and data hash — one not already claimed by
#      another anchor row;
#   3. the contract's STATE agrees: getAnchor(<event id>) returns the same
#      fields, signer and timestamp.
# It then stores that on-chain identity (contract anchor id, log index, chain
# time, network, contract) and how deep / final the block is. Anything else is
# never shown as "verified on-chain".

CONFIRMED = "confirmed"   # all three checks passed — identity saved
REVERTED = "reverted"     # mined but failed — cleared so it can be retried
DROPPED = "dropped"       # the network never mined it — cleared likewise
PENDING = "pending"       # not mined yet — check again later
UNKNOWN = "unknown"       # the node couldn't be asked / no ledger configured — check again later
TX_MISMATCH = "mismatch"  # mined, but it does not record THIS anchor — kept and flagged
WRONG_NETWORK = "wrong_network"   # the RPC is not Sepolia — nothing read, nothing saved

# A transaction the node has never heard of is only treated as dropped after
# this long. A freshly broadcast one can take a moment to show up everywhere.
DROPPED_AFTER = timedelta(hours=1)

# Per-call RPC timeout for server-side reads. Short on purpose: the on-demand
# check runs inside a web request, and an unreachable node must turn into
# UNKNOWN quickly rather than holding a gunicorn worker.
RPC_TIMEOUT_SECONDS = 8

# Every field confirm_anchor fills from the chain; cleared together whenever
# the transaction they describe stops being this anchor's.
CHAIN_IDENTITY_FIELDS = (
    "chain_anchor_id", "chain_log_index", "chain_timestamp", "chain_id",
    "chain_contract", "chain_confirmations", "chain_finalized",
)


def _reset_chain_identity(anchor):
    for field in CHAIN_IDENTITY_FIELDS:
        setattr(anchor, field, anchor._meta.get_field(field).get_default())


def web3_client():
    """A read-only Sepolia connection, or None when web3.py isn't installed."""
    Web3 = _load_web3()
    if Web3 is None:
        return None
    return Web3(Web3.HTTPProvider(SEPOLIA_RPC_URL, request_kwargs={"timeout": RPC_TIMEOUT_SECONDS}))


def network_check(w3):
    """(ok, chain_id): is this connection really SEPOLIA_CHAIN_ID?

    ok is None when the node could not be asked — the caller must treat that as
    "can't tell", never as a pass. The RPC URL is configuration, and a wrong one
    (mainnet, a local fork, another testnet) would otherwise answer every read
    with confident nonsense."""
    try:
        chain_id = int(w3.eth.chain_id)
    except Exception:  # noqa: BLE001 — unreachable node / bad URL
        logger.warning("Could not read the chain id from %s", SEPOLIA_RPC_URL, exc_info=True)
        return None, None
    return chain_id == SEPOLIA_CHAIN_ID, chain_id


def _not_found(exc):
    # web3.exceptions.TransactionNotFound, matched by name so web3 stays an
    # optional import and tests don't need the real package.
    return exc.__class__.__name__ == "TransactionNotFound"


def _same_address(a, b):
    return bool(a) and bool(b) and str(a).lower() == str(b).lower()


def _ledger(w3):
    Web3 = _load_web3()
    return w3.eth.contract(address=Web3.to_checksum_address(LEDGER_CONTRACT_ADDRESS), abi=_ledger_abi())


def anchor_events(w3, receipt):
    """The AnchorRecorded events in `receipt` that OUR ledger emitted, as plain
    dicts {address, id, logIndex, entityType, entityRef, stage, dataHash,
    actor, timestamp}.

    Decoded with the contract's own ABI. Logs from any other address are
    dropped even if they carry the same event signature — anyone can deploy a
    look-alike contract."""
    Web3 = _load_web3()
    if Web3 is None:
        return []
    from web3.logs import DISCARD  # noqa: PLC0415 — optional dependency

    events = _ledger(w3).events.AnchorRecorded().process_receipt(receipt, errors=DISCARD)
    return [
        {
            "address": ev["address"],
            "id": int(ev["args"]["id"]),
            "logIndex": int(ev["logIndex"]),
            "entityType": ev["args"]["entityType"],
            "entityRef": ev["args"]["entityRef"],
            "stage": ev["args"]["stage"],
            "dataHash": ev["args"]["dataHash"],
            "actor": ev["args"]["actor"],
            "timestamp": int(ev["args"]["timestamp"]),
        }
        for ev in events
        if _same_address(ev["address"], LEDGER_CONTRACT_ADDRESS)
    ]


def _ledger_holds(anchor, w3):
    """Does the ledger's contract STATE contain exactly this anchor's
    (entityType, code, stage, dataHash)? Read with getAnchorsByRef — state is
    never pruned, unlike receipts.

    True / False, or None when it could not be read. None must never be read
    as "not there": an RPC hiccup here used to make a genuine anchor look
    dropped and get its tx hash cleared."""
    if _load_web3() is None or not LEDGER_CONTRACT_ADDRESS:
        return None
    try:
        rows = _ledger(w3).functions.getAnchorsByRef(anchor.entity_ref).call()
    except Exception:  # noqa: BLE001 — can't tell
        logger.warning("Could not read ledger state for anchor %s", anchor.id, exc_info=True)
        return None
    return any(
        r[0] == anchor.entity_type and r[1] == anchor.entity_ref and r[2] == anchor.stage
        and str(r[3]).lower() == anchor.data_hash.lower()
        for r in rows
    )


def _event_records(anchor, ev):
    return (ev["entityType"] == anchor.entity_type and ev["entityRef"] == anchor.entity_ref
            and ev["stage"] == anchor.stage
            and str(ev["dataHash"]).lower() == anchor.data_hash.lower())


def _claimed_ids(anchor, chain_id):
    """Contract anchor ids already backing a DIFFERENT anchor row."""
    return set(
        BlockchainAnchor.objects
        .filter(chain_id=chain_id, chain_contract__iexact=LEDGER_CONTRACT_ADDRESS,
                chain_anchor_id__isnull=False)
        .exclude(pk=anchor.pk)
        .values_list("chain_anchor_id", flat=True)
    )


def _matching_event(anchor, w3, receipt, chain_id):
    """(event, reason): the unclaimed ledger event in this receipt that records
    `anchor`, or (None, why not).

    Decided by the EVENT, not by the transaction's `to`: anchor_events only
    keeps logs emitted BY the ledger address, and no other contract can emit a
    log under that address — that is the proof. Requiring `to == ledger` was
    wrong: wallets that send through a smart account or batch executor (seen on
    the live Sepolia ledger, anchors #11–#14) call the ledger internally, so
    `to` is the executor while the ledger's own event is genuinely there.

    A batched transaction can carry several identical-looking events; each
    on-chain record vouches for one anchor row only, lowest log index first."""
    matches = sorted((ev for ev in anchor_events(w3, receipt) if _event_records(anchor, ev)),
                     key=lambda ev: ev["logIndex"])
    if not matches:
        return None, "the transaction emitted no matching AnchorRecorded event from the ledger"
    claimed = _claimed_ids(anchor, chain_id)
    for ev in matches:
        if ev["id"] not in claimed:
            return ev, ""
    return None, (f"its matching on-chain record(s) {sorted(e['id'] for e in matches)} already "
                  "back another anchor")


def _state_agrees(w3, ev):
    """True / False / None (couldn't read): does getAnchor(ev.id) — the
    contract's stored record — equal what the event announced?"""
    try:
        row = _ledger(w3).functions.getAnchor(ev["id"]).call()
    except Exception:  # noqa: BLE001 — node error, or an id the state doesn't know
        logger.warning("Could not read getAnchor(%s)", ev["id"], exc_info=True)
        return None
    return (row[0] == ev["entityType"] and row[1] == ev["entityRef"] and row[2] == ev["stage"]
            and str(row[3]).lower() == str(ev["dataHash"]).lower()
            and _same_address(row[4], ev["actor"]) and int(row[5]) == ev["timestamp"])


def finality(w3, block_number):
    """(confirmations, finalized) for a mined block, as the node reports now.

    finalized is True only when the node's `finalized` block is at or above
    it. If the node can't say (old client, RPC error) it is False — reported
    as "not shown to be final", never assumed. confirmations is None when even
    the latest block number can't be read."""
    try:
        latest = int(w3.eth.block_number)
        confirmations = max(latest - int(block_number) + 1, 0)
    except Exception:  # noqa: BLE001
        logger.warning("Could not read the latest block", exc_info=True)
        return None, False
    try:
        finalized = int(w3.eth.get_block("finalized")["number"]) >= int(block_number)
    except Exception:  # noqa: BLE001 — node without the "finalized" tag
        logger.warning("The node did not report a finalized block", exc_info=True)
        finalized = False
    return confirmations, finalized


def needs_chain_check(qs=None):
    """Anchors with a reported transaction that the server should (re)read:
    not yet confirmed, or confirmed without its on-chain identity, or not yet
    shown to be final. Fully reconciled, final anchors are never re-read."""
    from django.db.models import Q  # noqa: PLC0415

    qs = BlockchainAnchor.objects.all() if qs is None else qs
    return qs.exclude(tx_hash="").filter(
        ~Q(chain_status=BlockchainAnchor.ChainStatus.CONFIRMED)
        | Q(chain_anchor_id__isnull=True)
        | Q(chain_finalized=False)
    )


def confirm_anchor(anchor, *, w3, apply=True):
    """Check one anchor's reported transaction against the chain and record
    what really happened.

    Returns CONFIRMED / TX_MISMATCH / REVERTED / DROPPED / PENDING / UNKNOWN /
    WRONG_NETWORK. With apply=False nothing is saved, so the caller can preview.

    A failed or dropped transaction is CLEARED rather than deleted: the anchor
    row (and the business record) stays, it simply reads as "not yet anchored"
    again and can be retried. A mismatching one is KEPT and flagged, so the
    bad reference stays visible instead of quietly disappearing. Either way the
    event is in the audit log.

    An anchor the server confirmed before is re-read to fill in its identity
    and finality, but never downgraded because a node can't find its receipt:
    public RPCs prune old history. Never raises."""
    from django.db import IntegrityError, transaction  # noqa: PLC0415

    tx_hash = anchor.tx_hash
    if not tx_hash:
        return PENDING
    was_confirmed = anchor.chain_status == BlockchainAnchor.ChainStatus.CONFIRMED
    if was_confirmed and anchor.chain_anchor_id is not None and anchor.chain_finalized:
        return CONFIRMED            # fully reconciled and final: nothing left to learn
    if not LEDGER_CONTRACT_ADDRESS:
        # Nothing to compare the event against: we can say neither yes nor no.
        return UNKNOWN
    try:
        ok, chain_id = network_check(w3)
        if ok is None:
            return UNKNOWN
        if not ok:
            logger.error("SEPOLIA_RPC_URL answers chain id %s, expected %s; nothing confirmed.",
                         chain_id, SEPOLIA_CHAIN_ID)
            return WRONG_NETWORK

        try:
            receipt = w3.eth.get_transaction_receipt(tx_hash)
        except Exception as exc:  # noqa: BLE001 — see _not_found
            if not _not_found(exc):
                raise
            receipt = None

        if receipt is not None:
            if int(receipt["status"]) == 1:
                ev, why = _matching_event(anchor, w3, receipt, chain_id)
                if ev is None:
                    if apply:
                        _flag_mismatched_transaction(anchor, why)
                    return TX_MISMATCH
                agrees = _state_agrees(w3, ev)
                if agrees is None:
                    return UNKNOWN
                if not agrees:
                    # Our ledger's own event disagreeing with its own storage
                    # can't happen on an honest node: refuse to vouch, loudly.
                    logger.error("Ledger event %s disagrees with getAnchor(%s) for anchor %s",
                                 tx_hash, ev["id"], anchor.id)
                    return UNKNOWN
                block = int(receipt["blockNumber"])
                confirmations, final = finality(w3, block)
                if apply:
                    anchor.block_number = block
                    anchor.chain_status = BlockchainAnchor.ChainStatus.CONFIRMED
                    anchor.chain_checked_at = timezone.now()
                    anchor.chain_anchor_id = ev["id"]
                    anchor.chain_log_index = ev["logIndex"]
                    anchor.chain_timestamp = datetime.fromtimestamp(ev["timestamp"], tz=dt_timezone.utc)
                    # The signer the CHAIN recorded (msg.sender, checked against
                    # getAnchor). Replaces whatever address the browser reported.
                    anchor.actor_address = ev["actor"]
                    anchor.chain_id = chain_id
                    anchor.chain_contract = _load_web3().to_checksum_address(LEDGER_CONTRACT_ADDRESS)
                    anchor.chain_confirmations = confirmations
                    anchor.chain_finalized = final
                    try:
                        with transaction.atomic():
                            anchor.save(update_fields=[
                                "block_number", "chain_status", "chain_checked_at", "actor_address",
                                *CHAIN_IDENTITY_FIELDS,
                            ])
                    except IntegrityError:
                        # Another check claimed the same on-chain record a
                        # moment ago (the unique constraint): decide next run.
                        anchor.refresh_from_db()
                        return UNKNOWN
                return CONFIRMED
            outcome = REVERTED
        else:
            if was_confirmed:
                return UNKNOWN      # pruned node: keep what was proven earlier
            try:
                w3.eth.get_transaction(tx_hash)
                return PENDING            # known to the network, not mined yet
            except Exception as exc:  # noqa: BLE001
                if not _not_found(exc):
                    raise
            sent_at = anchor.anchored_at or anchor.created_at
            if sent_at and timezone.now() - sent_at < DROPPED_AFTER:
                return PENDING
            # "The node has never heard of it" is NOT proof it was never mined:
            # public RPCs prune old history (the default publicnode endpoint
            # returns no receipt for months-old ledger transactions). Clearing
            # on that basis would erase a genuine anchor. The ledger's STORAGE
            # is never pruned, so if it holds this exact record — or can't be
            # read at all — leave the anchor alone and report UNKNOWN.
            if _ledger_holds(anchor, w3) is not False:
                return UNKNOWN
            outcome = DROPPED

        if apply:
            _clear_failed_transaction(anchor, outcome)
        return outcome
    except Exception:  # noqa: BLE001 — a confirmation pass must never break anything
        logger.warning("Could not confirm anchor %s (tx %s)", anchor.id, tx_hash, exc_info=True)
        return UNKNOWN


def _flag_mismatched_transaction(anchor, reason=""):
    """Mark a reported transaction that doesn't record this anchor, and log it."""
    from accounts.audit import log_action  # noqa: PLC0415 — avoid an import cycle

    already = anchor.chain_status == BlockchainAnchor.ChainStatus.MISMATCH
    anchor.chain_status = BlockchainAnchor.ChainStatus.MISMATCH
    anchor.chain_checked_at = timezone.now()
    _reset_chain_identity(anchor)
    anchor.save(update_fields=["chain_status", "chain_checked_at", *CHAIN_IDENTITY_FIELDS])
    if already:
        return
    log_action(
        None, "blockchain.mismatch",
        entity_type=anchor.entity_type, entity_id=anchor.entity_id,
        description=(
            f"{anchor.entity_ref} {anchor.stage}: transaction {anchor.tx_hash} does not record "
            f"this anchor on the configured ledger ({reason or 'no matching event'}); "
            "it is not treated as on-chain."
        ),
    )


def _clear_failed_transaction(anchor, outcome):
    """Undo a transaction that never made it on-chain, and say so in the audit log."""
    from accounts.audit import log_action  # noqa: PLC0415 — avoid an import cycle

    failed_hash = anchor.tx_hash
    anchor.tx_hash = ""
    anchor.block_number = None
    anchor.actor_address = ""
    anchor.anchored_at = None
    anchor.chain_status = outcome      # REVERTED / DROPPED: what happened last time
    anchor.chain_checked_at = timezone.now()
    _reset_chain_identity(anchor)
    anchor.save(update_fields=[
        "tx_hash", "block_number", "actor_address", "anchored_at", "chain_status", "chain_checked_at",
        *CHAIN_IDENTITY_FIELDS,
    ])
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
        w3 = web3_client()
        # Same network guard as confirm_anchor: rows from another chain would
        # be shown to the public as this procurement's trail.
        ok, chain_id = network_check(w3)
        if not ok:
            logger.warning("Not reading %s: RPC chain id %s is not %s", entity_ref, chain_id, SEPOLIA_CHAIN_ID)
            return []
        rows = _ledger(w3).functions.getAnchorsByRef(entity_ref).call()
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
