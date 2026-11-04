"""Reading payload v3 anchors: the verification half of payload_v3.

STRICTLY READ-ONLY. This module signs nothing, submits nothing and writes nothing.
It is reached only from verify_anchor, for anchors that already exist, and it
can't select v3 for writing: v3 sits in blockchain.READ_ONLY_RULES, outside the
registry a writer version must be in. PAYLOAD_V3_ENABLED has no effect on it.

Order of the checks, and what each failure means:

    1. The stored payload hashes to data_hash.    No → MISMATCH. The anchor row was
       edited, whatever else the payload looks like.
    2. Its kind is one this server can read.      No → UNAVAILABLE, never altered.
    3. It is exactly that kind's schema.          No → UNAVAILABLE: this system never
       writes such a payload, and it proves nothing either way.
    4. It is filed under the record it describes. No → MISMATCH.
    5. The live record still rebuilds to it.      No → MISMATCH.
    6. Deep: the files it binds, version by version (document_evidence).

Completeness (what the anchor recorded about the five documents) and openings are
reported beside `status` and never change it: a genuine record of a missing
document is genuine. Results never hold a bid count, a salt or a private value,
because this result is also served to the public.

award-document/3 has no schema until Phase 6, so it reads as unsupported, as does
any kind that is not an anchor payload (bid-leaf/3 and award-private/3 are openings).
"""
import logging

from . import document_evidence, openings, payload_v3
from .canonical import NonCanonicalPayload, hash_payload
from .models import CommitmentOpening

logger = logging.getLogger(__name__)

MATCH = "match"
MISMATCH = "mismatch"
UNAVAILABLE = "unavailable"
SKIPPED = "skipped"

OPENINGS_NONE = "none"             # nothing to check: this payload has no commitments
OPENINGS_INCOMPLETE = "incomplete"  # some commitment has no opening stored

ALTERED = "This record has been altered since it was recorded on-chain."
TOTAL_DOCUMENTS = len(payload_v3.DOCUMENT_KEYS)


# ── Completeness (design section 6.1) ────────────────────────────────────────

def _completeness(status, label, **extra):
    return {"status": status, "label": label, **extra}


def completeness(payload):
    """What this anchor recorded about the five documents. Read from the payload
    alone: a file missing from storage today never changes it."""
    if not isinstance(payload, dict) or not payload:
        return _completeness("unknown", "NOT KNOWN: no payload is stored")
    version = payload.get("v", 1)
    if type(version) is int and version in (1, 2):  # noqa: E721
        return _completeness("not_recorded", "NOT RECORDED (legacy)")
    if version != payload_v3.VERSION or type(version) is not int:  # noqa: E721
        return _completeness("unknown", "NOT KNOWN: unsupported payload version")
    kind = payload.get("kind")
    if kind == payload_v3.KIND_EVALUATION:
        return _completeness("not_applicable", "NOT APPLICABLE")
    if kind != payload_v3.KIND_PROJECT_STAGE:
        return _completeness("unknown", "NOT KNOWN: unsupported payload kind")
    try:
        payload_v3.validate_project_stage(payload)
    except NonCanonicalPayload:
        return _completeness("unknown", "NOT KNOWN: the payload is outside its schema")
    states = {key: entry["state"] for key, entry in payload["documents"].items()}
    absent = sorted(k for k, s in states.items() if s == payload_v3.STATE_ABSENT)
    unreadable = sorted(k for k, s in states.items() if s == payload_v3.STATE_UNREADABLE)
    present = TOTAL_DOCUMENTS - len(absent) - len(unreadable)
    counts = {"present": present, "total": TOTAL_DOCUMENTS, "absent": absent, "unreadable": unreadable}
    if unreadable:  # takes precedence over absent
        return _completeness("unreadable_when_recorded", "INCOMPLETE: UNREADABLE WHEN RECORDED", **counts)
    if absent:
        return _completeness("incomplete", f"INCOMPLETE: {present} of {TOTAL_DOCUMENTS} present", **counts)
    return _completeness("complete", "COMPLETE", **counts)


# ── The reader ───────────────────────────────────────────────────────────────

def verify(anchor, record, *, deep=False):
    """verify_anchor's result for a v3 anchor. May raise on a database failure:
    verify_anchor reports that as "could not be checked"."""
    payload = anchor.payload
    result = {
        "status": UNAVAILABLE, "record": UNAVAILABLE, "document": SKIPPED, "detail": "",
        "completeness": completeness(payload),
        "document_evidence": document_evidence.not_applicable() if deep else document_evidence.not_checked(),
    }

    if hash_payload(payload) != anchor.data_hash:
        return _finish(result, MISMATCH, ALTERED)

    reader = _READERS.get(payload.get("kind"))
    if reader is None:
        result["reason"] = "unsupported_kind"
        result["detail"] = "This record uses payload version 3 in a kind this server can't read yet, so it can't be checked here."
        return result
    return reader(anchor, record, payload, result, deep)


def _finish(result, record_state, detail=""):
    """Set the record check and the worst overall status."""
    result["record"] = record_state
    if detail and not result["detail"]:
        result["detail"] = detail
    checks = [record_state] + ([result["document"]] if result["document"] != SKIPPED else [])
    result["status"] = (MISMATCH if MISMATCH in checks else UNAVAILABLE if UNAVAILABLE in checks else MATCH)
    return result


