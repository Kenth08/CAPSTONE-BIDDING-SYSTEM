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
from datetime import timezone as dt_timezone

from .canonical import NonCanonicalPayload, validate_canonical

VERSION = 3

# Domain tags, one per payload type. Only project-stage/3 is built so far.
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


def iso_utc(value):
    """A datetime as ISO-8601 in UTC, or "" for None. Converted explicitly, so
    the text can't depend on the server's time zone (TIME_ZONE is Asia/Manila)."""
    if value is None:
        return ""
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
