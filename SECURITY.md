# Security

How ProcurementChain protects procurement data, supplier documents and the
accounts that handle them, and how to operate those protections. Technical
background lives in the docstrings of the files named below.

Report a vulnerability privately to the project maintainers; please do not open
a public issue.

---

## 1. Public bidding IDs

| | |
|---|---|
| Format | `PC-XXXX-XXXX-XXXX`: 12 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ` (no 0/O/1/I/L/U), about 5.3 × 10¹⁷ combinations |
| Generated | Backend only, with Python `secrets` (`next_project_code` in `procurement/views.py`). A unique constraint is enforced, with up to 10 retries on collision. |
| Older codes | `P-2026-004` and `PRC-2026-XXXX-XXXX` are **never rewritten**: each one is the on-chain `entityRef` of its blockchain trail. Lookups accept all three formats. |
| Public trail | `/api/public/procurement/<code>/anchors/` answers only for **published, closed or awarded** projects. Anything else gets the same 404 as an unknown code. |

## 2. Files and documents

All uploads live in a **private** bucket. No storage URL, signed or not, ever
reaches the browser. Every file is served by `procurement/files.py`.

**Who can download what** (everything else is a 404):

| File | Admin | Head | Owning supplier | Other suppliers | Public |
|---|---|---|---|---|---|
| Supplier registration documents, category licenses | ✓ | – | ✓ | – | – |
| Bid documents, attachments, product images | ✓ | – | ✓ (own bid) | – | – |
| ToR, Technical Specifications, Bid Evaluation Criteria, reference image | ✓ | ✓ | eligible suppliers¹ | eligible suppliers¹ | – |
| Purchase Request, Approved Budget document | ✓ | ✓ | – | – | – |
| BAC Resolution, Notice to Proceed | ✓ | ✓ | winner | – | – |
| Notice of Award | ✓ | ✓ | winner | – | ✓ once the project is **awarded** |

¹ Verified, the project's category is one of theirs, and the project is published.

**Downloads.** A click requests `POST /api/files/<kind>/<pk>/<field>/link/`. The
link that comes back:
- works **once** and expires after **2 minutes**
- is bound to the requesting user, and access is re-checked when it is used
- is stored only as a SHA-256 hash

Every download and every refusal is written to the audit log (user, file, time,
IP). Responses carry these headers:
- `Content-Disposition: attachment`
- `X-Content-Type-Options: nosniff`
- `Cache-Control: private, no-store`
- `Content-Security-Policy: default-src 'none'; sandbox`

**Uploads** (`procurement/validators.py`, `procurement/uploads.py`):
- Allow-listed types only (PDF, JPG/PNG/WebP, and DOC/DOCX/XLSX for bids), 5 MB maximum.
- Magic-byte checks. Images must fully decode. Office files must be genuine packages without macros.
- Rejected: dangerous inner extensions (`invoice.exe.pdf`), SVG, HTML and scripts.
- New files are stored as `<folder>/<uuid>.<ext>`. The original file name is kept only in the database.
- Images are re-encoded without EXIF/GPS before storage, so the anchored document hash is the hash of the cleaned file.

**Encryption at rest** (`procurement/storage_crypto.py`):
- Supplier registration documents, category licenses, TOTP secrets and database backups are encrypted with **Fernet** (`FILE_ENCRYPTION_KEY`).
- Bid, project and award documents are not encrypted by the app. Their SHA-256 is anchored on-chain and re-checked by the verifier, so they must stay byte-identical. They rely on the private bucket plus Supabase Storage's AES-256 encryption at rest.
- Files stored before encryption was switched on still open.

**Commitment openings** (`procurement/openings.py`; built, but not active while `PAYLOAD_V3_ENABLED` is off):
- Each salted commitment's exact object is stored encrypted and write-once, with its own key (`COMMITMENT_KEY`), so a leak of one key does not expose what the other protects.
- There is no plaintext fallback: with no valid key, an opening is refused. A failed encryption must never produce a made-up opening.
- A row is checked against its anchor, kind and commitment when decrypted, so a swapped or forged ciphertext is refused.
- Admin and Head can read every opening; a supplier only their own; the public none. Each read is audited as `commitment.opened`. Salts never appear in logs, audit text or errors.
- No URL serves openings yet.

**Storage safety checks** (`procurement/checks.py`):
- `migrate` (and so the Render build) **fails** if the S3 settings would expose files: public ACL, unsigned URLs, custom domain, or long URL expiry.
- The same problems are logged at startup.

## 3. Accounts and sessions

| Protection | Details |
|---|---|
| Rate limits | Login 5 / 15 min per IP; MFA 10 / 15 min per IP. The client IP comes from the proxy-appended `X-Forwarded-For` hop (`TRUSTED_PROXY_COUNT`), so a forged header no longer bypasses the limit. |
| Account lockout | 5 wrong passwords or codes lock an account for **15 minutes** (`accounts/lockout.py`). Unknown usernames get the same answer. Admins unlock from the supplier review modal, the Django admin action, or `manage.py unlock_account <user>`. |
| Two-factor (TOTP) | Required for Admin and Head accounts and the Django admin when `MFA_REQUIRED` is on (default in production). Ten single-use backup codes are issued, stored hashed. Codes cannot be replayed. `manage.py reset_mfa <user>` resets a lost device. |
| Tokens | 15-minute access tokens. 1-day refresh tokens, **rotated** on every refresh, with the old one blacklisted. Logout blacklists the refresh token. The frontend refreshes silently, serialised across tabs. |
| Token storage | Tokens stay in `localStorage`. httpOnly cookies would have to be cross-site (`SameSite=None`) between Vercel and Render, and browsers that block third-party cookies would then break login. The risk is contained instead by the strict CSP (no inline or third-party scripts) and the short token lifetime. |
| Django admin | Mounted only at the secret `ADMIN_URL`, with the same lockout and audit logging plus a TOTP code. |
| Audit log | Append-only: refused by the ORM and, on PostgreSQL, by a database trigger. Records logins, failed logins, locks and unlocks, MFA events, permission denials (403), file downloads and denials, and every procurement action. |

## 4. HTTP headers

The backend (Django) and the frontend (Vercel, `frontend/vercel.json`) both send:
- `Content-Security-Policy`: scripts from the site's own origin only, no inline scripts, no `eval`, `object-src 'none'`, `frame-ancestors 'none'`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`: camera, microphone, geolocation, payment and USB disabled

