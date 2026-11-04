"""Document versions: which file each blockchain record vouches for, and every
issue of that document over time.

A record (anchor) binds ONE document slot — e.g. the Award's Notice of Award, or
the Project's Purchase Request (blockchain.STAGE_DOCUMENT_FIELD). The slot's
versions are its anchors, in the order they were written: re-issuing appends a
new anchor and never edits an old one, so the trail itself is the version
history. For post-award documents, AwardDocumentVersion rows add the one thing
the anchors can't: where each issue's exact file still is.

Files are offered only through files.py, under its existing rules — a version
row is readable by exactly whoever may read that Award's document.
"""
import logging

from django.db import IntegrityError, transaction

from .blockchain import AWARD_OWN_DOCUMENT_STAGES, STAGE_DOCUMENT_FIELD, _iso, hash_file
from .models import (
    AWARD_DOCUMENT_FIELDS,
    AWARD_DOCUMENT_ISSUED_FIELDS,
    BID_DOCUMENT_FIELDS,
    PROCUREMENT_DOCUMENT_FIELDS,
    AwardDocumentVersion,
    BlockchainAnchor,
)

logger = logging.getLogger(__name__)

DOCUMENT_LABELS = {
    **{key: label for key, label, _ in PROCUREMENT_DOCUMENT_FIELDS},
    **{key: label for key, label, _ in BID_DOCUMENT_FIELDS},
    **{key: label for key, label, _, _ in AWARD_DOCUMENT_FIELDS},
}
AWARD_KEY_BY_STAGE = {stage: key for key, _, stage, _ in AWARD_DOCUMENT_FIELDS}


# ── Recording an issue ───────────────────────────────────────────────────────

def record_award_document_version(award, key, anchor, *, generated, user=None):
    """Keep the issue just saved on `award.<key>` as a version. Called right
    after the file is saved and anchored. Returns the row, or None.

    Never raises: like anchoring, history-keeping must not turn a successful
    issue into an error — a failure is logged loudly instead."""
    try:
        field_file = getattr(award, key)
        if not field_file:
            return None
        issued_at = getattr(award, AWARD_DOCUMENT_ISSUED_FIELDS[key])
        # The anchor already hashed these bytes; reuse it rather than read the
        # file twice. Without an anchor (anchoring off or failed), hash here.
        document_hash = anchor.document_hash if anchor is not None else hash_file(field_file)
        stage = dict((k, s) for k, _, s, _ in AWARD_DOCUMENT_FIELDS)[key]
        prior_issues = max(
            AwardDocumentVersion.objects.filter(award=award, key=key).count(),
            BlockchainAnchor.objects.filter(
                entity_type=BlockchainAnchor.EntityType.AWARD, entity_id=str(award.id), stage=stage,
                **({"id__lt": anchor.id} if anchor is not None else {})).count(),
        )
        with transaction.atomic():
            return AwardDocumentVersion.objects.create(
                award=award, key=key, version=prior_issues + 1,
                file=field_file.name,                       # the stored bytes, not a copy
                original_filename=(award.original_filenames or {}).get(key, ""),
                document_hash=document_hash, issued_at=issued_at, generated=generated,
                anchor=anchor, issued_by=user if getattr(user, "is_authenticated", False) else None,
            )
    except IntegrityError:
        logger.exception("Version number clash keeping %s of award %s", key, award.id)
    except Exception:  # noqa: BLE001 — must never break the issue itself
        logger.exception("Could not keep version history for %s of award %s", key, award.id)
    return None


# ── Listing a record's document versions ─────────────────────────────────────

def document_slot(anchor):
    """(field, label) of the document this anchor fingerprints, or (None, None)
    for a record without one (the evaluation commitment)."""
    field = STAGE_DOCUMENT_FIELD.get(anchor.stage)
    return (field, DOCUMENT_LABELS.get(field, field)) if field else (None, None)


def sibling_anchors(anchor):
    """Every anchor for the same document slot of the same record, oldest
    first — the versions of this document."""
    return list(BlockchainAnchor.objects.filter(
        entity_ref=anchor.entity_ref, entity_type=anchor.entity_type,
        entity_id=anchor.entity_id, stage=anchor.stage).order_by("id"))


