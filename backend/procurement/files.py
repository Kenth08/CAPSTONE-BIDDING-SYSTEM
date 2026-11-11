"""Access-controlled delivery of every uploaded file.

WHY THIS EXISTS
---------------
Files are never linked directly (no MEDIA_URL, no bucket URL, no pre-signed S3
URL ever reaches the browser). A request names a record and a field; this
module resolves the FileField, decides whether *this* caller may read *that*
file, streams it, and writes an audit entry. It works identically on local disk
and on S3, so nothing here depends on which storage backend is configured.

THE RULES, IN ONE PLACE  (see `_can_read`)
------------------------------------------
    supplier registration docs  → Admin, or that supplier
    bid documents, attachments,
      product images            → Admin, or the supplier who filed the bid
    project documents
      ToR / Tech Specs /
      Bid Evaluation Criteria,
      reference image           → Admin, Head, or an eligible supplier (verified,
                                  matching category, procurement open for bids)
      Purchase Request /
      Approved Budget document  → Admin and Head only
    award documents             → Admin, Head, or the winning supplier;
                                  the Notice of Award is also PUBLIC once the
                                  procurement is awarded (`_is_public`)
    earlier award-document
      versions (awardversion)   → exactly the rule of that award's documents;
                                  never public (only the current NOA is)

Everything else — including another supplier's anything — is a 404, never a
403: whether a supplier uploaded a particular document is itself private.

HOW A BROWSER DOWNLOADS A FILE
------------------------------
A download link is a plain browser navigation, which cannot send the
`Authorization: Bearer` header this API authenticates with. So a click does two
things (frontend/src/files.js):

1. POST /api/files/<kind>/<pk>/<field>/link/ with the JWT. If the caller may
   read the file, a random token is minted and stored (hashed) for that user
   and that one file, valid for FILE_LINK_MAX_AGE_SECONDS.
2. The browser navigates to the returned URL. The token is redeemed exactly
   once; the permission check is run AGAIN for the token's user (so access
   revoked in the meantime still wins) and the download is logged.

A copied link is therefore useless: it is already spent, or it expires within
two minutes. Images shown inline are fetched by the frontend with the JWT
(GET without a token), which runs the same check and is logged the same way.
"""
import hashlib
import logging
import os
import secrets
from datetime import timedelta

from django.db import transaction
from django.http import FileResponse, Http404
from django.utils import timezone
from rest_framework import permissions
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.audit import log_action

from .models import (
    AWARD_DOCUMENT_KEYS,
    OTHERS_CATEGORY,
    BID_DOCUMENT_KEYS,
    PROCUREMENT_DOCUMENT_KEYS,
    SUPPLIER_DOCUMENT_KEYS,
    Award,
    AwardDocumentVersion,
    BACMembership,
    BACResolution,
    Bid,
    BidAttachment,
    BidProductImage,
    FileDownloadToken,
    Project,
    Supplier,
    SupplierCategoryDocument,
)
from .uploads import display_filename

logger = logging.getLogger(__name__)

# Shown only to a caller who already passed the access check, so it reveals
# nothing an unauthorized caller could learn.
MISSING_FILE_DETAIL = (
    "This document is on record but its file is missing from storage. "
    "Ask the supplier to upload it again."
)

# A download link is minted on click and used immediately, so it only needs to
# survive the redirect. Short enough that a link pasted into a chat, a ticket or
# a Referer header is dead before anyone else can use it.
FILE_LINK_MAX_AGE_SECONDS = 2 * 60

# Spent/expired tokens are kept a while as download history, then pruned.
FILE_LINK_RETENTION = timedelta(days=30)

