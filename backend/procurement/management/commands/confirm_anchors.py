"""Check sent blockchain anchors against Sepolia and record what really happened.

    python manage.py confirm_anchors            # preview only, changes nothing
    python manage.py confirm_anchors --apply    # save the results

Server-signed anchors are recorded when the transaction is SENT (waiting for a
block would outlast the web worker's timeout). This command finishes the job:
for every anchor that has a transaction hash but no block number yet, it reads
the receipt and

  * confirmed -> saves the block number,
  * failed on-chain or never mined -> clears the hash so the record shows
    "Anchor now" again (the failed hash is kept in the audit log),
  * still pending, or the node can't be reached -> leaves it for next time.

Safe to run any number of times. It runs at the end of every Render build (see
build.sh) and never fails the build: a blockchain or network problem must not
block a deploy, the same way anchoring never blocks a business action.
"""
from django.core.management.base import BaseCommand

from procurement import blockchain
from procurement.models import BlockchainAnchor


class Command(BaseCommand):
    help = "Confirm sent blockchain anchors against Sepolia (preview unless --apply)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--apply", action="store_true",
            help="Save the results. Without it, only prints what would change.",
        )
        parser.add_argument(
            "--limit", type=int, default=200,
            help="Most anchors to check in one run (default 200).",
        )

    def handle(self, *args, apply=False, limit=200, **options):
        try:
            self._run(apply=apply, limit=limit)
        except Exception as exc:  # noqa: BLE001 — must never fail a deploy
            self.stderr.write(f"confirm_anchors skipped: {exc}")

    def _run(self, *, apply, limit):
        unconfirmed = (
            BlockchainAnchor.objects
            .exclude(tx_hash="")
            .filter(block_number__isnull=True)
            .order_by("anchored_at", "id")[:limit]
        )
        anchors = list(unconfirmed)
        if not anchors:
            self.stdout.write("confirm_anchors: nothing to check.")
            return

        w3 = blockchain.web3_client()
        if w3 is None:
            self.stdout.write("confirm_anchors: web3 is not installed; skipped.")
            return

        mode = "" if apply else " (preview — run with --apply to save)"
        self.stdout.write(f"confirm_anchors: checking {len(anchors)} anchor(s){mode}")
        counts = {}
        for anchor in anchors:
            tx_hash = anchor.tx_hash   # read first: a failed one gets cleared
            outcome = blockchain.confirm_anchor(anchor, w3=w3, apply=apply)
            counts[outcome] = counts.get(outcome, 0) + 1
            if outcome != blockchain.CONFIRMED:
                self.stdout.write(
                    f"  {anchor.entity_ref} {anchor.stage} #{anchor.id}: {outcome} (tx {tx_hash})"
                )
        summary = ", ".join(f"{n} {k}" for k, n in sorted(counts.items()))
        self.stdout.write(f"confirm_anchors: {summary}.")