The SPA's `connect-src` allows only the Render API and the default Sepolia RPC.
**If `VITE_SEPOLIA_RPC_URL` points somewhere else, add that origin to
`connect-src` in `frontend/vercel.json`**, or the public verifier cannot read the chain.

## 5. Blockchain contract

`ProcurementLedger` deploys **unrestricted**: any address may append an anchor.
Forged anchors can't fake a record, because they never match the backend's
hashes, but they add noise. To restrict writes, call these from the **owner**
wallet (the one that deployed the contract), for example in Remix → Deploy &
Run → *At Address* with the contract address:

1. `setWriter(<server signer address>, true)`. Add every wallet that must keep anchoring.
2. `setRestricted(true)`

Choose the signer model first:

- **Server signing** (`BLOCKCHAIN_SERVER_SIGNING=True`): whitelist only the
  server wallet. Simplest and recommended once restricted.
- **MetaMask signing**: every Admin and Head wallet must be whitelisted, and
  suppliers' own wallets would be **rejected**. Supplier bid anchors then need
  server signing.

`setWriter(addr, false)` removes a writer, and `setRestricted(false)` reopens the
ledger. Reads always stay public.

`BLOCKCHAIN_PRIVATE_KEY` must belong to a dedicated test wallet. It is stored
only in Render's environment and never in git or `VITE_*` variables.

### Award disclosure policy

**Working policy, and provisional.** It must be finalized before any v3 anchor is written. The contract amount is public subject to applicable procurement disclosure requirements, which have not been confirmed. `AWARD_PRIVATE_FIELDS` in `procurement/payload_v3.py` stays provisional until this table is consistently reflected in the payload builder, the public API and the verifier.

| Field | Policy | Public API today | v3 payload |
|---|---|---|---|
| Procurement code, name, category, ABC | Public | Yes | In clear (project stages) |
| Winner's registered company name | Public | Yes | Not built |
| Contract amount | Public (working policy) | **Not in the API**; printed on the public Notice of Award file | Not built; outside `AWARD_PRIVATE_FIELDS` |
| Award date (Philippine date, no time) | Public | Yes | Not built |
| Exact award time (`Project.awarded_at`) | Private; committed | Dates only (see "Public times" below) | In `award-private/3` |
| Award document key, version, issue date, hash | Public | Only the hash is in the public trail | Not built |
| `award_id`, `bid_id`, `supplier_id`, award status | Private; committed | No | In `award-private/3` |
| Losing bids, their amounts and outcomes; bid count after award | Never public | No | Only inside salted leaves |
| Salts, openings, internal amendment reasons | Never public | No | Never in clear |