# Only these fields can ever be addressed, per record kind. This is a strict
# allow-list, not a filter: `getattr(record, field)` on caller-supplied input
# would otherwise expose any attribute on the model.
ALLOWED_FIELDS = {
    "supplier": set(SUPPLIER_DOCUMENT_KEYS),
    # Category licenses (SupplierCategoryDocument rows), addressed by row id.
    "supplierdoc": {"file"},
    "project": set(PROCUREMENT_DOCUMENT_KEYS) | {"reference_image"},
    "bid": set(BID_DOCUMENT_KEYS),
    "award": set(AWARD_DOCUMENT_KEYS),
    # One issue of a post-award document (AwardDocumentVersion rows).
    "awardversion": {"file"},
    "attachment": {"file"},
    "bidimage": {"image"},
    # BAC Committee records (procurement/bac.py): meeting minutes and the
    # frozen resolution PDF, and the scanned designation of each seat.
    "bacresolution": {"minutes", "resolution_file"},
    "bacmembership": {"designation_document"},
}

# Project documents a bidder needs in order to prepare a bid. The Purchase
# Request and the Approved Budget document are internal approval paperwork and
# stay with the Admin and the Head (the ABC amount itself is public anyway).
SUPPLIER_VISIBLE_PROJECT_FIELDS = {
    "terms_of_reference", "technical_specifications", "bid_evaluation_criteria",
    "reference_image",
}

# Award documents the Head may read. The Head approves procurements and sees
# their outcome, but never evaluates bids or reviews supplier registrations.
HEAD_KINDS = {"project", "award", "awardversion", "bacresolution", "bacmembership"}

# What a BAC Committee member may read: the files they evaluate (bids and the
# bidders' registration documents), the procurement documents and outcome,
# and the committee's own records.
BAC_KINDS = {"project", "bid", "attachment", "bidimage", "supplier", "supplierdoc",
             "award", "awardversion", "bacresolution", "bacmembership"}


def _supplier_of(user):
    """The Supplier profile behind a user account, or None."""
    return Supplier.objects.filter(user=user).first()


def _can_read(user, kind, record, field):
    """Is `user` allowed to read `field` on `record`? The single policy every
    download path (signed link, authenticated fetch) goes through."""
    if not (user and user.is_authenticated and user.is_active):
        return False
    role = getattr(user, "role", None)
    if role in {"admin", "staff"}:
        return True
    if role == "head":
        return kind in HEAD_KINDS
    if role == "bac":
        return kind in BAC_KINDS
    if role != "supplier":
        return False

    supplier = _supplier_of(user)
    if supplier is None:
        return False

    if kind == "supplier":
        return record.pk == supplier.pk
    if kind == "supplierdoc":
        return record.supplier_id == supplier.pk
    if kind == "bid":
        return record.supplier_id == supplier.pk
    if kind in {"attachment", "bidimage"}:
        return record.bid.supplier_id == supplier.pk
    if kind == "award":
        return record.supplier_id == supplier.pk and record.status == Award.Status.WON
    if kind == "awardversion":
        return _can_read(user, "award", record.award, record.key)
    if kind == "project":
        # Mirrors ProjectViewSet.get_queryset (published + category match) and
        # adds the verification requirement bidding itself has.
        return (
            field in SUPPLIER_VISIBLE_PROJECT_FIELDS
            and supplier.qualification_status == Supplier.Qualification.VERIFIED
            and record.status == Project.Status.PUBLISHED
            and (record.category in (supplier.business_types or [])
                 or record.category == OTHERS_CATEGORY)
        )
    return False


def _is_public(kind, record, field):
    """Files anyone may download without an account: only the Notice of Award
    of an awarded procurement, so the public can hash it and compare it with
    the NOA_ISSUED anchor. Everything else needs a login."""
    return (
        kind == "award"
        and field == "notice_of_award"
        and record.status == Award.Status.WON
        and record.project.status == Project.Status.AWARDED
    )


