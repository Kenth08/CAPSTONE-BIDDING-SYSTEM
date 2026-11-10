"""Scale down display photos that were stored before uploads were scaled.

    python manage.py shrink_display_images            # list what would change
    python manage.py shrink_display_images --apply    # rewrite them

New uploads are already scaled (procurement/uploads.py, DISPLAY PHOTOS). This
does the same for older procurement reference images and bid product photos,
which were stored at full camera size: 2.7 MB each on the live system, fetched
again by every dashboard that shows them.

Safe for the ledger: neither kind of photo is part of any anchored payload, so
no hash changes. Each photo is written under a new random name and the row is
pointed at it before the old file is deleted, so an interrupted run leaves at
most an orphaned file, never a row pointing at nothing. A photo that wouldn't
get meaningfully smaller is left alone, so running this twice changes nothing.

Run it against production only deliberately: like every manage.py command it
uses whatever database and storage the environment points at.
"""
import os

from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand

from procurement.models import BidProductImage, Project
from procurement.uploads import DISPLAY_IMAGE_MAX_SIDE, random_storage_name, strip_image_metadata

# Below this a photo is already small enough to leave alone.
MIN_BYTES_WORTH_SHRINKING = 400 * 1024
# Only rewrite when the result saves at least this share of the size.
MIN_SAVING = 0.2


class Command(BaseCommand):
    help = "Scale down stored reference images and bid product photos (dry run unless --apply)."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Rewrite the photos.")

    def handle(self, *args, apply=False, **options):
        targets = [
            (Project, "reference_image", "procurement_images",
             Project.objects.exclude(reference_image="").exclude(reference_image__isnull=True)),
            (BidProductImage, "image", "bid_documents/product_images", BidProductImage.objects.all()),
        ]
        changed = saved_bytes = 0
        for model, field, folder, queryset in targets:
            for record in queryset.only("pk", field).iterator():
                result = self._shrink(model, record, field, folder, apply)
                if result:
                    changed += 1
                    saved_bytes += result
        verb = "shrunk" if apply else "would be shrunk"
        self.stdout.write(self.style.SUCCESS(
            f"{changed} photo(s) {verb}, saving {saved_bytes / 1e6:.1f} MB."
            + ("" if apply else " Run again with --apply to rewrite them.")))

    def _shrink(self, model, record, field, folder, apply):
        label = f"{model.__name__} {record.pk}"
        file_field = getattr(record, field)
        old_name = file_field.name
        storage = file_field.storage
        try:
            with storage.open(old_name, "rb") as handle:
                data = handle.read()
        except Exception as exc:  # noqa: BLE001 — report and move on
            self.stdout.write(self.style.WARNING(f"{label}: can't read {old_name} ({exc})"))
            return 0
        if len(data) < MIN_BYTES_WORTH_SHRINKING:
            return 0
        ext = os.path.splitext(old_name)[1]
        try:
            smaller = strip_image_metadata(data, ext, DISPLAY_IMAGE_MAX_SIDE)
        except Exception as exc:  # noqa: BLE001
            self.stdout.write(self.style.WARNING(f"{label}: can't re-encode {old_name} ({exc})"))
            return 0
        if smaller is None or len(smaller) > len(data) * (1 - MIN_SAVING):
            return 0
        self.stdout.write(f"{label}: {len(data) / 1e6:.2f} MB -> {len(smaller) / 1e6:.2f} MB")
        if not apply:
            return len(data) - len(smaller)
        new_name = storage.save(random_storage_name(folder, old_name), ContentFile(smaller))
        # update(), not save(): nothing else about the record may change.
        model.objects.filter(pk=record.pk).update(**{field: new_name})
        try:
            storage.delete(old_name)
        except Exception as exc:  # noqa: BLE001 — the row already points at the new file
            self.stdout.write(self.style.WARNING(f"{label}: left old file {old_name} ({exc})"))
        return len(data) - len(smaller)
