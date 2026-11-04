"""The five procurement documents: their fingerprints and their history.

A project document is replaced in place (resubmit-documents), so without this
nothing remembers which bytes an earlier stage saw. Storage keeps the old file
(names are random and nothing deletes them); a ProjectDocumentVersion row records
its stored name and hash. `version` counts distinct contents: 1 for the first
known file, plus 1 each time different bytes replace it.

History starts from the files on record the first time a project passes through
here. Anything overwritten before that is gone, and is not reconstructed.

Superseded files are private: no serializer or file route exposes these rows.
"""
import hashlib
import logging

from django.db import transaction
from django.db.models.fields.files import FieldFile

from .models import PROCUREMENT_DOCUMENT_KEYS, Project, ProjectDocumentVersion
from .payload_v3 import STATE_ABSENT, STATE_PRESENT, STATE_UNREADABLE

logger = logging.getLogger(__name__)


def document_state(field_file):
    """(state, sha256) of one document's stored bytes.

    Unlike blockchain.hash_file, which returns "" for both, a document that was
    never uploaded and one that storage can't read stay different things: the
    first is a fact about the procurement, the second about the infrastructure.

    Always reads through a fresh handle: right after an upload the field still
    holds the uploaded object, and the hash must be of what storage has."""
    if not field_file:
        return STATE_ABSENT, ""
    digest = hashlib.sha256()
    stored = FieldFile(field_file.instance, field_file.field, field_file.name)
    try:
        stored.open("rb")
        try:
            for chunk in stored.chunks():
                digest.update(chunk)
        finally:
            stored.close()
    except Exception:  # noqa: BLE001 — any storage failure means "unreadable", never "absent"
        logger.warning("Could not read document %r of project %s", field_file.name, field_file.instance.pk)
        return STATE_UNREADABLE, ""
    return STATE_PRESENT, "0x" + digest.hexdigest()


def snapshot_documents(project):
    """{key: (stored name, original name)} of the files on record now. Taken
    before a replacement, because afterwards nothing remembers the old name."""
    names = project.original_filenames or {}
    return {
        key: (getattr(project, key).name, names.get(key, ""))
        for key in PROCUREMENT_DOCUMENT_KEYS if getattr(project, key)
    }


def _capture(project, key, name, original_filename, user):
    """Make sure the file stored as `name` is in `key`'s history. Returns
    (state, sha256, its version row).

    Compared with the LATEST version only: going back to earlier bytes is a new
    change of the document, so A, B, A is three versions. An unreadable file
    still gets a row, with no hash, so its stored name isn't lost; the same
    stored name later counts as that row rather than as a new version."""
    field_file = FieldFile(project, Project._meta.get_field(key), name)
    state, sha256 = document_state(field_file)
    latest = ProjectDocumentVersion.objects.filter(project=project, key=key).order_by("-version").first()
    if latest is not None:
        same = sha256 == latest.sha256 if (sha256 and latest.sha256) else name == latest.file.name
        if same:
            return state, sha256, latest
    with transaction.atomic():
        row = ProjectDocumentVersion.objects.create(
            project=project, project_code=project.code, key=key,
            version=(latest.version if latest is not None else 0) + 1,
            file=name, original_filename=original_filename, sha256=sha256,
            uploaded_by=user if getattr(user, "is_authenticated", False) else None,
        )
    return state, sha256, row


def record_project_document_versions(project, *, keys=None, user=None, previous=None):
    """Keep `project`'s current files as versions; call after they are saved.

    `previous` is the snapshot_documents() taken before a replacement, so a
    project with no history yet keeps the file being replaced. Its uploader isn't
    known, so that row names nobody.

    Never raises: like anchoring, history-keeping must not turn a successful
    action into an error. A failure is logged and retried at the next pass."""
    names = project.original_filenames or {}
    for key in keys if keys is not None else PROCUREMENT_DOCUMENT_KEYS:
        try:
            if previous and key in previous:
                _capture(project, key, *previous[key], None)
            current = getattr(project, key)
            if current:
                _capture(project, key, current.name, names.get(key, ""), user)
        except Exception:  # noqa: BLE001 — must never break the action itself
            logger.exception("Could not keep version history for %s of project %s", key, project.pk)


def document_manifest(project):
    """The `documents` object of a project-stage/3 payload, with the history
    brought up to date first. May raise (a database failure): the anchoring
    caller treats that as "no anchor yet", which is retryable."""
    names = project.original_filenames or {}
    manifest = {}
    for key in PROCUREMENT_DOCUMENT_KEYS:
        current = getattr(project, key)
        if not current:
            manifest[key] = {"state": STATE_ABSENT, "sha256": "", "version": 0}
            continue
        state, sha256, row = _capture(project, key, current.name, names.get(key, ""), None)
        manifest[key] = {"state": state, "sha256": sha256, "version": row.version}
    return manifest
