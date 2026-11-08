"""
Usage:
    python manage.py backup_db                      # writes to backups/
    python manage.py backup_db -o /tmp/dumps        # custom output directory
    python manage.py backup_db --decrypt FILE.enc   # FILE.enc -> FILE (plain JSON)
    python manage.py backup_db --verify FILE        # test a backup; writes nothing

Every backup gets a FILE.sha256 next to it. --verify checks that checksum,
decrypts in memory only, parses the dump and counts its records, so you can
prove a backup restores BEFORE you need it. A backup you have never tested is
a hope, not a backup. The checksum catches a damaged or swapped file; keep a
copy of backups (and the key, separately) off the server so an attacker who
reaches the server can't delete both (RECOVERY.md).

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

import hashlib
import json
import os
from collections import Counter
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
            "--verify", metavar="FILE",
            help="Check a backup's checksum, decrypt it in memory and count its records. Writes nothing.",
        )
        parser.add_argument(
            "--decrypt", metavar="FILE",
            help="Decrypt an encrypted backup (.json.enc) next to it as .json, then exit.",
        )

    def handle(self, *args, **options):
        if options["verify"]:
            return self._verify(options["verify"])
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

        digest = _write_checksum(filename)
        size_kb = os.path.getsize(filename) / 1024
        self.stdout.write(self.style.SUCCESS(f"Backup saved: {filename}  ({size_kb:.1f} KB)"))
        self.stdout.write(f"SHA-256 {digest} (saved to {os.path.basename(filename)}.sha256)")
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

    def _verify(self, path):
        if not os.path.isfile(path):
            raise CommandError(f"{path} does not exist.")
        with open(path, "rb") as f:
            data = f.read()

        expected = _read_checksum(path)
        actual = hashlib.sha256(data).hexdigest()
        if expected is None:
            self.stderr.write(self.style.WARNING(
                "No .sha256 file next to this backup, so it can't be checked for damage or swapping."))
        elif expected != actual:
            raise CommandError("Checksum MISMATCH: this file is not the backup that was written "
                               "(damaged or replaced). Do not restore it.")
        else:
            self.stdout.write("Checksum OK.")

        if is_encrypted(data):
            try:
                data = decrypt_bytes(data)       # in memory only
            except Exception as exc:  # noqa: BLE001 — wrong or missing key; never print key material
                raise CommandError(f"Could not decrypt ({exc.__class__.__name__}). Is FILE_ENCRYPTION_KEY "
                                   "(or FILE_ENCRYPTION_OLD_KEYS) the key this backup was made with?")
        try:
            rows = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise CommandError("The backup is not a readable data dump. Do not restore it.")
        if not isinstance(rows, list) or not rows:
            raise CommandError("The backup holds no records. Do not restore it.")

        counts = Counter(r.get("model", "?") for r in rows if isinstance(r, dict))
        self.stdout.write(self.style.SUCCESS(f"Backup is readable: {len(rows)} records."))
        for model, n in sorted(counts.items()):
            self.stdout.write(f"  {model}: {n}")
        if not counts.get("procurement.blockchainanchor"):
            self.stderr.write(self.style.WARNING("It holds no blockchain anchors."))


def _write_checksum(path):
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    with open(path + ".sha256", "w", encoding="ascii") as f:
        f.write(f"{digest}  {os.path.basename(path)}\n")
    return digest


def _read_checksum(path):
    try:
        with open(path + ".sha256", encoding="ascii") as f:
            return f.read().split()[0].lower()
    except (OSError, IndexError):
        return None
