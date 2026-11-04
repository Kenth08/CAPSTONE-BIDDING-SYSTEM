"""Re-encrypt commitment openings under the current COMMITMENT_KEY after a rotation.

    python manage.py rotate_commitment_openings            # dry run: report only
    python manage.py rotate_commitment_openings --apply    # write

Steps: put the new key in COMMITMENT_KEY and the old one in COMMITMENT_OLD_KEYS,
deploy, run this with --apply, and remove the old key only once this reports none
left under it. Safe to re-run. Only ciphertext changes: salts, commitments, anchors
and on-chain hashes never do. Prints counts and key fingerprints, never a value.
"""
from django.core.management.base import BaseCommand, CommandError

from procurement.models import CommitmentOpening
from procurement.openings import (
    OpeningsNotConfigured,
    _keyring,
    commitment_key_fingerprints,
    rotate_opening,
)


class Command(BaseCommand):
    help = "Re-encrypt commitment openings under the current COMMITMENT_KEY."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true",
                            help="Actually re-encrypt. Without it, only report.")

    def handle(self, *args, **options):
        try:
            _keyring()
        except OpeningsNotConfigured as exc:
            raise CommandError(str(exc)) from None
        apply = options["apply"]
        counts = {"current": 0, "rotated": 0, "unavailable": 0}
        for row in CommitmentOpening.objects.all().iterator():
            counts[rotate_opening(row, apply=apply)] += 1
        for name, fingerprint in commitment_key_fingerprints():
            self.stdout.write(f"{name} fingerprint: {fingerprint}")
        verb = "Re-encrypted" if apply else "Would re-encrypt"
        self.stdout.write(self.style.SUCCESS(
            f"{verb} {counts['rotated']}, already current {counts['current']}, "
            f"unavailable {counts['unavailable']}."
            + ("" if apply else " Dry run: re-run with --apply to write.")))
        if counts["unavailable"]:
            self.stdout.write(self.style.WARNING(
                "Some openings can't be decrypted with any configured key. Do not remove a key "
                "until you know which one they need."))
        elif counts["rotated"] == 0 or apply:
            self.stdout.write("No openings are left under a retired key.")
