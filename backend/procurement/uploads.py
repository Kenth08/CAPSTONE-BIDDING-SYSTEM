"""How uploaded files are named and cleaned before they are stored.

STORAGE NAMES
-------------
Stored paths used to carry the uploader's own file name and the record's
database id ("supplier_docs/12/Juan_Dela_Cruz_valid_id_ab12cd34.pdf",
"bid_documents/quotations/Juan_Quotation.pdf"): personal data in the bucket
listing, and bid paths an attacker could guess outright. Every new upload is
now stored as "<folder>/<random uuid>.<ext>" — nothing personal, nothing
guessable. The original name is kept only in the database
(`original_filenames`), which is what downloads are offered as.

Files that already exist keep their stored names: a document's SHA-256 is
anchored on-chain, and renaming or rewriting it is unnecessary to protect it
now that every download goes through procurement/files.py.

METADATA
--------
Photos carry EXIF: GPS coordinates of where they were taken, the camera owner's
name, device serials. Every JPEG/PNG/WebP upload is re-encoded without that
metadata before it is stored (after the orientation is applied, so phone photos
don't come out sideways). This happens before the file is saved, so the
document hash anchored on-chain is the hash of the cleaned file.
"""
import io
import os
import uuid

from django.core.files.base import ContentFile
from django.db import models
from django.utils.text import get_valid_filename

IMAGE_FORMATS = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP"}
DISPLAY_NAME_MAX = 120


def random_storage_name(folder, filename):
    """"<folder>/<uuid4>.<ext>" — the only part of the upload's name kept is
    its (lower-cased, already validated) extension."""
    ext = os.path.splitext(filename or "")[1].lower()[:10]
    return f"{folder}/{uuid.uuid4().hex}{ext}"


def display_filename(raw):
    """A safe version of the uploader's file name for the database and the
    Content-Disposition header: no path, no odd characters, bounded length."""
    base = os.path.basename(raw or "")
    stem, ext = os.path.splitext(base)
    stem = get_valid_filename(stem) if stem.strip() else ""
    stem = stem[: DISPLAY_NAME_MAX - len(ext)] or "document"
    return f"{stem}{ext.lower()}"


def strip_image_metadata(content, ext):
    """Re-encode an image without EXIF/XMP/text chunks. Returns new bytes, or
    None when `ext` is not an image type (the content is left untouched).

    The validators have already proved the bytes decode, so a failure here is
    unexpected and is allowed to raise rather than store a file with GPS data."""
    fmt = IMAGE_FORMATS.get((ext or "").lower())
    if fmt is None:
        return None
    from PIL import Image, ImageOps

    with Image.open(io.BytesIO(content)) as img:
        img = ImageOps.exif_transpose(img)   # bake the rotation in before EXIF goes
        if fmt == "JPEG" and img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        out = io.BytesIO()
        options = {"JPEG": {"quality": 92, "optimize": True}, "WEBP": {"quality": 92}}.get(fmt, {})
        # Saving a fresh image object without passing exif=/pnginfo= drops all
        # metadata blocks; nothing is copied over implicitly.
        img.save(out, format=fmt, **options)
    return out.getvalue()


def _read(file):
    file.seek(0)
    data = file.read()
    file.seek(0)
    return data


class SecureUploadsMixin(models.Model):
    """For models with FileFields: on save, every NEW upload has its image
    metadata stripped, its original name recorded (when the model has an
    `original_filenames` field) and — for the fields a model lists in
    ENCRYPTED_FILE_FIELDS — its content encrypted (see storage_crypto.py).

    Done in save() so it covers every way a file reaches a model (serializer
    save, setattr + save, admin) without each view having to remember."""

    # FileFields whose content is encrypted at rest. Empty by default.
    ENCRYPTED_FILE_FIELDS = frozenset()

    class Meta:
        abstract = True

    def _prepare_new_uploads(self):
        from .storage_crypto import encrypt_upload

        names_changed = False
        has_names = any(f.name == "original_filenames" for f in self._meta.fields)
        for field in self._meta.fields:
            if not isinstance(field, models.FileField):
                continue
            ff = getattr(self, field.name)
            if not ff or getattr(ff, "_committed", True):
                continue                       # empty, or already stored
            original = display_filename(ff.name)
            cleaned = strip_image_metadata(_read(ff.file), os.path.splitext(ff.name)[1])
            if cleaned is not None:
                ff.file = ContentFile(cleaned, name=ff.name)
            if has_names:
                names = dict(self.original_filenames or {})
                if names.get(field.name) != original:
                    names[field.name] = original
                    self.original_filenames = names
                    names_changed = True
            if field.name in self.ENCRYPTED_FILE_FIELDS:
                encrypt_upload(ff)             # last: after metadata stripping
        return names_changed

    def save(self, *args, **kwargs):
        if self._prepare_new_uploads() and kwargs.get("update_fields") is not None:
            kwargs["update_fields"] = set(kwargs["update_fields"]) | {"original_filenames"}
        super().save(*args, **kwargs)