# Resolves a URL `kind` to the queryset it addresses. select_related pulls in
# whatever _can_read needs so the check costs no extra query.
_LOOKUPS = {
    "supplier": lambda: Supplier.objects.all(),
    "supplierdoc": lambda: SupplierCategoryDocument.objects.all(),
    "project": lambda: Project.objects.all(),
    "bid": lambda: Bid.objects.select_related("supplier"),
    "award": lambda: Award.objects.select_related("supplier", "project"),
    "awardversion": lambda: AwardDocumentVersion.objects.select_related("award__supplier", "award__project"),
    "attachment": lambda: BidAttachment.objects.select_related("bid"),
    "bidimage": lambda: BidProductImage.objects.select_related("bid"),
    "bacresolution": lambda: BACResolution.objects.all(),
    "bacmembership": lambda: BACMembership.objects.all(),
}


def _resolve(kind, pk, field):
    """The record a URL addresses, or Http404 for an unknown kind/field/pk."""
    if kind not in _LOOKUPS or field not in ALLOWED_FIELDS.get(kind, ()):
        raise Http404
    record = _LOOKUPS[kind]().filter(pk=pk).first()
    if record is None:
        raise Http404
    return record


def _hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def issue_download_token(user, kind, pk, field):
    """Mint a one-time token for `user` to fetch one file. Returns the raw token
    (only its hash is stored). Also prunes long-expired rows."""
    now = timezone.now()
    FileDownloadToken.objects.filter(expires_at__lt=now - FILE_LINK_RETENTION).delete()
    token = secrets.token_urlsafe(32)
    FileDownloadToken.objects.create(
        token_hash=_hash_token(token), user=user, kind=kind, object_id=pk, field=field,
        expires_at=now + timedelta(seconds=FILE_LINK_MAX_AGE_SECONDS),
    )
    return token


def redeem_download_token(token, kind, pk, field):
    """Spend `token` if it is a live grant for exactly this file. Returns the
    user it was issued to, or None. Atomic: two simultaneous requests with the
    same token can't both succeed."""
    if not token:
        return None
    now = timezone.now()
    with transaction.atomic():
        grant = (FileDownloadToken.objects.select_for_update().select_related("user")
                 .filter(token_hash=_hash_token(token)).first())
        if (grant is None or grant.used_at is not None or grant.expires_at <= now
                or (grant.kind, grant.object_id, grant.field) != (kind, int(pk), field)):
            return None
        grant.used_at = now
        grant.save(update_fields=["used_at"])
    return grant.user


def display_name(record, field, field_file):
    """The file name offered to the person downloading it: the uploader's
    original name when one was recorded (stored names are random UUIDs, see
    uploads.py), otherwise the stored name's basename for older files."""
    recorded = (getattr(record, "original_filenames", None) or {}).get(field)
    if not recorded and isinstance(record, AwardDocumentVersion):
        recorded = record.original_filename
    if not recorded and isinstance(record, BidAttachment):
        recorded = record.file_name
    return display_filename(recorded or os.path.basename(getattr(field_file, "name", "") or ""))


def _deny(request, kind, pk, field, user=None, reason="not permitted"):
    """Log a refused file request (only when someone identifiable asked —
    anonymous scanners would just flood the log) and raise the uniform 404."""
    who = user or getattr(request, "user", None)
    if who is not None and getattr(who, "is_authenticated", False):
        log_action(request, "file.download_denied", user=who, entity_type=kind,
                   entity_id=pk, description=f"Refused {kind}/{pk}/{field} ({reason}).")
    raise Http404


def serve_file(request, kind, record, field, *, user=None):
    """Stream one file as a download and audit-log it. `user` is None for a
    public (anonymous) download."""
    from .storage_crypto import open_for_download   # avoids an import cycle

    file_field = getattr(record, field, None)
    if not file_field:
        raise Http404
    try:
        handle = open_for_download(file_field)
    except (FileNotFoundError, OSError, ValueError):
        # The record still points at a file storage no longer has — most likely
        # written to Render's ephemeral disk before the bucket was configured.
        logger.warning("Protected file missing from storage: %s/%s/%s",
                       kind, record.pk, field)
        raise NotFound(MISSING_FILE_DETAIL)

    filename = display_name(record, field, file_field)
    log_action(
        request, "file.downloaded", user=user,
        entity_type=kind, entity_id=record.pk,
        description=f"Downloaded {kind}/{record.pk}/{field} ({filename})"
                    + ("" if user else " — public"),
    )
    # as_attachment: the browser saves the file instead of rendering it inside
    # our origin, so an uploaded file can never execute as a page. FileResponse
    # encodes the filename safely (RFC 6266) and guesses the Content-Type.
    response = FileResponse(handle, as_attachment=True, filename=filename)
    # Private and permission-dependent: no shared or browser cache may keep it.
    response["Cache-Control"] = "private, no-store, max-age=0"
    response["Pragma"] = "no-cache"
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = "default-src 'none'; sandbox"
    return response


