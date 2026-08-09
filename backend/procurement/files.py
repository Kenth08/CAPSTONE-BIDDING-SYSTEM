"""Access-controlled delivery of every uploaded file.

WHY THIS EXISTS
---------------
Uploads used to be linked directly at MEDIA_URL ("/media/supplier_docs/..."),
which had two separate problems:

1. It only worked in development. config/urls.py registers the MEDIA_URL route
   *only* when DEBUG is True, and WhiteNoise serves STATIC_ROOT, never
   MEDIA_ROOT — so on the deployed site (DEBUG=False) every document link
   returned 404. Supplier documents, quotations, Purchase Requests and Notices
   of Award were all unreachable in production.

2. It had no access control at all. A media URL is just a path: anyone holding
   or guessing one could read a supplier's government ID, their audited
   financial statements, or a losing bidder's quotation — no login required.
   Switching to S3 would not have fixed that, only made the public URLs
   permanent (AWS_QUERYSTRING_AUTH is off).

Every file is therefore served through this module instead. A request names a
record and a field; this resolves the FileField, checks that *this* caller is
allowed to see *that* file, and streams it. It works identically on local disk
and on S3, so nothing here depends on which storage backend is configured.

THE RULES, IN ONE PLACE
-----------------------
    supplier documents  → admin/head, or that supplier
    procurement docs    → admin/head, or a supplier the procurement is open to
    bid documents       → admin/head, or the supplier who filed the bid
    award documents     → admin/head, or the supplier who won

Note the third rule: a supplier can read their OWN bid documents and nobody
else's, which is what keeps rival quotations private during evaluation.

HOW A BROWSER PROVES IT MAY READ A FILE
---------------------------------------
Documents are opened with `<a href target="_blank">` and reference images with
`<img src>`. Both are plain browser navigations: they carry cookies, but NOT the
`Authorization: Bearer` header this API authenticates with. A JWT-only check
would therefore reject every real document link in the UI.

So each URL carries a signed, expiring token instead. The serializer mints it
only while rendering a response for a caller who already passed the viewset's
permission check — that issuing moment IS the authorization decision, and the
signature makes the resulting link unforgeable and short-lived (the same model
as an S3 pre-signed URL). A token is bound to one kind/pk/field, so it cannot be
edited to point at another supplier's file.

An authenticated API client with no token in the URL is still served, by
re-running the ownership check directly — belt and braces, and it keeps the
endpoint usable from scripts and tests.
"""
import mimetypes
import os

from django.core import signing
from django.http import FileResponse, Http404
from rest_framework import permissions
from rest_framework.views import APIView

# How long a document link stays valid. Long enough that a tab left open over a
# lunch break still works, short enough that a URL pasted into a chat or leaked
# through a Referer header stops working the same day.
FILE_URL_MAX_AGE_SECONDS = 6 * 60 * 60

# Namespaced so these tokens can never be confused with any other signed value
# the project produces (password reset, email verification, session data).
_FILE_SALT = "procurement.files.protected-download"


def _sign(kind, pk, field):
    """A tamper-proof, timestamped token for exactly one file."""
    return signing.TimestampSigner(salt=_FILE_SALT).sign(f"{kind}:{pk}:{field}")


def _token_grants(token, kind, pk, field):
    """Is `token` a currently-valid grant for this exact file?"""
    if not token:
        return False
    try:
        value = signing.TimestampSigner(salt=_FILE_SALT).unsign(
            token, max_age=FILE_URL_MAX_AGE_SECONDS)
    except signing.BadSignature:
        return False
    return value == f"{kind}:{pk}:{field}"

from .models import (
    AWARD_DOCUMENT_KEYS,
    BID_DOCUMENT_KEYS,
    PROCUREMENT_DOCUMENT_KEYS,
    SUPPLIER_DOCUMENT_KEYS,
    Award,
    Bid,
    BidAttachment,
    Project,
    Supplier,
)

# Only these fields can ever be addressed, per record kind. This is a strict
# allow-list, not a filter: `getattr(record, field)` on caller-supplied input
# would otherwise expose any attribute on the model.
ALLOWED_FIELDS = {
    "supplier": set(SUPPLIER_DOCUMENT_KEYS),
    "project": set(PROCUREMENT_DOCUMENT_KEYS) | {"reference_image"},
    "bid": set(BID_DOCUMENT_KEYS),
    "award": set(AWARD_DOCUMENT_KEYS),
    "attachment": {"file"},
}


