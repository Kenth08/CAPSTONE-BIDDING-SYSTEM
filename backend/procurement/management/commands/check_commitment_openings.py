"""Read-only report: does every commitment opening still open and match its anchor?

    python manage.py check_commitment_openings

Decrypts each opening, re-hashes it and compares the result with the anchored
payload. Writes nothing, and prints ids, counts and key fingerprints, never a value.
Used after a restore or a key recovery. "Unavailable" means no configured key opens
it, which is not evidence of tampering. Exits with an error unless every opening
matches, so a restore drill can't pass by accident.
"""
from django.core.management.base import BaseCommand, CommandError

from procurement.models import CommitmentOpening
from procurement.openings import MATCH, MISMATCH, UNAVAILABLE, check_opening, commitment_key_fingerprints


class Command(BaseCommand):
    help = "Check that every commitment opening decrypts and matches its anchor (read-only)."

    def handle(self, *args, **options):
        counts = {MATCH: 0, MISMATCH: 0, UNAVAILABLE: 0}
        for row in CommitmentOpening.objects.select_related("anchor").iterator():
            result = check_opening(row)
            counts[result] += 1
            if result != MATCH:
                self.stdout.write(self.style.WARNING(f"{result.upper()}  opening {row.pk} of anchor {row.anchor_id}"))
        for name, fingerprint in commitment_key_fingerprints():
            self.stdout.write(f"{name} fingerprint: {fingerprint}")
        summary = f"Match {counts[MATCH]}, mismatch {counts[MISMATCH]}, unavailable {counts[UNAVAILABLE]}."
        if counts[MISMATCH] or counts[UNAVAILABLE]:
            raise CommandError(summary)
        self.stdout.write(self.style.SUCCESS(summary))
