"""Payload version 3 — project stages (`project-stage/3`).

Once a v3 anchor exists, this module is frozen the way payload_v2 is: a new
shape goes in a new module. v3 writing is OFF (blockchain.PAYLOAD_V3_ENABLED),
and the other v3 kinds arrive in later phases.

What v3 adds to a project stage:

* `kind`, a domain tag, so a hash computed for one purpose can't be presented as
  another: the same fields under a different tag hash differently.
* `documents`, a manifest of all five procurement documents. v2 fingerprints one
  document per stage, so the other four could change without any anchor noticing.
* `document_key`, which manifest entry is this stage's evidence document, with
  its hash repeated as `document_hash` so a single-file check keeps working.

Every payload is validated before it is returned: a value outside this exact
schema must never reach the hash, because the chain can't be corrected later.
"""
import re
from datetime import datetime
from datetime import timezone as dt_timezone

from .canonical import NonCanonicalPayload, validate_canonical

VERSION = 3

# Domain tags, one per payload type. award-document/3 is not built yet: which of
# its fields are public depends on Decision A.
KIND_PROJECT_STAGE = "project-stage/3"
KIND_EVALUATION = "evaluation/3"
KIND_AWARD_DOCUMENT = "award-document/3"
KIND_BID_LEAF = "bid-leaf/3"
KIND_AWARD_PRIVATE = "award-private/3"

# The manifest's keys, spelled out rather than imported: this schema must not
# follow later changes to the models.
DOCUMENT_KEYS = frozenset({
    "purchase_request", "technical_specifications", "terms_of_reference",
    "approved_budget_document", "bid_evaluation_criteria",
})

# Each project stage's evidence document (the same ones v2 binds).
STAGE_EVIDENCE = {
    "SUBMITTED": "purchase_request",
    "HEAD_APPROVED": "approved_budget_document",
    "HEAD_REJECTED": "purchase_request",
    "REVISION_REQUESTED": "purchase_request",
    "BIDDING_OPEN": "bid_evaluation_criteria",
}

STATE_PRESENT = "present"        # file readable: its hash and version
STATE_ABSENT = "absent"          # nothing uploaded: proves it was missing
STATE_UNREADABLE = "unreadable"  # recorded, but storage couldn't read it

_HASH = re.compile(r"0x[0-9a-f]{64}")
_MONEY = re.compile(r"[0-9]+\.[0-9]{2}")
_UTC_DATETIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{6})?\+00:00")

_PROJECT_STAGE_KEYS = frozenset({
    "v", "kind", "entity", "stage", "code", "name", "category", "type", "budget",
    "bidding_period_days", "delivery_period_days", "created_at",
    "documents", "document_key", "document_hash",
})
_ENTRY_KEYS = frozenset({"state", "sha256", "version"})

# ── DECISION A ── the award fields hidden inside `private_commitment`.
# PROVISIONAL, a WORKING ASSUMPTION: the contract amount is public under the working
# policy (SECURITY.md, "Award disclosure policy"), so it is not here. This stays
# provisional until that policy is reflected in this builder, the public API and the
# verifier. If the amount becomes private, "amount" joins this list. Nothing may be
# anchored with it until that is settled.
AWARD_PRIVATE_FIELDS = ("award_id", "bid_id", "supplier_id", "status", "awarded_at")

_SALT = re.compile(r"[0-9a-f]{64}")
_BID_LEAF_KEYS = frozenset({
    "kind", "bid_id", "supplier_id", "amount", "submitted_at", "document_hash", "status", "salt",
})
_AWARD_PRIVATE_KEYS = frozenset({"kind", "salt", *AWARD_PRIVATE_FIELDS})
_EVALUATION_KEYS = frozenset({"v", "kind", "entity", "stage", "code", "bid_count", "leaves"})


def iso_utc(value):
    """A datetime as ISO-8601 in UTC, or "" for None. Converted explicitly, so
    the text can't depend on the server's time zone (TIME_ZONE is Asia/Manila).
    A naive datetime or a bare date is refused: astimezone() would quietly read
    the first as server-local time, and the second has no time at all.

    The date in this text is the UTC date. From 16:00 to 23:59 UTC it is the day
    BEFORE the Manila date the rest of the system shows for the same instant."""
    if value is None:
        return ""
    if not isinstance(value, datetime) or value.utcoffset() is None:
        raise NonCanonicalPayload("a datetime with a time zone is required")
    return value.astimezone(dt_timezone.utc).isoformat()


