# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot, etc.)
working in this repository. Human-facing docs live in [README.md](README.md),
[BLOCKCHAIN.md](BLOCKCHAIN.md) and [backend/README.md](backend/README.md).
Domain background (roles, lifecycle, statuses, anchoring stages) is in
[knowledge.md](knowledge.md) — read it before touching procurement logic.

## Project at a glance

E-Procurement system with a blockchain audit trail (capstone project).

| Part | Stack | Path |
|------|-------|------|
| Frontend | React 19 + Vite 8, React Router 7, lucide-react, jsPDF, ethers v6 (plain JSX, no TypeScript; unit tests with `node --test`) | `frontend/` |
| Backend | Django 6 + DRF + SimpleJWT, fpdf2, optional web3.py | `backend/` |
| Contract | Solidity 0.8 `ProcurementLedger` on Sepolia testnet | `contracts/` |
| Deploy | Render (API, `render.yaml`), Vercel (SPA, `frontend/vercel.json`), Supabase (Postgres + S3 storage) | — |

The system is **live in production**. `main` deploys automatically, so treat
every change as a production change.

## Commands

```bash
# Backend (from backend/, venv activated: venv\Scripts\activate on Windows)
pip install -r requirements.txt
python manage.py migrate
python manage.py seed          # demo data + admin/head/supplier accounts — LOCAL SQLite only;
                               # refuses any remote/production DB. Existing data needs --wipe-local-data
python manage.py runserver     # http://127.0.0.1:8000
python manage.py test          # always runs on local SQLite (see settings.RUNNING_TESTS)
python manage.py makemigrations --check --dry-run   # confirm no missing migrations

# Frontend (from frontend/)
npm install
npm run dev                    # http://localhost:3000
npm test                       # unit tests (node --test) — must pass
npm run build                  # must pass

# Both together (from repo root)
npm run dev
```

## Code map

- `backend/procurement/models.py` — Supplier, Project, Bid, BidAttachment, Award, Document, BlockchainAnchor, Notification
- `backend/procurement/views.py` — ViewSets; every status transition is an `@action` that saves, notifies, audit-logs, then anchors
- `backend/procurement/blockchain.py` — canonical payloads, hashing, `anchor_project/bid/award`, verification, optional server signing
- `backend/procurement/canonical.py` — `hash_payload` (never change it) and the strict v3 validator
- `backend/procurement/payload_v2.py` — frozen v2 builders; never edit
- `backend/procurement/payload_v3.py` — v3 kinds and schemas. Off behind `PAYLOAD_V3_ENABLED`; `AWARD_PRIVATE_FIELDS` is provisional (Decision A)
- `backend/procurement/payload_v3_reader.py` — read-only v3 verification and evidence completeness (`blockchain.READ_ONLY_RULES`); can't write
- `backend/procurement/document_evidence.py` — checks an anchor's document against the exact version it fingerprinted
- `backend/procurement/verification.py` — the five verification outcomes, with what was and wasn't checked
- `backend/procurement/project_documents.py` — `ProjectDocumentVersion` history and the five-document manifest
- `backend/procurement/openings.py` — encrypted `CommitmentOpening` rows, `COMMITMENT_KEY` handling, access and audit. Commands: `rotate_commitment_openings`, `check_commitment_openings`
- `backend/procurement/management/commands/audit_ledger.py` — read-only check of the whole database against the on-chain ledger; incident steps in [RECOVERY.md](RECOVERY.md)
- `backend/procurement/permissions.py` — role permissions (admin / head / supplier)
- `backend/accounts/` — custom User (role field), JWT auth, MFA, password reset, `audit.log_action`, throttling
- `frontend/src/api.js` — **all** HTTP calls go through `apiFetch` / `apiUpload` wrappers here
- `frontend/src/store/projectsStore.js` — shared project state hook (`useProjects`) + action helpers
- `frontend/src/blockchain/` — `contract.js` (address/ABI), `anchor.js` (MetaMask + chain reads), `anchorStore.js` (progress/retry)
- `frontend/src/pages/` — one large page component per role dashboard; styles in `frontend/src/style/`

## Rules (do not break these)

1. **Never rename or remove a `BlockchainAnchor.Stage` value.** The strings are written on-chain; the vocabulary is append-only.
2. **Never change the shape of an existing canonical payload** in `blockchain.py` without bumping `PAYLOAD_VERSION` and keeping the legacy verification path. Changing it silently makes every existing anchor verify as "altered".
3. **Anchoring must never block the business flow.** The DB change is committed first; the anchor is a follow-up that may be `null`. Don't raise from anchoring code paths.
4. **Nothing personal goes on-chain** — only hashes, entity type, procurement code and stage. The public anchors endpoint exposes hashes only, never payloads.
5. **Don't edit applied migrations.** Add a new migration instead. Run `makemigrations --check` before committing model changes.
6. **Tests must not hit Supabase.** Keep the `RUNNING_TESTS` SQLite override in `config/settings.py` intact.
7. **Secrets stay out of git and out of `VITE_*` vars** (those ship to the browser). `BLOCKCHAIN_PRIVATE_KEY`, DB passwords, SMTP passwords belong only in `.env` / Render / Vercel dashboards.
8. **Frontend HTTP goes through `api.js`** — don't call `fetch` directly from pages; the wrappers handle JWT refresh and errors.
9. Currency is Philippine peso (`₱`). Keep the existing shared dark-sidebar dashboard layout consistent across roles.
10. Work on a feature branch, not `main`. Commit only when asked.

## Conventions

- Python: follow the existing style — explanatory docstrings/comments on *why*, `TextChoices` for statuses, `@action(detail=True, methods=["post"], url_path="kebab-case")` for transitions.
- Every state transition in a view should: update the model → `notify_users(...)` → `log_action(...)` → `anchor_*()` → `anchored_response(...)`.
- Frontend: functional components + hooks, plain CSS files per page, `lucide-react` icons. No new UI libraries without asking.
- Add regression tests to `backend/procurement/test_regressions.py` for bug fixes, feature tests to `tests.py`.

## Definition of done

- `python manage.py test` passes (from `backend/`)
- `python manage.py makemigrations --check --dry-run` reports no changes (unless you intentionally added a migration)
- `npm test` passes and `npm run build` succeeds (from `frontend/`)
- No secrets, `.env`, `db.sqlite3`, `venv/` or `node_modules/` staged
