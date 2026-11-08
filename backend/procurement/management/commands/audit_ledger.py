"""Check the whole database against the blockchain — the recovery check.

    python manage.py audit_ledger                          # read-only report
    python manage.py audit_ledger --deep                   # also re-hash stored documents
    python manage.py audit_ledger --trusted 0xA..,0xB..    # wallets allowed to write
    python manage.py audit_ledger --expect-owner 0xC..     # the contract owner you hold
    python manage.py audit_ledger --snapshot ledger_snapshots/   # also save a copy

WHY THIS EXISTS
  The normal integrity check compares a record with the hash stored in its
  BlockchainAnchor row. Both live in the same database, so someone who can
  write to the database can edit a record AND its stored hash together, and
  that check still says "match". Only the copy on the blockchain is out of
  their reach. This command reads the ledger itself and compares:

  1. every confirmed anchor's stored hash with the contract's own record at
     the same anchor id (catches an edited anchor row);
  2. every record with its anchor's hash, the normal check (catches an edited
     record, and with --deep a replaced document);
  3. every on-chain anchor with the database: one the database doesn't know
     was either lost (a restore from an older backup: re-enter it) or written
     by someone else (a stolen signing key, or third-party noise while the
     ledger is unrestricted);
  4. the contract's owner and write restriction against what you expect.

  Run it after restoring a backup, after a suspected break-in, and on a
  schedule. It changes nothing: no database writes, no transactions, no key
  is read. It exits with an error when it finds a problem or can't reach the
  chain, so it can gate a recovery script.

The snapshot holds only what is already public on-chain plus the database's
index of anchors (codes, stages, hashes, transaction ids) — no payloads, no
documents, no personal data (AGENTS.md rule 4).
"""
import hashlib
import json
import os
from datetime import datetime, timezone as dt_timezone

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from procurement import blockchain
from procurement.models import BlockchainAnchor

SNAPSHOT_FORMAT = "bidbridge-ledger-snapshot/1"
MAX_ANCHORS = 20_000          # a guard against a wrong contract address


def _addr(value):
    return str(value or "").strip().lower()


def _addresses(raw):
    return {_addr(a) for a in (raw or "").split(",") if a.strip()}


def _key(entity_type, entity_ref, stage, data_hash):
    return (str(entity_type), str(entity_ref), str(stage), str(data_hash).lower())


def _iso(ts):
    try:
        return datetime.fromtimestamp(int(ts), tz=dt_timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError):
        return None