def project_payload(project, stage, documents):
    """What a procurement WAS at `stage`, with its five-document manifest
    (project_documents.document_manifest). Raises NonCanonicalPayload rather
    than return anything outside the schema."""
    stage = str(stage)
    document_key = STAGE_EVIDENCE.get(stage, "")
    payload = {
        "v": VERSION,
        "kind": KIND_PROJECT_STAGE,
        "entity": "PROJECT",
        "stage": stage,
        "code": project.code,
        "name": project.name,
        "category": project.category or "",
        "type": project.type or "",
        "budget": f"{project.budget:.2f}",
        "bidding_period_days": project.bidding_period_days or 0,
        "delivery_period_days": project.delivery_period_days or 0,
        "created_at": iso_utc(project.created_at),
        "documents": documents,
        "document_key": document_key,
        "document_hash": documents.get(document_key, {}).get("sha256", ""),
    }
    validate_project_stage(payload)
    return payload


def validate_project_stage(payload):
    """Raise NonCanonicalPayload unless `payload` is exactly a project-stage/3."""
    validate_canonical(payload)
    _require_keys(payload, _PROJECT_STAGE_KEYS, "payload")
    _require(payload["v"] == VERSION, "v must be 3")
    _require(payload["kind"] == KIND_PROJECT_STAGE, "kind must be project-stage/3")
    _require(payload["entity"] == "PROJECT", "entity must be PROJECT")
    _require(payload["stage"] in STAGE_EVIDENCE, "stage is not a project stage")
    for field in ("code", "name", "category", "type"):
        _require(isinstance(payload[field], str), f"{field} must be a string")
    _require(bool(payload["code"]), "code must not be empty")
    _require(_matches(_MONEY, payload["budget"]), "budget must be a string with two decimals")
    for field in ("bidding_period_days", "delivery_period_days"):
        _require(type(payload[field]) is int and payload[field] >= 0, f"{field} must be a count")  # noqa: E721
    _require(_matches(_UTC_DATETIME, payload["created_at"]), "created_at must be ISO-8601 in UTC")

    documents = payload["documents"]
    _require(isinstance(documents, dict), "documents must be an object")
    _require_keys(documents, DOCUMENT_KEYS, "documents")
    for key, entry in documents.items():
        _validate_entry(key, entry)

    _require(payload["document_key"] == STAGE_EVIDENCE[payload["stage"]],
             "document_key must be this stage's evidence document")
    _require(payload["document_hash"] == documents[payload["document_key"]]["sha256"],
             "document_hash must repeat the evidence document's manifest hash")


# ── Commitments ──────────────────────────────────────────────────────────────
# C = SHA-256(canonical({kind, private fields, salt})). An "opening" is that exact
# object. Validation messages never include a value: these objects hold salts.

def bid_leaf_opening(bid, document_hash, salt):
    """One bid's leaf in an evaluation commitment."""
    opening = {
        "kind": KIND_BID_LEAF,
        "bid_id": bid.id,
        "supplier_id": bid.supplier_id,
        "amount": f"{bid.amount:.2f}",
        "submitted_at": iso_utc(bid.submitted_at),
        "document_hash": document_hash,
        "status": bid.status,
        "salt": salt,
    }
    validate_opening(opening)
    return opening


def award_private_opening(award, salt):
    """The private half of one award-document issue. Its shape follows
    AWARD_PRIVATE_FIELDS (Decision A).

    The exact time is the project's: Award.awarded_at is only a date, which is
    public anyway. A project with no award time is refused, not filled in."""
    values = {
        "award_id": award.id,
        "bid_id": award.bid_id or 0,
        "supplier_id": award.supplier_id,
        "status": award.status,
        "awarded_at": iso_utc(award.project.awarded_at),
    }
    opening = {"kind": KIND_AWARD_PRIVATE, "salt": salt, **{f: values[f] for f in AWARD_PRIVATE_FIELDS}}
    validate_opening(opening)
    return opening


