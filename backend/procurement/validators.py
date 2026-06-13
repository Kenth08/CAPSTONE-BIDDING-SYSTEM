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
