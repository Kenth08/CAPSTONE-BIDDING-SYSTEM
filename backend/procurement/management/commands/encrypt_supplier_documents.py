"""Encrypt existing supplier registration documents, or re-encrypt them under a
new key after a rotation.

    python manage.py encrypt_supplier_documents            # dry run: report only
    python manage.py encrypt_supplier_documents --apply    # rewrite the files

Files uploaded before FILE_ENCRYPTION_KEY was set are stored in plain text;
they still open (downloads detect the format), and this command encrypts them
in place. After a key rotation it re-encrypts files still under a retired key
(see procurement/storage_crypto.py for the rotation steps).

Safe to re-run: files already under the current key are skipped. Each file is
decrypted again after writing and compared with the original plaintext before
the command moves on, so a failed write is reported rather than silently
leaving a broken file. Only supplier registration documents are touched —
never bid, project or award files, whose hashes are anchored on-chain.
"""
from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand, CommandError

from procurement.models import SUPPLIER_DOCUMENT_KEYS, Supplier, SupplierCategoryDocument
from procurement.storage_crypto import decrypt_bytes, encryption_enabled, reencrypt_bytes


def _targets():
    for supplier in Supplier.objects.all().iterator():
        for key in SUPPLIER_DOCUMENT_KEYS:
            ff = getattr(supplier, key)
            if ff:
                yield f"supplier {supplier.pk} {key}", ff
    for row in SupplierCategoryDocument.objects.all().iterator():
        if row.file:
            yield f"supplier {row.supplier_id} category {row.key}", row.file


def _rewrite_in_place(ff, data):
    """Overwrite the stored object under the SAME name (the DB row keeps
    pointing at it). Delete-then-save, because S3Storage with
    AWS_S3_FILE_OVERWRITE=False would otherwise pick a new name."""
    storage, name = ff.storage, ff.name
    storage.delete(name)
    saved = storage.save(name, ContentFile(data))
    if saved != name:
        raise CommandError(f"Storage saved {name!r} as {saved!r}; aborting.")


class Command(BaseCommand):
    help = "Encrypt (or re-encrypt after key rotation) stored supplier registration documents."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true",
                            help="Actually rewrite files. Without it, only report.")

    def handle(self, *args, **options):
        if not encryption_enabled():
            raise CommandError("FILE_ENCRYPTION_KEY is not set; nothing to encrypt with.")
        apply = options["apply"]
        counts = {"encrypt": 0, "skip": 0, "missing": 0}
        for label, ff in _targets():
            try:
                with ff.open("rb") as handle:
                    data = handle.read()
            except (FileNotFoundError, OSError):
                counts["missing"] += 1
                self.stdout.write(self.style.WARNING(f"MISSING  {label}  ({ff.name})"))
                continue
            new = reencrypt_bytes(data)
            if new is None:
                counts["skip"] += 1
                continue
            counts["encrypt"] += 1
            self.stdout.write(f"{'ENCRYPT ' if apply else 'WOULD   '} {label}  ({ff.name})")
            if apply:
                plaintext = decrypt_bytes(data)
                _rewrite_in_place(ff, new)
                with ff.storage.open(ff.name, "rb") as check:
                    if decrypt_bytes(check.read()) != plaintext:
                        raise CommandError(f"Verification failed for {ff.name}; stopping.")
        verb = "Encrypted" if apply else "Would encrypt"
        self.stdout.write(self.style.SUCCESS(
            f"{verb} {counts['encrypt']}, already current {counts['skip']}, "
            f"missing from storage {counts['missing']}."
            + ("" if apply else " Dry run — re-run with --apply to write.")))
        self._rotate_mfa_secrets(apply)

    def _rotate_mfa_secrets(self, apply):
        """TOTP secrets (accounts/mfa.py) use the same key. Re-encrypt them too,
        or removing the old key after a rotation would break every Admin/Head
        sign-in."""
        from django.contrib.auth import get_user_model

        changed = 0
        for user in get_user_model().objects.exclude(mfa_secret="").iterator():
            new = reencrypt_bytes(user.mfa_secret.encode("ascii"))
            if new is None:
                continue
            changed += 1
            if apply:
                user.mfa_secret = new.decode("ascii")
                user.save(update_fields=["mfa_secret"])
        self.stdout.write(f"{'Re-encrypted' if apply else 'Would re-encrypt'} {changed} two-factor secret(s).")
