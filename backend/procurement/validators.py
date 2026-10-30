"""Shared validators for every file upload.

Every uploaded file passes, in order:
  1. a strict extension allow-list (no SVG, HTML, scripts or executables);
  2. a dangerous-double-extension check ("invoice.exe.pdf", "x.html.png");
  3. the 5 MB size cap;
  4. a content check: magic bytes for PDF/PNG/JPEG/WebP, a full Pillow decode
     for images, and a structural check for Office files.
Extensions are claims made by the uploader; steps 2 and 4 make the name and the
bytes agree before anything is stored.
"""
import os
import zipfile

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


# Extensions that must never appear ANYWHERE in an upload's name, not just at
# the end: "report.exe.pdf" is a classic trick to get an executable saved under
# an innocent final extension, and a later rename (or a careless download
# manager) restores it. Ordinary dotted names ("Q3.2026.report.pdf") are fine.
DANGEROUS_EXTENSIONS = {
    "exe", "com", "scr", "pif", "msi", "msp", "dll", "bat", "cmd", "ps1", "psm1",
    "vbs", "vbe", "js", "jse", "mjs", "wsf", "wsh", "hta", "jar", "sh", "bash",
    "php", "phtml", "py", "pl", "rb", "cgi", "asp", "aspx", "jsp", "html", "htm",
    "xhtml", "shtml", "svg", "svgz", "xml", "xsl", "swf", "lnk", "reg", "apk",
    "app", "dmg", "iso", "docm", "xlsm", "pptm", "dotm",
}


def _check_name(file):
    """Reject names that hide a dangerous extension before the real one."""
    parts = os.path.basename(file.name or "").lower().split(".")
    for inner in parts[1:-1]:
        if inner.strip() in DANGEROUS_EXTENSIONS:
            raise ValidationError(
                "This file name contains a blocked file type. Rename it and upload the "
                "original document."
            )


def _read_all(file):
    """The whole upload as bytes, restoring the read position afterwards."""
    try:
        pos = file.tell()
    except (AttributeError, OSError):
        pos = 0
    try:
        file.seek(0)
        return file.read()
    finally:
        try:
            file.seek(pos)
        except (AttributeError, OSError):
            pass


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def _check_image_decodes(file, ext):
    """An image must really decode as an image — a valid header followed by
    HTML or a script is rejected, and so is a decompression bomb."""
    if ext not in IMAGE_EXTENSIONS:
        return
    import io

    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(_read_all(file))) as img:
            img.verify()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError):
        raise ValidationError("This file is not a valid image. Upload the original photo or scan.")


# Required parts of a genuine Office Open XML package.
OFFICE_ZIP_MARKERS = {".docx": "word/", ".xlsx": "xl/"}
OLE_SIGNATURE = bytes.fromhex("d0cf11e0a1b11ae1")   # OLE2 compound file (.doc)


def _check_office(file, ext):
    """.docx/.xlsx must be real Office packages without macros; .doc must be
    an OLE compound file. Renaming an executable or a web page to .docx used to
    be enough to get it stored."""
    if ext == ".doc":
        if _read_all(file)[:8] != OLE_SIGNATURE:
            raise ValidationError("This file does not look like a real Word document.")
        return
    marker = OFFICE_ZIP_MARKERS.get(ext)
    if marker is None:
        return
    import io

    try:
        with zipfile.ZipFile(io.BytesIO(_read_all(file))) as package:
            names = package.namelist()
    except (zipfile.BadZipFile, OSError, ValueError):
        raise ValidationError(f"This file does not look like a real {ext.lstrip('.').upper()} file.")
    if "[Content_Types].xml" not in names or not any(n.startswith(marker) for n in names):
        raise ValidationError(f"This file does not look like a real {ext.lstrip('.').upper()} file.")
    if any(n.lower().endswith("vbaproject.bin") for n in names):
        raise ValidationError("Documents with macros are not accepted. Save it without macros and try again.")


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
    _check_name(file)
    _check_signature(file, ext)
    _check_image_decodes(file, ext)


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
    _check_name(file)
    _check_signature(file, ext)
    _check_image_decodes(file, ext)


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
    _check_name(file)
    _check_signature(file, ext)
    _check_image_decodes(file, ext)
    _check_office(file, ext)
