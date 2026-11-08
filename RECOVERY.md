# Backup and recovery runbook

What to back up, how to check a backup works, and what to do step by step if
the system is attacked or loses data. For security rules and key custody, see
[SECURITY.md](SECURITY.md). For the contract, see [contracts/README.md](contracts/README.md).

## What the blockchain protects, and what it doesn't

The ledger can't be hijacked in the sense of changing history. `ProcurementLedger`
has no update or delete function, so a recorded hash stays as written. An
attacker can still do damage in other places:

| What an attacker gets | What they can do | What stops or catches it |
|---|---|---|
| Write access to the database | Edit a record, delete it, or edit a record **and** its stored hash together | `audit_ledger` compares every stored hash with the ledger's own copy. The normal check can't catch the third case, because both copies it compares are in the database |
| The server signing key (`BLOCKCHAIN_PRIVATE_KEY`) | Write official-looking anchors | `audit_ledger` lists on-chain records that the database doesn't know. A forged anchor can't make an edited record verify, because the record's hash must still match |
| The contract owner's wallet | Restrict writes, or remove your signer, so new anchors fail | Existing anchors stay safe and readable. New anchors fail without blocking the business flow. Recovery: scenario C |
| Any wallet, while the ledger is unrestricted | Add junk anchors | Nothing to recover: no record matches a junk hash. `audit_ledger` counts them as warnings |
| The hosting account | Read secrets, change code | Rotate every secret, restore from a backup taken before the breach (scenario F) |

The blockchain is the witness, not the backup: it holds hashes, not the data.
The data itself must be restored from database and file backups.

## What to back up