class Command(BaseCommand):
    help = "Compare the database with the on-chain ledger (read-only). Exits with an error on any problem."

    def add_arguments(self, parser):
        parser.add_argument("--deep", action="store_true",
                            help="Also re-hash each anchored document from storage (slower).")
        parser.add_argument("--trusted", default="",
                            help="Comma-separated wallet addresses allowed to write anchors.")
        parser.add_argument("--expect-owner", default="",
                            help="The contract owner address you control. A different owner is a problem.")
        parser.add_argument("--snapshot", metavar="DIR",
                            help="Also save a copy of the ledger and the anchor index to DIR.")

    # ── entry point ──────────────────────────────────────────────────────
    def handle(self, *args, deep=False, trusted="", expect_owner="", snapshot=None, **options):
        self.problems = []
        self.warnings = []

        chain = self._read_chain()
        db_anchors = list(BlockchainAnchor.objects.order_by("id"))
        trusted_set = _addresses(trusted)

        self._check_contract(chain, expect_owner)
        claimed = self._check_database_against_chain(chain, db_anchors)
        self._check_chain_against_database(chain, db_anchors, claimed, trusted_set)
        self._check_records(db_anchors, deep)

        if snapshot:
            self._write_snapshot(snapshot, chain, db_anchors)

        self._report(chain, db_anchors)
        if self.problems:
            raise CommandError(f"audit_ledger: {len(self.problems)} problem(s) found — see above.")

    # ── 1. read the ledger ───────────────────────────────────────────────
    def _read_chain(self):
        if not blockchain.LEDGER_CONTRACT_ADDRESS:
            raise CommandError("LEDGER_CONTRACT_ADDRESS is not set, so there is no ledger to check against.")
        w3 = blockchain.web3_client()
        if w3 is None:
            raise CommandError("web3 is not installed, so the ledger can't be read.")
        ok, chain_id = blockchain.network_check(w3)
        if ok is None:
            raise CommandError("Could not reach the blockchain node. Nothing was checked; try again later.")
        if not ok:
            raise CommandError(f"The RPC is chain {chain_id}, not {blockchain.SEPOLIA_CHAIN_ID}. Nothing was checked.")

        try:
            fns = blockchain._ledger(w3).functions
            total = int(fns.total().call())
            if total > MAX_ANCHORS:
                raise CommandError(f"The ledger reports {total} anchors, more than {MAX_ANCHORS}. "
                                   "Check LEDGER_CONTRACT_ADDRESS.")
            rows = {}
            for anchor_id in range(total):
                r = fns.getAnchor(anchor_id).call()
                rows[anchor_id] = {
                    "id": anchor_id, "entity_type": r[0], "entity_ref": r[1], "stage": r[2],
                    "data_hash": r[3], "actor": r[4], "timestamp": int(r[5]),
                }
            owner = fns.owner().call()
            restricted = bool(fns.restricted().call())
        except CommandError:
            raise
        except Exception as exc:  # noqa: BLE001 — the class only: an error can carry the RPC URL
            raise CommandError(f"Reading the ledger failed ({exc.__class__.__name__}). Nothing was checked.")

        return {"chain_id": chain_id, "contract": blockchain.LEDGER_CONTRACT_ADDRESS,
                "owner": owner, "restricted": restricted, "total": total, "rows": rows}

    # ── 2. contract settings ─────────────────────────────────────────────
    def _check_contract(self, chain, expect_owner):
        if expect_owner and _addr(chain["owner"]) != _addr(expect_owner):
            self.problems.append(
                f"Contract owner is {chain['owner']}, not the expected {expect_owner}. "
                "If you did not transfer ownership, treat the owner key as stolen (RECOVERY.md, scenario C).")
        if not chain["restricted"]:
            self.warnings.append(
                "The ledger is unrestricted: any wallet can add anchors. They can't change or forge a "
                "record, only add noise. Restrict it when ready (RECOVERY.md, hardening).")

    # ── 3. each database anchor vs the contract ──────────────────────────
    def _check_database_against_chain(self, chain, db_anchors):
        """Returns the set of on-chain ids that a database anchor accounts for."""
        rows = chain["rows"]
        by_key = {}
        for row in rows.values():
            by_key.setdefault(_key(row["entity_type"], row["entity_ref"], row["stage"], row["data_hash"]),
                              []).append(row["id"])
        claimed = set()
        this_contract = _addr(chain["contract"])

        for a in db_anchors:
            if a.chain_contract and _addr(a.chain_contract) != this_contract:
                self.warnings.append(f"Anchor #{a.id} ({a.entity_ref} {a.stage}) was recorded on another "
                                     f"contract ({a.chain_contract}) and was not checked.")
                continue
            mine = _key(a.entity_type, a.entity_ref, a.stage, a.data_hash)

            if a.chain_anchor_id is not None:
                row = rows.get(a.chain_anchor_id)
                if row is None:
                    self.problems.append(
                        f"Anchor #{a.id} ({a.entity_ref} {a.stage}) says it is on-chain record "
                        f"{a.chain_anchor_id}, but the ledger has no such record.")
                    continue
                claimed.add(row["id"])
                theirs = _key(row["entity_type"], row["entity_ref"], row["stage"], row["data_hash"])
                if theirs != mine:
                    self.problems.append(
                        f"Anchor #{a.id} ({a.entity_ref} {a.stage}) no longer matches on-chain record "
                        f"{row['id']}: the database copy was changed after it was recorded. "
                        f"Chain hash {row['data_hash']}, database hash {a.data_hash}.")
                continue

            # Not confirmed yet: match by content, so it isn't reported as unknown.
            for chain_id in by_key.get(mine, []):
                if chain_id not in claimed:
                    claimed.add(chain_id)
                    break
            else:
                if a.verified_on_chain:
                    self.problems.append(
                        f"Anchor #{a.id} ({a.entity_ref} {a.stage}) is marked confirmed, but no on-chain "
                        "record carries its hash.")
        return claimed

    # ── 4. each on-chain anchor vs the database ──────────────────────────
    def _check_chain_against_database(self, chain, db_anchors, claimed, trusted_set):
        trusted = set(trusted_set)
        # Wallets that wrote anchors the server itself confirmed.
        trusted |= {_addr(a.actor_address) for a in db_anchors if a.verified_on_chain and a.actor_address}
        self.unclaimed_trusted = []
        self.unclaimed_other = []
        for row in chain["rows"].values():
            if row["id"] in claimed:
                continue
            if _addr(row["actor"]) in trusted:
                self.unclaimed_trusted.append(row)
            else:
                self.unclaimed_other.append(row)

        for row in self.unclaimed_trusted:
            self.problems.append(
                f"On-chain record {row['id']} ({row['entity_ref']} {row['stage']}, {_iso(row['timestamp'])}) "
                f"was written by a trusted wallet {row['actor']} but the database has no such anchor. Either "
                "data was lost (a restore from an older backup) or the signing key was used by someone else.")
        if self.unclaimed_other:
            msg = (f"{len(self.unclaimed_other)} on-chain record(s) were written by wallets this system "
                   "doesn't know. Verifiers ignore them because no record matches their hash.")
            # With writes restricted, nobody else should be able to write at all.
            (self.problems if chain["restricted"] else self.warnings).append(msg)

    # ── 5. records vs their anchors (the normal check, for every anchor) ──
    def _check_records(self, db_anchors, deep):
        self.record_counts = {}
        for a in db_anchors:
            result = blockchain.verify_anchor(a, deep=deep)
            status = result.get("status")
            self.record_counts[status] = self.record_counts.get(status, 0) + 1
            if status == blockchain.MISMATCH:
                self.problems.append(f"Anchor #{a.id} ({a.entity_ref} {a.stage}): {result.get('detail') or 'mismatch'}")
            elif result.get("reason") == "record_gone" and a.tx_hash:
                # Anchored records are never deleted by the app; a missing one was removed by hand.
                self.problems.append(f"Anchor #{a.id} ({a.entity_ref} {a.stage}): the record it was taken "
                                     "from has been deleted. Restore it from a backup.")
            elif status == blockchain.UNAVAILABLE and a.verified_on_chain:
                self.warnings.append(f"Anchor #{a.id} ({a.entity_ref} {a.stage}) could not be checked: "
                                     f"{result.get('detail') or 'evidence unavailable'}")

    # ── snapshot ─────────────────────────────────────────────────────────
    def _write_snapshot(self, directory, chain, db_anchors):
        os.makedirs(directory, exist_ok=True)
        stamp = timezone.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(directory, f"ledger_{stamp}.json")
        doc = {
            "format": SNAPSHOT_FORMAT,
            "taken_at": timezone.now().isoformat(),
            "chain_id": chain["chain_id"],
            "contract": chain["contract"],
            "owner": chain["owner"],
            "restricted": chain["restricted"],
            "total": chain["total"],
            "chain_anchors": [dict(r, recorded_at=_iso(r["timestamp"])) for r in chain["rows"].values()],
            "database_anchors": [
                {"id": a.id, "entity_type": a.entity_type, "entity_ref": a.entity_ref, "stage": a.stage,
                 "data_hash": a.data_hash, "document_hash": a.document_hash, "tx_hash": a.tx_hash,
                 "chain_anchor_id": a.chain_anchor_id, "chain_status": a.chain_status}
                for a in db_anchors
            ],
        }
        data = json.dumps(doc, indent=2, sort_keys=True).encode("utf-8")
        with open(path, "wb") as f:
            f.write(data)
        digest = hashlib.sha256(data).hexdigest()
        with open(path + ".sha256", "w", encoding="ascii") as f:
            f.write(f"{digest}  {os.path.basename(path)}\n")
        self.snapshot_path = path
        self.snapshot_digest = digest

    # ── report ───────────────────────────────────────────────────────────
    def _report(self, chain, db_anchors):
        w = self.stdout.write
        w(f"Ledger {chain['contract']} on chain {chain['chain_id']}")
        w(f"  owner {chain['owner']}, writes {'restricted' if chain['restricted'] else 'open to anyone'}")
        w(f"  {chain['total']} on-chain record(s), {len(db_anchors)} database anchor(s)")
        counts = ", ".join(f"{n} {s}" for s, n in sorted(self.record_counts.items(), key=lambda kv: str(kv[0])))
        w(f"  record checks: {counts or 'none'}")
        if getattr(self, "snapshot_path", None):
            w(f"  snapshot saved: {self.snapshot_path} (sha256 {self.snapshot_digest[:16]}…)")
        for msg in self.warnings:
            self.stdout.write(self.style.WARNING(f"WARNING  {msg}"))
        for msg in self.problems:
            self.stdout.write(self.style.ERROR(f"PROBLEM  {msg}"))
        if not self.problems:
            self.stdout.write(self.style.SUCCESS("OK: the database agrees with the blockchain."))
