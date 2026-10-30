"""
Usage:
    python manage.py backup_db                      # writes to backups/
    python manage.py backup_db -o /tmp/dumps        # custom output directory
    python manage.py backup_db --decrypt FILE.enc   # FILE.enc -> FILE (plain JSON)

The backup is a JSON dump of the accounts + procurement apps produced by
Django's dumpdata command. It contains PASSWORD HASHES, supplier TINs,
addresses, phone numbers and emails.

When FILE_ENCRYPTION_KEY is set the dump is written encrypted
(backup_<timestamp>.json.enc, Fernet — see procurement/storage_crypto.py) and
never touches the disk in plain text. Without a key it is written as plain
JSON with a warning. Either way `backups/` is gitignored; keep backups off
shared drives and delete old ones.

To restore an encrypted backup:
    python manage.py backup_db --decrypt backups/backup_<timestamp>.json.enc
    python manage.py loaddata backups/backup_<timestamp>.json
    (then delete the decrypted .json)

Supabase also creates automatic daily backups (7-day retention on the free
tier; Point-in-Time Recovery available on the Pro plan via the dashboard at
Settings → Database → Backups). This command adds an on-demand safety net.
"""

import os
from datetime import datetime
from io import StringIO

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError

from procurement.storage_crypto import decrypt_bytes, encrypt_bytes, encryption_enabled, is_encrypted

SENSITIVE_WARNING = (
    "WARNING: this backup is NOT encrypted (FILE_ENCRYPTION_KEY is not set). It contains "
    "password hashes and supplier personal data — store it somewhere private and delete it "
    "when no longer needed."
)


class Command(BaseCommand):
    help = "Export accounts + procurement data to a timestamped (encrypted) backup file."

    def add_arguments(self, parser):
        parser.add_argument(
            "--output-dir", "-o",
            default="backups",
            help="Directory to write the backup file (default: backups/).",
        )
        parser.add_argument(
            "--decrypt", metavar="FILE",
            help="Decrypt an encrypted backup (.json.enc) next to it as .json, then exit.",
        )

    def handle(self, *args, **options):
        if options["decrypt"]:
            return self._decrypt(options["decrypt"])

        output_dir = options["output_dir"]
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        buf = StringIO()
        call_command(
            "dumpdata",
            "accounts",
            "procurement",
            indent=2,
            stdout=buf,
            natural_foreign=True,
            natural_primary=True,
        )
        data = buf.getvalue().encode("utf-8")

        if encryption_enabled():
            filename = os.path.join(output_dir, f"backup_{timestamp}.json.enc")
            with open(filename, "wb") as f:
                f.write(encrypt_bytes(data))
        else:
            filename = os.path.join(output_dir, f"backup_{timestamp}.json")
            with open(filename, "wb") as f:
                f.write(data)
            self.stderr.write(self.style.WARNING(SENSITIVE_WARNING))

        size_kb = os.path.getsize(filename) / 1024
        self.stdout.write(self.style.SUCCESS(f"Backup saved: {filename}  ({size_kb:.1f} KB)"))
        if filename.endswith(".enc"):
            self.stdout.write(f"To restore: python manage.py backup_db --decrypt {filename}, "
                              "then loaddata the .json it writes.")
        else:
            self.stdout.write("To restore: python manage.py loaddata <file>")

    def _decrypt(self, path):
        if not path.endswith(".enc"):
            raise CommandError("Expected an encrypted backup ending in .enc.")
        with open(path, "rb") as f:
            data = f.read()
        if not is_encrypted(data):
            raise CommandError(f"{path} is not an encrypted backup.")
        out = path[: -len(".enc")]
        with open(out, "wb") as f:
            f.write(decrypt_bytes(data))
        self.stdout.write(self.style.SUCCESS(f"Decrypted to {out}"))
        self.stderr.write(self.style.WARNING(
            "The decrypted file contains password hashes and personal data. Delete it after loaddata."))