| What | Where it lives | How it is backed up | How often |
|---|---|---|---|
| Database (users, projects, bids, awards, anchors, audit log) | Supabase Postgres | Supabase automatic backups (daily, 7 days on the free plan; point-in-time on Pro). Plus `python manage.py backup_db`, encrypted, with a `.sha256` | Weekly and before every deploy that has a migration |
| Uploaded documents | Supabase Storage bucket `procurement-docs` | Copy the bucket with any S3 tool to storage you control | Weekly |
| Ledger snapshot | Sepolia contract | `python manage.py audit_ledger --snapshot ledger_snapshots/` | With each database backup |
| Keys: `FILE_ENCRYPTION_KEY`, `COMMITMENT_KEY`, owner wallet seed phrase, signer key | Hosting dashboards and wallets | Two password-manager vaults ([SECURITY.md](SECURITY.md#commitment-key-custody)). **Never stored with a backup** | When created or rotated |

Keep at least one copy of the backups off the hosting accounts. Someone who
breaks into the server should not be able to delete the backups too.

## Routine checks

```bash
# from backend/. Locally, prefix with DB_HOST= so these use SQLite, not production
python manage.py backup_db                                   # writes backups/backup_<time>.json.enc + .sha256
python manage.py backup_db --verify backups/backup_<time>.json.enc
python manage.py audit_ledger --expect-owner 0x<owner address> --snapshot ledger_snapshots/
```

- `backup_db --verify` checks the checksum, decrypts in memory, and counts the
  records. It writes nothing. A backup that hasn't been verified hasn't been
  shown to work.
- `audit_ledger` is read-only. It exits with an error if it finds a problem or
  can't reach the chain. Read every `PROBLEM` line. `WARNING` lines need a look
  but are not evidence of an attack.
- Once a term, restore a backup into a **separate** Supabase project and run
  `audit_ledger` against it. That is the only full test of a restore.

## Incident steps

Do them in order. Write down what you do and when; the audit log does not cover
work done outside the app.

### A. The database was changed (`audit_ledger` reports a mismatch, a deleted record, or a changed anchor)

1. **Stop writes.** Scale down every backend that uses the database. Heroku and
   Render both point at the same Supabase database, so stop both
   (`heroku ps:scale web=0 -a e-procurement`, and suspend the Render service).
2. **Keep the evidence.** Run `backup_db` and `audit_ledger --snapshot` now, and keep
   both files with the incident notes. Don't restore over the only copy of the
   altered data.
3. **Close the way in.** Change the database password in Supabase, update `DB_PASSWORD`
   on every host, and rotate `SECRET_KEY` (this signs everyone out).
4. **Restore** to a point before the change (scenario B).
5. **Check.** Run `audit_ledger --deep` and `check_commitment_openings`. Both must pass
   before the backends are scaled back up.
6. Reset the passwords of the accounts that could have been used, and record
   the incident.

### B. Restore the database

1. Choose the restore point: the latest backup taken **before** the incident.
   Prefer Supabase's own backup (Dashboard → Database → Backups), because it
   includes everything.
2. With a `backup_db` file instead:
   ```bash
   python manage.py backup_db --verify backups/backup_<time>.json.enc   # must say Checksum OK
   python manage.py backup_db --decrypt backups/backup_<time>.json.enc
   python manage.py migrate                                             # on an EMPTY database
   python manage.py loaddata backups/backup_<time>.json
   # then delete the decrypted .json: it holds password hashes and personal data
   ```
   Restore into a separate project first, check it, and only then switch the
   hosts to it.
3. Restore the document bucket from its copy if files were lost or replaced.
4. Run `python manage.py audit_ledger --deep`.
   - `On-chain record N ... the database has no such anchor`: a step that was
     done after the backup. The ledger proves it happened (code, stage, time).
     Re-enter it from the paper record or the emails, then check again.
   - `could not be checked ... missing from storage`: restore that file from the
     bucket copy.
5. Run `python manage.py confirm_anchors` (preview) and then `--apply`.

### C. The contract owner wallet is stolen

The owner can't change or delete anchors. It can only restrict writes, change
writers, or transfer ownership.

1. If the owner is still yours, quickly `transferOwnership` to a fresh wallet,
   ideally a multisig (Safe) or a hardware wallet.
2. If the attacker already took ownership, new anchors will fail. The business
   flow continues and records show "not anchored". The existing trail stays
   readable and verifiable.
3. Recovery means deploying a new `ProcurementLedger` from a clean wallet
   ([contracts/README.md](contracts/README.md)) and pointing `LEDGER_CONTRACT_ADDRESS` and
   `VITE_LEDGER_ADDRESS` at it. **Known limit:** verification currently reads a single
   contract address, so anchors on the old contract stop verifying in the app until
   multi-contract reading is added. They remain on Sepolia and can still be checked
   on a block explorer. Plan this change before switching.

### D. The server signing key is stolen (`BLOCKCHAIN_PRIVATE_KEY`)

1. Set `BLOCKCHAIN_SERVER_SIGNING=False` on every host, so the key stops being used.
2. Create a new wallet and fund it with Sepolia ETH. Set it as the new key.
3. If the ledger is restricted, from the owner wallet: `setWriter(<new>, true)`,
   then `setWriter(<old>, false)`.
4. Run `audit_ledger --trusted <old>,<new>`. Every record the old key wrote after the
   theft that the database doesn't know is reported as a `PROBLEM`. Note them in the
   incident record. They can't make an edited record verify.
5. Turn server signing back on.

### E. The encryption key is lost (`FILE_ENCRYPTION_KEY`)

Backups and supplier documents made with that key can't be opened. Get the key
from a custodian's vault ([SECURITY.md](SECURITY.md#commitment-key-custody)). There is
no other way back. Verify with `backup_db --verify` on a recent backup.

### F. The hosting account (Heroku, Render, Vercel, Supabase) is compromised

1. Secure the account: change its password, enable two-factor authentication,
   and revoke API tokens.
2. Rotate every secret in [SECURITY.md](SECURITY.md#6-environment-variables-names-only):
   `SECRET_KEY`, database password, email API key, `BLOCKCHAIN_PRIVATE_KEY` (scenario D).
   Rotate `FILE_ENCRYPTION_KEY` through its normal rotation steps.
3. Redeploy from a known commit on GitHub, not from the host's copy.
4. Follow scenario A to check the data.

## Hardening still open

These need the owner wallet or a hosting change, so they are not done automatically:

- **Restrict the ledger.** From the owner wallet: `setWriter` for the server signer
  (and any Admin MetaMask wallets still used), then `setRestricted(true)`. After
  that, writes from strangers are refused, and any that `audit_ledger` sees count as
  problems. Pick the signer model first ([contracts/README.md](contracts/README.md)).
- **Move ownership to a multisig or hardware wallet**, so one stolen laptop can't
  take the contract.
- **Schedule the checks.** Run `backup_db` and `audit_ledger` weekly (for example
  with Heroku Scheduler) and send the output to the Admin.
- **Use a history-keeping Sepolia RPC** for `SEPOLIA_RPC_URL`, so old transactions
  can still be read back.