class ProtectedFileView(APIView):
    """GET /api/files/<kind>/<pk>/<field>/[?t=<one-time token>]

    Served when ONE of these holds, checked in this order:
      1. `t` is a live one-time token for this exact file, and its user still
         passes the policy (browser downloads);
      2. the caller is authenticated with a JWT and passes the policy (inline
         images fetched by the frontend, scripts, tests);
      3. the file is public (`_is_public`: an awarded procurement's NOA).
    Anything else is a 404.
    """

    # AllowAny because a one-time token or a public file needs no session.
    # Access is decided below — never by this class.
    permission_classes = [permissions.AllowAny]

    def get(self, request, kind, pk, field):
        record = _resolve(kind, pk, field)

        token = request.query_params.get("t")
        if token:
            user = redeem_download_token(token, kind, pk, field)
            if user is None:
                raise Http404   # spent, expired, forged or for another file
            if not _can_read(user, kind, record, field):
                _deny(request, kind, pk, field, user=user, reason="access revoked")
            return serve_file(request, kind, record, field, user=user)

        user = request.user
        if user and user.is_authenticated:
            if _can_read(user, kind, record, field):
                return serve_file(request, kind, record, field, user=user)
        if _is_public(kind, record, field):
            return serve_file(request, kind, record, field, user=None)
        _deny(request, kind, pk, field)


class ProtectedFileLinkView(APIView):
    """POST /api/files/<kind>/<pk>/<field>/link/ → {"url": one-time URL}.

    Called by the frontend at the moment a user clicks a document. The link is
    bound to that user and that file, works once, and expires after
    FILE_LINK_MAX_AGE_SECONDS. 404 when the caller may not read the file."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, kind, pk, field):
        record = _resolve(kind, pk, field)
        if not _can_read(request.user, kind, record, field):
            _deny(request, kind, pk, field)
        if not getattr(record, field, None):
            raise Http404
        token = issue_download_token(request.user, kind, record.pk, field)
        path = f"/api/files/{kind}/{record.pk}/{field}/?t={token}"
        return Response({
            "url": request.build_absolute_uri(path),
            "expires_in": FILE_LINK_MAX_AGE_SECONDS,
        })


class PublicNoticeOfAwardView(APIView):
    """GET /api/public/procurement/<code>/notice-of-award/ — the one document
    published to everyone, so the public can check it against its anchor."""

    permission_classes = [permissions.AllowAny]
    authentication_classes = []

    def get(self, request, code):
        code = (code or "").strip().upper()
        award = (Award.objects.select_related("project", "supplier")
                 .filter(project__code=code, status=Award.Status.WON).first())
        if award is None or not _is_public("award", award, "notice_of_award"):
            raise Http404
        return serve_file(request, "award", award, "notice_of_award", user=None)


def protected_file_url(request, kind, record, field):
    """Address of one file for the frontend, or None when the field is empty.

    Deliberately NOT a credential: the URL carries no token, so it can be put in
    any API response, cached or logged without granting anything. The frontend
    turns a click on it into a one-time link (see the module docstring)."""
    if not getattr(record, field, None):
        return None
    path = f"/api/files/{kind}/{record.pk}/{field}/"
    return request.build_absolute_uri(path) if request else path
