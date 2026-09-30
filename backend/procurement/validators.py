"""Shared validators for supplier document uploads."""
import os

from django.core.exceptions import ValidationError

# Security: only allow document/image types, capped at 5 MB (matches the UI).
ALLOWED_UPLOAD_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png"}
MAX_UPLOAD_SIZE_MB = 5
MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024


# Leading bytes that must be present for the formats where the check is
# unambiguous. The extension alone is a claim made by the uploader — renaming
# anything to .pdf used to be enough to get it stored and later served back
# under a PDF content type. Sniffing the actual header makes the extension and
# the contents agree.
#
# Deliberately limited to formats with a stable, well-known signature. Office
# formats are ZIP containers and .doc is an OLE compound file, so their headers
# don't distinguish them from other files sharing those containers; they are
# size- and extension-checked only, and are never rendered inline by the app.
FILE_SIGNATURES = {
    ".pdf": [b"%PDF-"],
    ".png": [b"\x89PNG\r\n\x1a\n"],
    ".jpg": [b"\xff\xd8\xff"],
    ".jpeg": [b"\xff\xd8\xff"],
    ".webp": [b"RIFF"],          # "RIFF....WEBP" — the RIFF magic is enough here
}
_SIGNATURE_READ_BYTES = 8


def _check_signature(file, ext):
    """Verify the file's leading bytes match what its extension claims.

    Restores the read position afterwards: these validators run before the file
    is saved, and leaving the handle advanced would truncate the stored file.
    """
    expected = FILE_SIGNATURES.get(ext)
    if not expected:
        return
    try:
        pos = file.tell()
    except (AttributeError, OSError):
        pos = 0
    try:
        file.seek(0)
        header = file.read(_SIGNATURE_READ_BYTES)
    except (AttributeError, OSError):
        return  # unreadable here — the extension/size checks still applied
    finally:
        try:
            file.seek(pos)
        except (AttributeError, OSError):
            pass

    if not any(header.startswith(sig) for sig in expected):
        raise ValidationError(
            f"This file does not look like a real {ext.lstrip('.').upper()} file. "
            "Please upload the original document."
        )


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
    _check_signature(file, ext)


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
    _check_signature(file, ext)


# Bid product images: decoded with Pillow, so the format is what the bytes ARE,
# not what the filename or browser-sent MIME type claim. Maps Pillow's format
# name to the extension the file is stored under.
PRODUCT_IMAGE_FORMATS = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}


def validate_product_image(file):
    """Validate one bid product image and return the extension to store it under.

    Rejects anything over 5 MB, anything Pillow can't decode, decompression
    bombs, and any real format other than JPEG/PNG/WebP — regardless of the
    uploaded name. Restores the read position afterwards so the file saves whole.
    """
    from PIL import Image, UnidentifiedImageError  # installed via requirements.txt

    if file.size > MAX_UPLOAD_SIZE_BYTES:
        raise ValidationError(f"Image must be under {MAX_UPLOAD_SIZE_MB}MB.")
    try:
        file.seek(0)
        with Image.open(file) as img:
            fmt = img.format
            img.verify()   # walks the data; raises on truncated/corrupt files
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError):
        raise ValidationError("This file is not a valid image. Upload a JPEG, PNG or WebP photo.")
    finally:
        try:
            file.seek(0)
        except (AttributeError, OSError):
            pass
    if fmt not in PRODUCT_IMAGE_FORMATS:
        raise ValidationError("Only JPEG, PNG and WebP images are accepted.")
    return PRODUCT_IMAGE_FORMATS[fmt]


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
    # Only the PDF/image formats carry a signature here; .doc/.docx/.xlsx are
    # container formats and pass through on extension + size (see FILE_SIGNATURES).
    _check_signature(file, ext)