def _out_of_schema(result):
    result["reason"] = "schema_invalid"
    result["detail"] = "This record's payload is outside its schema, so it can't be checked here."
    return result


def _deep_document_state(evidence):
    """The aggregate evidence as verify_anchor's `document` value."""
    if evidence["state"] == document_evidence.MISMATCH:
        return MISMATCH
    if evidence["state"] == document_evidence.MATCH:
        return MATCH
    if evidence["state"] == document_evidence.NOT_APPLICABLE:
        return SKIPPED
    return UNAVAILABLE


_DOCUMENT_DETAIL = {
    MISMATCH: "A document version no longer matches the fingerprint recorded for it.",
    UNAVAILABLE: "At least one recorded document version could not be checked.",
}


def _read_project_stage(anchor, project, payload, result, deep):
    try:
        payload_v3.validate_project_stage(payload)
    except NonCanonicalPayload:
        return _out_of_schema(result)

    described = (payload["entity"], payload["code"], payload["stage"], payload["document_hash"])
    if described != (anchor.entity_type, anchor.entity_ref, anchor.stage, anchor.document_hash or ""):
        return _finish(result, MISMATCH, ALTERED)

    # The live record, with the manifest this anchor recorded: a document replaced
    # later moves the next stage's manifest, never this one.
    try:
        rebuilt = payload_v3.project_payload(project, payload["stage"], payload["documents"])
        record_ok = hash_payload(rebuilt) == anchor.data_hash
    except NonCanonicalPayload:   # the live record no longer even fits the schema
        record_ok = False

    if deep:
        evidence = document_evidence.check_manifest(project, payload["documents"])
        result["document_evidence"] = evidence
        result["document"] = _deep_document_state(evidence)
        if not record_ok:
            return _finish(result, MISMATCH, ALTERED)
        return _finish(result, MATCH, _DOCUMENT_DETAIL.get(result["document"], ""))
    return _finish(result, MATCH if record_ok else MISMATCH, "" if record_ok else ALTERED)


def _check_bid_openings(anchor, project, leaves, *, deep):
    """(openings state, record still matches?, quotation states). A lost key leaves
    the state "unavailable" and the record check on what could still be compared."""
    rows = list(anchor.openings.filter(kind=CommitmentOpening.Kind.BID_LEAF))
    bids = {bid.pk: bid for bid in project.bids.all()}
    if {row.commitment for row in rows} - set(leaves):
        return openings.MISMATCH, True, []     # an opening for something not committed to

    state = openings.MATCH if len(rows) == len(leaves) else OPENINGS_INCOMPLETE
    record_ok = True
    quotations = []
    for row in rows:
        verdict = openings.check_opening(row)
        if verdict == openings.MISMATCH:
            return openings.MISMATCH, record_ok, quotations
        if verdict == openings.UNAVAILABLE:
            state = openings.UNAVAILABLE
            continue
        opening = openings.decrypt_opening(row)   # compared here; never returned to a caller
        bid = bids.get(opening["bid_id"])
        try:
            same = bid is not None and hash_payload(
                payload_v3.bid_leaf_opening(bid, opening["document_hash"], opening["salt"])) == row.commitment
        except NonCanonicalPayload:
            same = False
        record_ok = record_ok and same
        if deep and bid is not None and opening["document_hash"]:
            quotations.append(document_evidence.read_hash(bid.quotation_document) + (opening["document_hash"],))
    return state, record_ok, quotations


def _quotation_evidence(quotations):
    """One entry for all the bids together: per-bid entries would publish how many
    there were (design section 3, "bid count after award: never public")."""
    if not quotations:
        return document_evidence.not_applicable()
    states = {failure or (document_evidence.MATCH if sha256 == expected else document_evidence.MISMATCH)
              for failure, sha256, expected in quotations}
    worst = next(state for state in document_evidence.SEVERITY if state in states)
    return document_evidence.summary([{"key": "bid_quotations", "version": None, "state": worst,
                                       "detail": document_evidence.STATE_TEXT[worst]}])


def _read_evaluation(anchor, project, payload, result, deep):
    try:
        payload_v3.validate_evaluation(payload)
    except NonCanonicalPayload:
        return _out_of_schema(result)

    if (payload["entity"], payload["code"], payload["stage"]) != (anchor.entity_type, anchor.entity_ref, anchor.stage):
        return _finish(result, MISMATCH, ALTERED)
    # Checkable without any key: an added or removed bid changes the count.
    count_ok = project.bids.count() == payload["bid_count"]

    state, leaves_ok, quotations = _check_bid_openings(anchor, project, payload["leaves"], deep=deep)
    result["openings"] = state
    if deep:
        evidence = _quotation_evidence(quotations)
        result["document_evidence"] = evidence
        result["document"] = _deep_document_state(evidence)
    if not (count_ok and leaves_ok):
        return _finish(result, MISMATCH, ALTERED)
    return _finish(result, MATCH, _DOCUMENT_DETAIL.get(result["document"], ""))


_READERS = {
    payload_v3.KIND_PROJECT_STAGE: _read_project_stage,
    payload_v3.KIND_EVALUATION: _read_evaluation,
}
