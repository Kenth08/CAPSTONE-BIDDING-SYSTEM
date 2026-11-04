"""Is the exact file a record fingerprinted still here, and still those bytes?

blockchain.hash_file answers one question about the file on record NOW, and gives
"" for every kind of failure. Neither is enough once a document has versions: an
anchor vouches for one version, which may have been legitimately replaced since,
and "the version was never kept", "the file is gone", "storage is down" and "the
bytes differ" call for very different reactions. Only the last is evidence of
tampering, so only the last may be reported as a mismatch.

Read-only: nothing here writes a row, captures a version or fixes anything.
Results hold a state and a version number, never a stored file name or a hash,
so the same shape is safe for every viewer of the anchor.
"""
import hashlib
import logging

from django.db.models.fields.files import FieldFile

from .models import AwardDocumentVersion, ProjectDocumentVersion
from .payload_v3 import STATE_ABSENT, STATE_PRESENT, STATE_UNREADABLE

logger = logging.getLogger(__name__)

MATCH = "match"
MISMATCH = "mismatch"                        # the bytes differ: the only tampering signal
VERSION_ABSENT = "version_absent"            # no copy of that version was ever kept
FILE_MISSING = "file_missing"                # a version is on record, storage has no such file
FILE_UNREADABLE = "file_unreadable"          # storage answered, but the bytes couldn't be read
STORAGE_INACCESSIBLE = "storage_inaccessible"  # storage could not be reached or refused access
CURRENT_UNTRACKED = "current_file_untracked"   # the file on record now is in no recorded version
ABSENT_WHEN_RECORDED = "absent_when_recorded"  # a fact the anchor recorded; see completeness
UNREADABLE_WHEN_RECORDED = "unreadable_when_recorded"
NOT_CHECKED = "not_checked"                  # the deep check was not asked for
NOT_APPLICABLE = "not_applicable"            # this record binds no document

# Worst first: one aggregate state for a record that binds several files.
SEVERITY = (MISMATCH, VERSION_ABSENT, FILE_MISSING, STORAGE_INACCESSIBLE, FILE_UNREADABLE, CURRENT_UNTRACKED, MATCH)
MISSING_STATES = frozenset({VERSION_ABSENT, FILE_MISSING})
UNAVAILABLE_STATES = frozenset({STORAGE_INACCESSIBLE, FILE_UNREADABLE, CURRENT_UNTRACKED})

STATE_TEXT = {
    MATCH: "The kept copy of this version hashes to the recorded fingerprint.",
    MISMATCH: "The kept copy of this version does not hash to the recorded fingerprint.",
    VERSION_ABSENT: "No copy of this version was kept, so it can only be checked against a copy you already hold.",
    FILE_MISSING: "This version is on record, but its file is no longer in storage.",
    FILE_UNREADABLE: "This version's file exists, but it could not be read.",
    STORAGE_INACCESSIBLE: "Storage could not be reached, so this version was not checked.",
    CURRENT_UNTRACKED: "The file on record now is not in this document's history, so it can't be traced to a "
                       "recorded version.",
    ABSENT_WHEN_RECORDED: "No file had been uploaded when this step was recorded.",
    UNREADABLE_WHEN_RECORDED: "Storage could not read this file when this step was recorded, so no fingerprint "
                              "was taken.",
}


def not_checked():
    return {"checked": False, "state": NOT_CHECKED, "entries": []}


def not_applicable():
    return {"checked": False, "state": NOT_APPLICABLE, "entries": []}


def summary(entries):
    """One aggregate over `entries`. Files the anchor itself recorded as absent or
    unreadable had nothing to compare, so they never count as checked."""
    states = {e["state"] for e in entries} | {e.get("current_file") for e in entries}
    worst = next((state for state in SEVERITY if state in states), NOT_APPLICABLE)
    return {"checked": True, "state": worst, "entries": entries}


def _is_outage(exc):
    """A failure of the storage service, as opposed to of this one file."""
    if isinstance(exc, (PermissionError, ConnectionError, TimeoutError)):
        return True
    return type(exc).__module__.split(".")[0] in {"botocore", "boto3", "urllib3", "requests"}


