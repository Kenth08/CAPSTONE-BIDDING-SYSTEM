"""Check sent blockchain anchors against Sepolia and record what really happened.

    python manage.py confirm_anchors            # preview only, changes nothing
    python manage.py confirm_anchors --apply    # save the results

A tx hash on an anchor is only a claim until the server reads it back: server-
signed anchors are recorded when the transaction is SENT (waiting for a block
would outlast the web worker's timeout), and MetaMask anchors carry whatever
hash the browser posted. It first makes sure SEPOLIA_RPC_URL really is
Sepolia (eth_chainId) and stops otherwise. Then, for every anchor with a
transaction hash that is not yet confirmed — or confirmed but still missing its
on-chain identity, or not yet shown to be final — it reads the receipt and

  * success + an AnchorRecorded event from our ledger with this exact
    entity/code/stage/hash, which the contract's getAnchor(id) agrees with
    -> confirmed (block, contract anchor id, log index, chain time, depth and
    finality saved),
  * success but no such event -> mismatch (kept, flagged, audit-logged),
  * failed on-chain or never mined -> clears the hash so the record shows
    "Anchor now" again (the failed hash is kept in the audit log),
  * still pending, or the node can't be reached -> leaves it for next time.
    An anchor confirmed earlier is never downgraded because a node has pruned
    its receipt.

Safe to run any number of times. It runs at the end of every Render build (see
build.sh) and never fails the build: a blockchain or network problem must not
block a deploy, the same way anchoring never blocks a business action.
"""
from django.core.management.base import BaseCommand

from procurement import blockchain


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
            # The class only: an error's text can carry a connection URL.
            self.stderr.write(f"confirm_anchors skipped: {exc.__class__.__name__}")

    def _run(self, *, apply, limit):
        # Every REPORTED transaction the server has not confirmed itself —
        # including MetaMask ones, which arrive with a browser-supplied block
        # number and used to be skipped as if that number were proof.
        unconfirmed = blockchain.needs_chain_check().order_by("anchored_at", "id")[:limit]
        anchors = list(unconfirmed)
        if not anchors:
            self.stdout.write("confirm_anchors: nothing to check.")
            return

        w3 = blockchain.web3_client()
        if w3 is None:
            self.stdout.write("confirm_anchors: web3 is not installed; skipped.")
            return
        ok, chain_id = blockchain.network_check(w3)
        if not ok:
            reason = ("could not read the chain id" if ok is None
                      else f"RPC is chain {chain_id}, expected {blockchain.SEPOLIA_CHAIN_ID}")
            self.stdout.write(f"confirm_anchors: {reason}; nothing checked.")
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