def versions_for(anchor, *, file_for):
    """The version list for `anchor`'s document slot.

    `file_for(kind, record, field)` returns (url, file name) the CALLER may
    use, or (None, None) — the caller decides access (files.py rules / public
    route), this function only knows which file belongs to which issue.

    Each entry: {number, total, anchor_id, current, issued_at, document_hash,
    file_url, file_name, file_note, preserved, fingerprinted}. A version row without an anchor (the
    issue was never fingerprinted) is listed too, with anchor_id None."""
    field, _ = document_slot(anchor)
    if field is None:
        return []
    anchors = sibling_anchors(anchor)
    rows = {}
    award = None
    if anchor.entity_type == BlockchainAnchor.EntityType.AWARD and anchor.stage in AWARD_OWN_DOCUMENT_STAGES:
        key = AWARD_KEY_BY_STAGE[anchor.stage]
        from .models import Award
        award = Award.objects.filter(pk=anchor.entity_id or 0).select_related("project", "supplier").first()
        if award is not None:
            rows = {v.anchor_id: v for v in award.document_versions.filter(key=key)}

    entries = [{"anchor": a, "row": rows.pop(a.id, None)} for a in anchors]
    # Issues kept as files but never anchored (anchoring off or failed).
    entries += [{"anchor": None, "row": r} for r in rows.values()]

    def when(e):
        if e["row"] is not None:
            return _iso(e["row"].issued_at) or ""
        payload = e["anchor"].payload or {}
        return payload.get("issued_at") or _iso(e["anchor"].created_at)
    entries.sort(key=when)

    out = []
    total = len(entries)
    for i, e in enumerate(entries, start=1):
        a, row = e["anchor"], e["row"]
        payload = (a.payload or {}) if a is not None else {}
        latest = i == total
        url, name, note, preserved = None, None, "", False
        if row is not None:
            preserved = True
            url, name = file_for("awardversion", row, "file")
            note = "" if url else "You do not have access to this file."
        elif latest:
            url, name, note = _current_file(anchor, award, field, payload, file_for)
        else:
            note = ("This issue was replaced before version history was kept, so its file is not "
                    "preserved here. Verify it with a copy you already hold.")
        out.append({
            "number": i,
            "total": total,
            "anchor_id": a.id if a is not None else None,
            "current": latest,
            "issued_at": row.issued_at if row is not None else (payload.get("issued_at") or a.created_at),
            "document_hash": row.document_hash if row is not None else (a.document_hash or ""),
            "file_url": url,
            "file_name": name,
            "file_note": note,
            "preserved": preserved,
            "fingerprinted": a is not None,
        })
    return out


def _current_file(anchor, award, field, payload, file_for):
    """The file currently on record, for the newest issue that has no version
    row. For an award document it is only offered when its issue date still
    equals the one this anchor hashed — otherwise it is a different issue."""
    if award is not None:
        issued_field = AWARD_DOCUMENT_ISSUED_FIELDS[field]
        if not getattr(award, field, None):
            return None, None, "No file is stored for this document."
        if payload.get("issued_at") != _iso(getattr(award, issued_field, None)):
            return None, None, "The file on record no longer belongs to this issue."
        url, name = file_for("award", award, field)
        return url, name, "" if url else "You do not have access to this file."
    record = _record_for(anchor)
    if record is None:
        return None, None, "The record this document belongs to no longer exists."
    if not getattr(record, field, None):
        return None, None, "No file is stored for this document."
    url, name = file_for(_KIND[type(record).__name__], record, field)
    if not url:
        return None, None, "You do not have access to this file."
    return url, name, ("The file currently on record. If it was replaced after this step was recorded, "
                       "it will not match.")


# files.py kind for the row a slot's file lives on (an AWARDED record's
# document is the winning BID's quotation, so it is served as a bid file).
_KIND = {"Project": "project", "Bid": "bid", "Award": "award"}


def _record_for(anchor):
    """The row whose file the anchor's slot lives on (AWARDED → winning bid)."""
    from .models import Award, Bid, Project
    if anchor.entity_type == BlockchainAnchor.EntityType.PROJECT:
        return Project.objects.filter(code=anchor.entity_ref).first()
    if anchor.entity_type == BlockchainAnchor.EntityType.BID:
        return Bid.objects.filter(pk=anchor.entity_id or 0).select_related("supplier").first()
    award = Award.objects.filter(pk=anchor.entity_id or 0).select_related("bid__supplier").first()
    return award.bid if award is not None else None