**Open gaps.** No v3 anchor may be written until these are closed:

- **Phase 6:** the contract amount is public by policy but absent from the public API. Its authoritative source, field name and response contract are resolved there; it is deliberately not added before then.
- `award-document/3` is not built, so the policy's payload side is unproven.

**Public times.** The public API gives dates only, as the Philippine date (`record.public_date`): `recorded_at`, `anchored_at`, `chain_checked_at` and `chain_timestamp` in the trail and record details, `document.version.issued_at` and `versions[].issued_at`, and `anchor.created_at` in a public packet. A public packet keeps `recorded.chain_timestamp` exact, because the verifier compares it with the ledger; public packets exist only for stages before any award, and a ledger time is public anyway. The database keeps every exact time, and signed-in viewers still get them.

**Issued PDFs: an irreversible limitation, accepted.** It does not block v3 (decided at Phase 4 review). Notices of Award generated before Phase 4 state their creation time to the second in `/CreationDate` metadata, and anyone who downloads the public file can read it. Their bytes are anchored, so they can't be rewritten: that time is already disclosed, and these files have not been sanitized. New generated PDFs state only the date. An uploaded signed PDF carries whatever metadata its author's software wrote, and the app does not alter or inspect it. So the public API's date-only rule does not cover the contents of public files, and this document does not claim every historical metadata leak is gone.

**Blockchain timing can't be hidden.** Every anchor's block timestamp is public on Sepolia and can't be removed. Anyone can read approximately when a step was recorded, including the award, whatever the API shows. Showing only a date limits what this system publishes; it does not make the timing secret.

## 6. Environment variables (names only)

| Variable | Where | Purpose |
|---|---|---|
| `FILE_ENCRYPTION_KEY` | Render | Fernet key for supplier documents, TOTP secrets and backups. **Back it up.** |
| `FILE_ENCRYPTION_OLD_KEYS` | Render | Retired keys during a rotation (comma-separated) |
| `COMMITMENT_KEY` | Render, only when v3 is approved | Fernet key for commitment openings. Separate from `FILE_ENCRYPTION_KEY`. See custody below. |
| `COMMITMENT_OLD_KEYS` | Render | Retired commitment keys (comma-separated, decrypt only) |
| `PAYLOAD_V3_ENABLED` | Nowhere yet | Must stay unset or `False`. The app refuses to start with it on. |
| `ADMIN_URL` | Render | Secret Django admin path, e.g. `staff-<random>/`. Unset in production means no admin site. |
| `MFA_REQUIRED` | Render | `True` in production (the default when `DEBUG=False`) |
| `TRUSTED_PROXY_COUNT` | Render | Proxies that append to `X-Forwarded-For`. `1` on Render. |
| `SECRET_KEY`, `DB_*`, `AWS_*`, `BREVO_API_KEY`, `BLOCKCHAIN_PRIVATE_KEY` | Render | Existing secrets, unchanged |
| `VITE_API_URL`, `VITE_LEDGER_ADDRESS`, `VITE_SEPOLIA_RPC_URL` | Vercel | Public build-time values. Never put secrets in `VITE_*`. |

### Commitment key custody

Roles, not names; the people are recorded in the custody log, which is kept outside this repository.

| Role | Holds | May not |
|---|---|---|
| Custodian 1 | One full copy of each current and retired key, in their own password-manager vault with MFA | Recover or rotate alone |
| Custodian 2 | A second full copy, in a separate vault with MFA | Recover or rotate alone |
| Deployer | Access to the hosting dashboard where the key is set | Be the only custodian, or keep a copy outside the vaults |

A key is identified only by its fingerprint: the first 8 hex characters of its SHA-256. The app logs fingerprints and counts, never a key.

- **Generate:** Custodian 1 generates a Fernet key in a session that writes nothing to disk or shell history, with Custodian 2 present. Each stores a copy, the Deployer sets it, and both custodians confirm the fingerprint the app logs.
- **Recover:** Custodian 1 retrieves the key, Custodian 2 confirms its fingerprint against the custody log, the Deployer sets it, then runs `check_commitment_openings`.
- **Rotate:** yearly, whenever a custodian changes, and immediately on suspected exposure. Keep a retired key until every backup made before the rotation has expired; only then do both custodians delete it and log the deletion.
- **Backups:** keys are never stored with a database backup, in build logs or in git. The vaults are the only key backup.
- **Lost key:** its openings can never be opened again. Public integrity is unaffected; opening checks report "unavailable", never a mismatch.
- **Leaked key:** with a database copy it opens every commitment under it. Rotate and record the incident. Salts can't be rotated, so exposed openings stay exposed.