def read_hash(field_file):
    """(failure state or None, sha256) of the stored bytes. Reads through a fresh
    handle, and never raises."""
    if not field_file:
        return FILE_MISSING, ""
    stored = FieldFile(field_file.instance, field_file.field, field_file.name)
    try:
        stored.open("rb")
    except FileNotFoundError:
        return FILE_MISSING, ""
    except Exception:  # noqa: BLE001 — opening is the first contact with storage
        logger.warning("Could not reach document %r in storage", field_file.name)
        return STORAGE_INACCESSIBLE, ""
    digest = hashlib.sha256()
    try:
        for chunk in stored.chunks():
            digest.update(chunk)
    except FileNotFoundError:
        return FILE_MISSING, ""
    except Exception as exc:  # noqa: BLE001 — reported, never raised
        logger.warning("Could not read document %r from storage", field_file.name)
        return (STORAGE_INACCESSIBLE if _is_outage(exc) else FILE_UNREADABLE), ""
    finally:
        try:
            stored.close()
        except Exception:  # noqa: BLE001 — the result is already known
            pass
    return None, "0x" + digest.hexdigest()


def _compare(field_file, expected):
    failure, sha256 = read_hash(field_file)
    return failure or (MATCH if sha256 == expected else MISMATCH)


def _entry(key, version, state, **extra):
    return {"key": key, "version": version, "state": state, "detail": STATE_TEXT[state], **extra}


# ── Payload v3: every manifest entry, against the version it names ───────────

def _manifest_entry(code, key, entry):
    state, sha256, version = entry["state"], entry["sha256"], entry["version"]
    if state == STATE_ABSENT:
        return _entry(key, version, ABSENT_WHEN_RECORDED)
    if state == STATE_UNREADABLE:
        return _entry(key, version, UNREADABLE_WHEN_RECORDED)
    assert state == STATE_PRESENT  # noqa: S101 — the caller validated the schema
    row = ProjectDocumentVersion.objects.filter(project_code=code, key=key, version=version).first()
    if row is None:
        return _entry(key, version, VERSION_ABSENT)
    if row.sha256 and row.sha256 != sha256:
        return _entry(key, version, MISMATCH)
    return _entry(key, version, _compare(row.file, sha256))


def check_manifest(project, documents):
    """Each document of a project-stage/3 anchor against the version it recorded.
    A later version on the project is expected (the revision loop) and is no
    mismatch; a current file that is in NO recorded version is called out."""
    entries = []
    for key in sorted(documents):
        entry = _manifest_entry(project.code, key, documents[key])
        current = getattr(project, key, None)
        if current:
            names = ProjectDocumentVersion.objects.filter(
                project_code=project.code, key=key).values_list("file", flat=True)
            if current.name not in set(names):
                entry["current_file"] = CURRENT_UNTRACKED
        entries.append(entry)
    return summary(entries)


# ── Payloads v1 and v2: the one document each stage binds ────────────────────

def check_single_document(anchor, record, field, *, own_award_document):
    """The one file a v1/v2 anchor binds, by the best evidence there is: its version
    row, else the file on record now if that is still those bytes. Adds to
    verify_anchor's `document`, which keeps its original meaning for these
    versions: does the file on record NOW still match?"""
    expected = anchor.document_hash
    if not field or not expected:
        return not_applicable()

    row, current = None, None
    if own_award_document:
        row = (AwardDocumentVersion.objects.filter(anchor=anchor).first()
               or AwardDocumentVersion.objects.filter(
                   award=record, key=field, document_hash=expected).order_by("-version").first())
        current = getattr(record, field, None)
    elif anchor.entity_type == "PROJECT":
        row = ProjectDocumentVersion.objects.filter(
            project_code=anchor.entity_ref, key=field, sha256=expected).order_by("-version").first()
        current = getattr(record, field, None)
    else:
        # A bid's quotation has no version history: only the file on record exists.
        bid = record if anchor.entity_type == "BID" else record.bid
        current = getattr(bid, field, None) if bid is not None else None
        return summary([_entry(field, None, _compare(current, expected))])

    if row is not None:
        return summary([_entry(field, getattr(row, "version", None), _compare(row.file, expected))])
    if not current:
        return summary([_entry(field, None, VERSION_ABSENT)])
    state = _compare(current, expected)
    # The file on record was replaced and the anchored bytes were never kept: that
    # version is absent. Whether the replacement was allowed is not decided here.
    return summary([_entry(field, None, VERSION_ABSENT if state == MISMATCH else state)])
