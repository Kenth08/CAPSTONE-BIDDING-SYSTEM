"""Copy uploads that only exist on a local disk into the configured bucket.

    python manage.py migrate_media_to_bucket                  # dry run (default)
    python manage.py migrate_media_to_bucket --apply          # copy
    python manage.py migrate_media_to_bucket --source /path/to/old/media

WHY
---
Before AWS_STORAGE_BUCKET_NAME was configured, uploads were written to the
server's MEDIA_ROOT. On Render that disk is wiped on every deploy or restart,
so any such file still referenced by the database is either already gone or
will be lost on the next deploy. This finds every file the database points at,
and for each one reports whether it is in the bucket, available locally (and
copies it), or missing everywhere.

GUARANTEES
----------
* Content is copied byte-for-byte under the SAME name; the database is never
  modified. SHA-256 is compared before and after the copy, so every document
  hash anchored on-chain keeps verifying.
* Nothing is ever deleted or overwritten: a name that already exists in the
  bucket is reported and skipped.
* Dry run by default.
"""
import hashlib

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import FileSystemStorage, default_storage
from django.core.management.base import BaseCommand, CommandError
from django.db import models

from procurement.models import Award, Bid, BidAttachment, BidProductImage, Project, Supplier, SupplierCategoryDocument

MODELS = (Supplier, SupplierCategoryDocument, Project, Bid, BidAttachment, BidProductImage, Award)


def referenced_files():
    """(label, stored name) for every non-empty FileField value in the DB."""
    for model in MODELS:
        fields = [f.name for f in model._meta.fields if isinstance(f, models.FileField)]
        for row in model.objects.all().only("pk", *fields).iterator():
            for name in fields:
                value = getattr(row, name)
                if value:
                    yield f"{model.__name__} {row.pk} {name}", value.name


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class Command(BaseCommand):
    help = "Copy files referenced by the database from a local media folder into the bucket."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Copy files. Without it, only report.")
        parser.add_argument("--source", default=str(settings.MEDIA_ROOT),
                            help="Local folder holding the old uploads (default: MEDIA_ROOT).")

    def handle(self, *args, **options):
        target = self.target_storage()
        source = FileSystemStorage(location=options["source"])
        if isinstance(target, FileSystemStorage) and \
                str(target.location).rstrip("/\\") == str(source.location).rstrip("/\\"):
            raise CommandError("The default storage IS the local source folder — "
                               "set AWS_STORAGE_BUCKET_NAME so there is a bucket to copy into.")
        apply = options["apply"]
        counts = {"in_bucket": 0, "copied": 0, "missing": 0}

        for label, name in referenced_files():
            if target.exists(name):
                counts["in_bucket"] += 1
                continue
            if not source.exists(name):
                counts["missing"] += 1
                self.stdout.write(self.style.WARNING(f"MISSING EVERYWHERE  {label}  ({name})"))
                continue
            with source.open(name, "rb") as handle:
                data = handle.read()
            digest = sha256(data)
            if not apply:
                counts["copied"] += 1
                self.stdout.write(f"WOULD COPY  {label}  ({name}, sha256 {digest[:12]}…)")
                continue
            saved = target.save(name, ContentFile(data))
            if saved != name:
                raise CommandError(f"Bucket stored {name!r} as {saved!r}; stopping (DB unchanged).")
            with target.open(name, "rb") as check:
                if sha256(check.read()) != digest:
                    raise CommandError(f"Hash mismatch after copying {name!r}; stopping.")
            counts["copied"] += 1
            self.stdout.write(self.style.SUCCESS(f"COPIED  {label}  ({name}, sha256 {digest[:12]}…)"))

        verb = "Copied" if apply else "Would copy"
        self.stdout.write(
            f"Already in bucket: {counts['in_bucket']}. {verb}: {counts['copied']}. "
            f"Missing everywhere: {counts['missing']}."
            + ("" if apply else " Dry run — re-run with --apply to copy."))
        if counts["missing"]:
            self.stdout.write(
                "Missing files cannot be recovered by this command. Ask the uploader to "
                "re-submit them; anchored ones will show as 'unavailable' in the verifier.")

    def target_storage(self):
        """Hook for tests; production uses the configured default storage."""
        return default_storage
