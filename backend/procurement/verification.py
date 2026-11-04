"""What the server can honestly say about one record, in one result.

verify_anchor compares the database with the anchor. It says nothing about the
chain, and blockchain.confirm_anchor says nothing about the database. This combines
them into one of five outcomes, the same five the browser's independent check uses
(frontend/src/blockchain/packetVerify.js), and says what was checked and what wasn't:

    verified       every check that ran agreed, and the server read the transaction
    hash_mismatch  a recomputed hash disagrees with the recorded one
    not_found      evidence that should exist does not (MISSING EVIDENCE)
    unconfirmed    evidence exists but can't be read, or is incomplete
    invalid_tx     a reported transaction failed, or does not record this entry

A tx_hash alone is never verified. This is the SERVER's account of itself, so it
is never styled as proof: only the browser's own check may show green, and only for a
document a visitor selected. The server never sees that file (it is hashed in the
browser), so `verified` here can't mean any document was checked by the person
reading it, and the headline says so.
"""
from .blockchain import (
    MISMATCH,
    SUPERSEDED,
    UNAVAILABLE,
    _is_hex32,
    hash_payload,
)
from .document_evidence import MISSING_STATES, NOT_CHECKED, UNAVAILABLE_STATES
from .document_evidence import MISMATCH as FILE_MISMATCH
from .models import PROCUREMENT_DOCUMENT_FIELDS, BlockchainAnchor
from .openings import MATCH as OPENING_MATCH
from .openings import MISMATCH as OPENING_MISMATCH

VERIFIED = "verified"
HASH_MISMATCH = "hash_mismatch"
NOT_FOUND = "not_found"
UNCONFIRMED = "unconfirmed"
INVALID_TX = "invalid_tx"

OUTCOME_LABELS = {
    VERIFIED: "Verified",
    HASH_MISMATCH: "Mismatch",
    NOT_FOUND: "Missing evidence",
    UNCONFIRMED: "Unavailable or incomplete evidence",
    INVALID_TX: "Invalid transaction",
}
OUTCOME_TONES = {
    VERIFIED: "info", HASH_MISMATCH: "bad", NOT_FOUND: "warn", UNCONFIRMED: "warn", INVALID_TX: "bad",
}

INCOMPLETE_STATES = frozenset({"incomplete", "unreadable_when_recorded"})
_FAILED_TX = {
    BlockchainAnchor.ChainStatus.MISMATCH: "The reported transaction does not record this entry.",
    BlockchainAnchor.ChainStatus.REVERTED: "The last transaction reported for this record failed on-chain.",
    BlockchainAnchor.ChainStatus.DROPPED: "The last transaction reported for this record was never mined.",
}


DOCUMENT_LABELS = {key: label for key, label, _ in PROCUREMENT_DOCUMENT_FIELDS}


def incomplete_headline(completeness):
    """"MATCH — INCOMPLETE EVIDENCE (4 of 5 present; missing: ...)". The fingerprint
    is genuine, and the word Verified is deliberately absent: this outcome is
    `unconfirmed`. frontend/src/blockchain/payloadV3.js builds the same text."""
    label = lambda keys: ", ".join(DOCUMENT_LABELS.get(key, key) for key in keys)  # noqa: E731
    parts = [f"{completeness['present']} of {completeness['total']} present"]
    if completeness["unreadable"]:
        parts.append(f"unreadable when recorded: {label(completeness['unreadable'])}")
    if completeness["absent"]:
        parts.append(f"missing: {label(completeness['absent'])}")
    return f"MATCH — INCOMPLETE EVIDENCE ({'; '.join(parts)})"