def _supplier_of(user):
    """The Supplier profile behind a user account, or None."""
    return Supplier.objects.filter(user=user).first()


def _can_read(user, kind, record):
    """Is `user` allowed to read a file hanging off `record`?

    Admins and the Head can read everything — they run the procurement. Every
    other rule is ownership: a supplier sees their own documents and nothing
    belonging to anyone else.
    """
    role = getattr(user, "role", None)
    if role in {"admin", "head"}:
        return True
    if role != "supplier":
        return False

    supplier = _supplier_of(user)
    if supplier is None:
        return False

    if kind == "supplier":
        return record.pk == supplier.pk
    if kind == "bid":
        return record.supplier_id == supplier.pk
    if kind == "attachment":
        return record.bid.supplier_id == supplier.pk
    if kind == "award":
        return record.supplier_id == supplier.pk
    if kind == "project":
        # Suppliers need the Terms of Reference, specifications and evaluation
        # criteria to bid at all, so a procurement that is open to them exposes
        # its documents. Mirrors ProjectViewSet.get_queryset exactly: published,
        # and in a category the supplier registered for.
        return (
            record.status == Project.Status.PUBLISHED
            and record.category in (supplier.business_types or [])
        )
    return False


# Resolves a URL `kind` to the queryset it addresses. select_related pulls in
# whatever _can_read needs so the check costs no extra query.
_LOOKUPS = {
    "supplier": lambda: Supplier.objects.all(),
    "project": lambda: Project.objects.all(),
    "bid": lambda: Bid.objects.select_related("supplier"),
    "award": lambda: Award.objects.select_related("supplier"),
    "attachment": lambda: BidAttachment.objects.select_related("bid"),
}


class ProtectedFileView(APIView):
    """GET /api/files/<kind>/<pk>/<field>/?t=<token> — stream one uploaded file.

    Returns 404 (never 403) when the caller may not read the file: whether a
    particular supplier uploaded a particular document is itself information
    worth withholding, and a 403 would confirm the record exists.
    """

    # AllowAny because the signed `t` token is the credential for browser
    # navigations, which cannot send an Authorization header. Access is decided
    # below — either the token is valid, or the caller is a signed-in user who
    # passes _can_read. Never both-optional: with neither, nothing is served.
    permission_classes = [permissions.AllowAny]

    def get(self, request, kind, pk, field):
        if kind not in _LOOKUPS or field not in ALLOWED_FIELDS.get(kind, ()):
            raise Http404

        record = _LOOKUPS[kind]().filter(pk=pk).first()
        if record is None:
            raise Http404

        granted = _token_grants(request.query_params.get("t"), kind, pk, field)
        if not granted:
            user = request.user
            if not (user and user.is_authenticated and _can_read(user, kind, record)):
                raise Http404

        file_field = getattr(record, field, None)
        if not file_field:
            raise Http404

        try:
            handle = file_field.open("rb")
        except (FileNotFoundError, OSError, ValueError):
            # The record still points at a file that storage no longer has —
            # most likely written to Render's ephemeral disk before an S3 bucket
            # was configured. A clean 404 beats a 500.
            raise Http404

        filename = os.path.basename(file_field.name)
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        response = FileResponse(handle, content_type=content_type)
        # inline: these are documents meant to be read in the browser tab the UI
        # opens. The filename is still offered for an explicit download.
        response["Content-Disposition"] = f'inline; filename="{filename}"'
        # Documents are private and permission-dependent — never let a shared
        # cache hold on to one and hand it to the next caller.
        response["Cache-Control"] = "private, max-age=0, no-store"
        response["X-Content-Type-Options"] = "nosniff"
        return response


def protected_file_url(request, kind, record, field):
    """Absolute, signed URL for one file, or None when the field is empty.

    Serializers call this instead of `file.url`, so no MEDIA_URL ever reaches
    the frontend and every document goes through ProtectedFileView. Minting the
    token here is the authorization decision: this only runs while serializing a
    response the caller was already permitted to receive.
    """
    if not getattr(record, field, None):
        return None
    path = f"/api/files/{kind}/{record.pk}/{field}/?t={_sign(kind, record.pk, field)}"
    return request.build_absolute_uri(path) if request else path