def validate_opening(opening):
    """Raise NonCanonicalPayload unless `opening` is exactly a bid-leaf/3 or an
    award-private/3. Its kind decides which: an unknown kind is refused."""
    validate_canonical(opening)
    kind = opening.get("kind")
    if kind == KIND_BID_LEAF:
        _require_keys(opening, _BID_LEAF_KEYS, "opening")
        _require(_matches(_MONEY, opening["amount"]), "amount must be a string with two decimals")
        _require(_matches(_UTC_DATETIME, opening["submitted_at"]), "submitted_at must be ISO-8601 in UTC")
        _require(opening["document_hash"] == "" or _matches(_HASH, opening["document_hash"]),
                 "document_hash must be empty or 0x + 64 lowercase hex")
    elif kind == KIND_AWARD_PRIVATE:
        _require_keys(opening, _AWARD_PRIVATE_KEYS, "opening")
        _require(_matches(_UTC_DATETIME, opening["awarded_at"]), "awarded_at must be ISO-8601 in UTC")
    else:
        raise NonCanonicalPayload("opening: unknown kind")
    for field in ("bid_id", "supplier_id", "award_id"):
        if field in opening:
            _require(type(opening[field]) is int, f"{field} must be a count")  # noqa: E721
    _require(isinstance(opening["status"], str) and bool(opening["status"]), "status must be a string")
    _require(_matches(_SALT, opening["salt"]), "salt must be 64 lowercase hex characters")


def evaluation_payload(project, leaves, stage="EVALUATION_COMPLETED"):
    """The evaluation commitment. Leaves are sorted by their own value (Decision
    F): v2's bid-id order showed a losing bidder how many bids came before theirs."""
    payload = {
        "v": VERSION,
        "kind": KIND_EVALUATION,
        "entity": "PROJECT",
        "stage": str(stage),
        "code": project.code,
        "bid_count": len(leaves),
        "leaves": sorted(leaves),
    }
    validate_evaluation(payload)
    return payload


def validate_evaluation(payload):
    """Raise NonCanonicalPayload unless `payload` is exactly an evaluation/3.
    `leaves` is the one array v3 allows, because its order is specified."""
    _require(isinstance(payload, dict), "payload must be an object")
    _require_keys(payload, _EVALUATION_KEYS, "payload")
    leaves = payload["leaves"]
    _require(isinstance(leaves, list), "leaves must be an array")
    validate_canonical({key: value for key, value in payload.items() if key != "leaves"})
    _require(payload["v"] == VERSION, "v must be 3")
    _require(payload["kind"] == KIND_EVALUATION, "kind must be evaluation/3")
    _require(payload["entity"] == "PROJECT", "entity must be PROJECT")
    _require(payload["stage"] == "EVALUATION_COMPLETED", "stage must be EVALUATION_COMPLETED")
    _require(bool(payload["code"]) and isinstance(payload["code"], str), "code must not be empty")
    _require(payload["bid_count"] == len(leaves), "bid_count must equal the number of leaves")
    _require(all(_matches(_HASH, leaf) for leaf in leaves), "each leaf must be 0x + 64 lowercase hex")
    _require(leaves == sorted(set(leaves)), "leaves must be unique and sorted by value")


def _validate_entry(key, entry):
    """present: its hash, version 1 or more. absent: no hash, version 0.
    unreadable: no hash, version 1 or more (a file is on record)."""
    _require(isinstance(entry, dict), f"documents.{key} must be an object")
    _require_keys(entry, _ENTRY_KEYS, f"documents.{key}")
    state, sha256, version = entry["state"], entry["sha256"], entry["version"]
    _require(type(version) is int and version >= 0, f"documents.{key}.version must be a count")  # noqa: E721
    if state == STATE_PRESENT:
        _require(_matches(_HASH, sha256), f"documents.{key}.sha256 must be 0x + 64 lowercase hex")
        _require(version >= 1, f"documents.{key}: a present file has a version")
    elif state == STATE_ABSENT:
        _require(sha256 == "" and version == 0, f"documents.{key}: absent means no hash, version 0")
    elif state == STATE_UNREADABLE:
        _require(sha256 == "" and version >= 1, f"documents.{key}: unreadable means no hash, a version")
    else:
        raise NonCanonicalPayload(f"documents.{key}: unknown state {state!r}")


def _matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _require(condition, message):
    if not condition:
        raise NonCanonicalPayload(message)


def _require_keys(obj, expected, path):
    if obj.keys() != expected:
        raise NonCanonicalPayload(
            f"{path}: missing {sorted(expected - obj.keys())}, unexpected {sorted(obj.keys() - expected)}")