def legacy_document_history(integrity, completeness):
    """A v1/v2 anchor whose file on record no longer matches it. verify_anchor's result
    stands, frozen: `mismatch` means "the file on record NOW differs". That is what a
    normal revision does too, so this says what the version evidence adds, and only
    `tamper_indicated` when it supports that conclusion. None when it doesn't apply
    (the deep check didn't run, or the record itself no longer matches)."""
    if completeness.get("status") != "not_recorded" or integrity["record"] != "match" \
            or integrity["document"] != MISMATCH:
        return None
    entries = (integrity.get("document_evidence") or {}).get("entries") or []
    entry = entries[0] if entries else {}
    state, version = entry.get("state"), entry.get("version")
    if state == "match":
        kind, explanation = "later_revision", (
            f"The exact version this step recorded (version {version}) is still kept and matches its fingerprint, "
            "so the file on record now is a later version. On its own this is not evidence of tampering.")
    elif state == FILE_MISMATCH and version is not None:
        kind, explanation = "kept_version_differs", (
            f"The kept copy of the version this step recorded (version {version}) no longer matches its "
            "fingerprint. Its bytes have changed since they were recorded.")
    elif state == FILE_MISMATCH:
        kind, explanation = "no_version_history", (
            "This document has no version history, so the evidence can't show whether the replacement was allowed.")
    elif state == "version_absent":
        kind, explanation = "version_not_kept", (
            "The version this step recorded was not kept, so the evidence can't show whether the file on record now "
            "is a normal revision or an unauthorized replacement.")
    else:
        kind, explanation = "version_not_checked", (
            "The version this step recorded could not be checked, so the evidence can't show whether the file on "
            "record now is a normal revision.")
    return {"kind": kind, "original_result": MISMATCH, "original_detail": integrity.get("detail", ""),
            "version": version, "explanation": explanation, "tamper_indicated": kind == "kept_version_differs"}


HISTORY_HEADLINES = {
    "later_revision": "Mismatch — current file is a later revision; the recorded version is intact",
    "kept_version_differs": "Mismatch — the kept copy of the recorded version has changed",
    "no_version_history": "Mismatch — current file differs; this document has no version history",
    "version_not_kept": "Mismatch — current file differs; the recorded version was not kept",
    "version_not_checked": "Mismatch — current file differs; the recorded version could not be checked",
}


def _check(key, label, status, detail):
    return {"key": key, "label": label, "status": status, "detail": detail}


def _transaction_check(anchor):
    """(status, detail). A hash that isn't even shaped like one is invalid as well."""
    failed = _FAILED_TX.get(anchor.chain_status)
    if failed:
        return "fail", failed
    if anchor.tx_hash and not _is_hex32(anchor.tx_hash):
        return "fail", "The reported transaction hash is malformed."
    if not anchor.tx_hash:
        return "missing", "No transaction has been reported: this record is not on the blockchain yet."
    if anchor.verified_on_chain:
        return "pass", "The server read this transaction from Sepolia and found this exact record in it."
    return "unavailable", "A transaction was reported, but the server has not confirmed it. A hash alone proves nothing."


def _payload_check(anchor):
    payload = anchor.payload
    if not isinstance(payload, dict) or not payload:
        return "missing", "The payload for this record was not stored, so its fingerprint can't be recomputed."
    if hash_payload(payload) != anchor.data_hash:
        return "fail", "The stored payload does not reproduce the recorded fingerprint."
    return "pass", "The stored payload reproduces the recorded fingerprint."


def _outcome(*, integrity, payload_status, tx_status, evidence_state, opening_state, completeness_status):
    # verify_anchor reports an empty payload as a mismatch, as it always has. Here
    # that is missing evidence: no hash could be compared, so none disagreed.
    if payload_status == "missing":
        return NOT_FOUND
    if integrity["status"] == MISMATCH or payload_status == "fail" or evidence_state == FILE_MISMATCH \
            or opening_state == OPENING_MISMATCH:
        return HASH_MISMATCH
    if tx_status == "fail":
        return INVALID_TX
    if tx_status == "missing" or integrity.get("reason") == "record_gone" \
            or evidence_state in MISSING_STATES:
        return NOT_FOUND
    if integrity["status"] == UNAVAILABLE or tx_status == "unavailable" or evidence_state in UNAVAILABLE_STATES \
            or (opening_state and opening_state not in {OPENING_MATCH, "none"}) \
            or completeness_status in INCOMPLETE_STATES:
        return UNCONFIRMED
    return VERIFIED


# "By the server" because that is all it can know: a file a visitor selects is hashed in
# their browser, and can be verified on the same page while this stays true.
RECORD_ONLY_HEADLINE = "RECORD MATCH — DOCUMENT NOT CHECKED BY THE SERVER"


