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

## 6. Environment variables (names only)

| Variable | Where | Purpose |
|---|---|---|
| `FILE_ENCRYPTION_KEY` | Render | Fernet key for supplier documents, TOTP secrets and backups. **Back it up.** |
| `FILE_ENCRYPTION_OLD_KEYS` | Render | Retired keys during a rotation (comma-separated) |
| `ADMIN_URL` | Render | Secret Django admin path, e.g. `staff-<random>/`. Unset in production means no admin site. |
| `MFA_REQUIRED` | Render | `True` in production (the default when `DEBUG=False`) |
| `TRUSTED_PROXY_COUNT` | Render | Proxies that append to `X-Forwarded-For`. `1` on Render. |
| `SECRET_KEY`, `DB_*`, `AWS_*`, `BREVO_API_KEY`, `BLOCKCHAIN_PRIVATE_KEY` | Render | Existing secrets, unchanged |
| `VITE_API_URL`, `VITE_LEDGER_ADDRESS`, `VITE_SEPOLIA_RPC_URL` | Vercel | Public build-time values. Never put secrets in `VITE_*`. |

## 7. Operations

| Task | Command |
|---|---|
| Unlock an account | `python manage.py unlock_account <username-or-email>` |
| Reset a lost authenticator | `python manage.py reset_mfa <username-or-email>`, after checking the person's identity |
| Encrypt old supplier documents / finish a key rotation | `python manage.py encrypt_supplier_documents` (dry run), then add `--apply` |
| Rotate the encryption key | Move the current key to `FILE_ENCRYPTION_OLD_KEYS`, set a new `FILE_ENCRYPTION_KEY`, deploy, run the command above with `--apply`, then remove the old key |
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