### Planned for Phase 6: the `evaluation/3` and `award-document/3` writers

**Not implemented.** The building blocks exist, but nothing writes these anchors or openings in the live system yet. Phase 6 must meet all of this:

| State of an expected anchor | Meaning | How it is identified |
|---|---|---|
| Failed | Nothing was recorded | A failure row, and no anchor |
| Prepared | Anchor and all its openings saved locally; nothing is on-chain | `tx_hash` blank |
| Reported | A transaction was reported, but not confirmed | `tx_hash` set, `verified_on_chain` false |
| Published | Confirmed on-chain by the server | `verified_on_chain` true |

Only Published means the record is on the blockchain. A prepared anchor must never be shown as published.

1. **Persist before signing.** The anchor and all its openings are written in one transaction. Signing or submitting may only start after that transaction commits (`transaction.on_commit`). If it fails, signing does not continue. `record_anchor` can sign immediately today, so the writers can't use it unchanged.
2. **Failure indicator.** If encryption or persistence fails, the transaction rolls back: no anchor, no opening, no placeholder. The business action still succeeds, because anchoring never blocks the business flow. Since no anchor row survives, the indicator is a separate failure row saved outside that transaction: entity, stage, source version, reason code, time, and when it was resolved. It holds no salt, private value or key material, and it is counted on the Admin dashboard. An opening is never invented.
3. **Recovery.** A management command, dry run by default, rebuilds a failed anchor from its stored source (for example an `AwardDocumentVersion`) once the cause is fixed. Fresh salts are safe only here, because nothing was published. If the source no longer matches the failure, it reports that and does not guess.
4. **Duplicate prevention.** Each expected anchor has one database-enforced identity (entity, stage, source version). A signing retry reuses the same anchor, salts and `data_hash`; it never creates new ones.
5. **Tests.** Failure at each step leaves no partial state and sends nothing. Signing never runs before commit, or after a failed commit. Recovery restores the opening and resolves the failure row, and running it twice changes nothing. Concurrent writers produce one anchor. Each state above is reported correctly.

## 7. Operations

| Task | Command |
|---|---|
| Unlock an account | `python manage.py unlock_account <username-or-email>` |
| Reset a lost authenticator | `python manage.py reset_mfa <username-or-email>`, after checking the person's identity |
| Encrypt old supplier documents / finish a key rotation (also re-encrypts two-factor secrets) | `python manage.py encrypt_supplier_documents` (dry run), then add `--apply` |
| Rotate the encryption key | Move the current key to `FILE_ENCRYPTION_OLD_KEYS`, set a new `FILE_ENCRYPTION_KEY`, deploy, run the command above with `--apply`, then remove the old key |
| Rotate the commitment key | Move the current key to `COMMITMENT_OLD_KEYS`, set a new `COMMITMENT_KEY`, deploy, run `python manage.py rotate_commitment_openings` (dry run), then add `--apply`. Keep the old key as described under custody. |
| Check commitment openings (after a restore or recovery) | `python manage.py check_commitment_openings`. Read-only; exits with an error unless every opening matches. |
| Copy files left on a local disk into the bucket | `python manage.py migrate_media_to_bucket --source <dir>` (dry run), then add `--apply`. Byte-for-byte and SHA-256-checked. |
| Back up the database | `python manage.py backup_db` writes an encrypted `.json.enc`. Restore with `backup_db --decrypt <file>`, then `loaddata`. `backups/` is gitignored. |

**Local development:** `backend/.env` points `DB_HOST` at the production
database. Run every non-test `manage.py` command as `DB_HOST= python manage.py ...`
so it uses local SQLite. Tests always use SQLite.

## 8. Known limits

- Access tokens stay valid for up to 15 minutes after logout (refresh tokens are revoked immediately).
- Without `REDIS_URL`, rate-limit counters are per worker process. The per-account lockout is stored in the database and is not affected.
- The audit-log trigger protects against application bugs and a compromised app connection, not against the database owner.
- Anchored documents are protected by access control and provider encryption, not app-level encryption (see section 2).