def _headline(outcome, integrity_ok, completeness, history, evidence_state):
    status = completeness.get("status")
    if history is not None:
        return HISTORY_HEADLINES[history["kind"]]
    if outcome == UNCONFIRMED and integrity_ok and status in INCOMPLETE_STATES:
        return incomplete_headline(completeness)
    if outcome == VERIFIED and status == "complete":
        return ("RECORD MATCH — KEPT DOCUMENTS RE-READ BY THE SERVER"
                if evidence_state == "match" else RECORD_ONLY_HEADLINE)
    if outcome == VERIFIED and status == "not_applicable":
        return "RECORD MATCH — NO DOCUMENT BOUND"
    if outcome == VERIFIED and status == "not_recorded":
        return "VERIFIED — LEGACY RECORD (v1 or v2)"
    return OUTCOME_LABELS[outcome]


def summarize(anchor, integrity):
    """The outcome for this anchor, given verify_anchor's result for it."""
    completeness = integrity.get("completeness") or {}
    evidence = integrity.get("document_evidence") or {}
    evidence_state = evidence.get("state", NOT_CHECKED)
    opening_state = integrity.get("openings")
    payload_status, payload_detail = _payload_check(anchor)
    tx_status, tx_detail = _transaction_check(anchor)

    record_status = {"match": "pass", SUPERSEDED: "pass", MISMATCH: "fail"}.get(integrity["record"], "unavailable")
    checked = [
        _check("fingerprint", "Stored payload reproduces the fingerprint", payload_status, payload_detail),
        _check("record", "Record still matches what was recorded", record_status,
               integrity.get("detail") or "The record rebuilds to the recorded fingerprint."),
        _check("transaction", "Transaction recorded this entry", tx_status, tx_detail),
    ]
    if evidence.get("checked"):
        checked.append(_check("document", "Document version re-read from storage",
                              "pass" if evidence_state == "match" else "fail" if evidence_state == FILE_MISMATCH
                              else "not_applicable" if evidence_state == "not_applicable" else "unavailable",
                              "; ".join(sorted({e["detail"] for e in evidence["entries"]})) or "Nothing to re-read."))
    if opening_state and opening_state != "none":
        checked.append(_check(
            "opening", "Private details reproduce their commitment",
            "pass" if opening_state == OPENING_MATCH else "fail" if opening_state == OPENING_MISMATCH
            else "unavailable", {
                OPENING_MATCH: "The private details behind this commitment still reproduce it.",
                OPENING_MISMATCH: "An opening does not match the commitment.",
            }.get(opening_state, "Opening unavailable: the private details could not be checked. "
                                 "The public fields are unaffected.")))

    unverified = ["This is the server's own account. Only the independent check in your browser reads the "
                  "ledger without trusting this server."]
    if evidence_state == NOT_CHECKED:
        unverified.append("The stored files were not re-read for this answer.")
    status = completeness.get("status")
    if status == "not_recorded":
        unverified.append("Legacy record: checked under its original rules; one document per step; "
                          "five-document completeness was not checked.")
    elif status in INCOMPLETE_STATES:
        names = ", ".join(DOCUMENT_LABELS.get(key, key) for key in completeness["absent"] + completeness["unreadable"])
        unverified.append("The fingerprint is genuine; it records that these documents were missing when this "
                          f"step was taken: {names}.")

    outcome = _outcome(integrity=integrity, payload_status=payload_status, tx_status=tx_status,
                       evidence_state=evidence_state, opening_state=opening_state, completeness_status=status)
    history = legacy_document_history(integrity, completeness)
    return {
        "outcome": outcome,
        "label": OUTCOME_LABELS[outcome],
        "headline": _headline(outcome, integrity["status"] == "match" and tx_status == "pass", completeness, history,
                              evidence_state),
        # Only the browser's check, on a file a visitor selected, may ever be green.
        "green": False,
        # Only the tone is softer for a revision: the outcome stays the frozen result.
        "tone": "warn" if history is not None and not history["tamper_indicated"] else OUTCOME_TONES[outcome],
        "historical": history,
        "source": "server",
        "checked": checked,
        "unverified": unverified,
    }
