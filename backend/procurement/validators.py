"""Shared validators for supplier document uploads."""
import os

from django.core.exceptions import ValidationError

# Security: only allow document/image types, capped at 5 MB (matches the UI).
ALLOWED_UPLOAD_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png"}
MAX_UPLOAD_SIZE_MB = 5
MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024


def validate_upload(file):
    """Reject files that are the wrong type or too large.

    Used both as a model-field validator and re-checked in the serializer so a
    bad file can never reach disk.
    """
    ext = os.path.splitext(file.name)[1].lower()
    if ext not in ALLOWED_UPLOAD_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_UPLOAD_EXTENSIONS))
        raise ValidationError(f"Unsupported file type '{ext}'. Allowed: {allowed}.")
    if file.size > MAX_UPLOAD_SIZE_BYTES:
        raise ValidationError(f"File is too large. Maximum size is {MAX_UPLOAD_SIZE_MB} MB.")


# Image-only uploads (e.g. a procurement reference photo). Restricted to image
# types — JPG/PNG/WEBP — capped at the same 5 MB, matching the UI's validation.
ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def validate_image_upload(file):
    """Reject reference-image uploads that aren't an accepted image type or are
    too large. Image upload is optional, but when present it must be a real image."""
    ext = os.path.splitext(file.name)[1].lower()
    if ext not in ALLOWED_IMAGE_EXTENSIONS:
        raise ValidationError("Only image files are accepted.")
    if file.size > MAX_UPLOAD_SIZE_BYTES:
        raise ValidationError(f"Image must be under {MAX_UPLOAD_SIZE_MB}MB.")


# Bid documents accept office formats too (quotations, datasheets, brochures),
# so the allowed set is wider than the supplier-document validator. Same 5 MB cap.
ALLOWED_BID_EXTENSIONS = {".pdf", ".doc", ".docx", ".xlsx", ".jpg", ".jpeg", ".png"}


def validate_bid_upload(file):
    """Reject bid-document uploads that are the wrong type or too large.

    Used as a model-field validator on the Bid file fields and BidAttachment so a
    bad file can never reach disk. The per-field UI restricts the types further
    (e.g. PDF only for the compliance doc); this is the backend safety net.
    """
    ext = os.path.splitext(file.name)[1].lower()
    if ext not in ALLOWED_BID_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_BID_EXTENSIONS))
        raise ValidationError(f"Unsupported file type '{ext}'. Allowed: {allowed}.")
    if file.size > MAX_UPLOAD_SIZE_BYTES:
        raise ValidationError(f"File must be under {MAX_UPLOAD_SIZE_MB}MB.")
