# E-Procurement System

A full-stack procurement management web application built as a capstone project. It covers the complete lifecycle of a public/organizational procurement process — from project creation and multi-level approval, to supplier bidding, document review, contract awarding, and public transparency reporting — enforced through three distinct user roles with JWT-authenticated access control.

---

## Features

### Procurement Lifecycle
- **Project Planning** — Admin creates procurement projects with category, budget (ABC), procurement type, delivery location, required documents (Purchase Request, Technical Specifications, Terms of Reference, Approved Budget, Bid Evaluation Criteria), and a bidding period
- **Head Approval** — Department Head reviews submitted projects, can approve, reject, or flag specific documents for revision without rejecting the whole project
- **Publishing & Bidding** — Admin publishes approved projects; bidding deadline is computed automatically on publish (today + bidding period), eliminating stale deadlines. Published projects are only visible to eligible suppliers (matched by business category)
- **Bid Submission** — Verified suppliers submit bids with supporting documents; one bid per supplier per project enforced; expired bidding windows automatically close
- **Bid Evaluation** — Admin reviews submitted bids, can qualify/disqualify, flag individual documents for revision, and select a winner
- **Contract Awarding** — Selecting a winner creates an Award record; expected delivery date is computed at award time (award date + delivery period)
- **Public Transparency Portal** — `/public` — anyone (no login required) can view open biddings and awarded contracts/winners

### Supplier Management
- Multi-step supplier registration with document uploads (SEC/DTI, Mayor's Permit, PhilGEPS Certificate, Tax Clearance, etc.)
- Email verification on registration
- Admin document review with per-document approve/flag/revision workflow
- Suppliers can self-update their business categories from Settings, with eligibility re-evaluated immediately

### Notifications
- In-app notification bell for Admin, Head, and Supplier
- Triggered on: new supplier registration, project status changes, bid evaluation results, document revision requests

### Security
- JWT authentication with token blacklisting on logout
- Rate limiting on login (5/15 min), registration, and password reset endpoints
- **Two-Factor Authentication (MFA)** for Admin and Head accounts — email OTP on every login when enabled
- Password reset via email with time-limited signed tokens
- Security headers enabled in production (`DEBUG=False`)

### Reports & Data
- Admin Reports page with procurement statistics, supplier performance, and award summaries
- CSV and PDF export of reports
- Manual DB backup via `python manage.py backup_db`

---

## Tech Stack

| Layer       | Technology |
|-------------|-----------|
| Frontend    | React 19, Vite, React Router 7, Lucide React, jsPDF |
| Backend     | Django 6, Django REST Framework, SimpleJWT |
| Database    | PostgreSQL via Supabase (SQLite for local dev) |
| File Storage | S3-compatible (Supabase Storage / AWS S3) |
| Deployment  | Render (backend API), Vercel (frontend) |
| Email       | SMTP (Gmail) via Django's email backend |

---

## Project Structure

```
Capstone-project/
├── frontend/               # React + Vite SPA
│   └── src/
│       ├── pages/          # AdminDashboard, HeadDashboard, SupplierDashboard, LoginPage, ...
│       ├── components/     # Shared components (Skeleton, NotificationBell, LegalPageLayout)
│       ├── store/          # projectsStore.js — API-backed shared project state
│       ├── style/          # Per-dashboard CSS files
│       ├── constants/      # categories.js
│       └── api.js          # All fetch wrappers
├── backend/
│   ├── accounts/           # Custom User model, auth, MFA, password reset, throttling
│   └── procurement/        # Supplier, Project, Bid, Award, Document, Notification models + REST API
│       └── management/
│           └── commands/
│               ├── seed.py       # Demo data + role accounts
│               └── backup_db.py  # Manual DB export
├── render.yaml             # Render deployment blueprint
└── README.md
```

---

## User Roles

| Role         | Access |
|--------------|--------|
| **Admin**    | Full system access: create projects, manage suppliers, publish, evaluate bids, award contracts, view reports, manage MFA |
| **Head**     | Review and approve/reject/flag projects before they can be published, manage MFA |
| **Supplier** | Register, browse eligible projects, submit bids, track status, update profile/business types |
| **Public**   | View open biddings and awarded contracts (no login required) |

---

## Getting Started (Local Development)

### Prerequisites
- Python 3.11+
- Node.js 18+

### 1. Clone the repository

```bash
git clone https://github.com/Kenth08/CAPSTONE-BIDDING-SYSTEM.git
cd CAPSTONE-BIDDING-SYSTEM
```

### 2. Backend setup

```bash
cd backend
python -m venv venv

# Windows
venv\Scripts\activate
# macOS/Linux
source venv/bin/activate

pip install -r requirements.txt

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your database credentials (or leave DB_* blank to use SQLite)

python manage.py migrate
python manage.py seed        # loads demo data and role accounts
python manage.py runserver   # http://127.0.0.1:8000
```

### 3. Frontend setup

```bash
cd frontend
npm install
npm run dev                  # http://localhost:3000
```

---

## Demo Accounts

| Username   | Role     | Notes |
|------------|----------|-------|
| `admin`    | Admin    | Django superuser — also access `/admin/` |
| `head`     | Head     | |
| `supplier` | Supplier | Pre-verified demo account |

Passwords are set when running `python manage.py seed`. Check the seed command output or ask the system administrator for credentials.

> **Note:** Admin and Head accounts log in with a plain username (not an email). To use Two-Factor Authentication, go to the **Security** page (dropdown in the top-right header) and set an MFA email address first.

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Description |
|----------|-------------|
| `SECRET_KEY` | Django secret key (auto-generated if not set in dev) |
| `DEBUG` | `True` for development, `False` in production |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT` | PostgreSQL connection (Supabase). Leave unset to use SQLite locally |
| `FRONTEND_URL` | Frontend origin for CORS and password reset links (e.g. `https://your-app.vercel.app`) |
| `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USE_TLS`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `DEFAULT_FROM_EMAIL` | SMTP settings for email delivery (password reset, MFA codes, email verification). Unset = console backend |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_STORAGE_BUCKET_NAME`, `AWS_S3_ENDPOINT_URL` | S3-compatible file storage (Supabase Storage or AWS S3). Unset = local media/ folder |

### Frontend (`frontend/.env`)

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Backend API base URL (e.g. `https://your-api.onrender.com/api`). Defaults to `http://127.0.0.1:8000/api` |

---

## API Overview

Base URL: `http://127.0.0.1:8000/api/`

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/auth/login/` | Login with username/email + password. Returns JWT tokens + user info. If MFA is enabled, returns `mfa_required: true` instead |
| `POST` | `/auth/mfa/confirm/` | Submit MFA code to complete login |
| `POST` | `/auth/logout/` | Blacklist refresh token |
| `POST` | `/auth/refresh/` | Refresh access token |
| `GET` / `PATCH` | `/auth/me/` | Get or update current user |
| `POST` | `/auth/register/supplier/` | Supplier self-registration (multipart) |
| `POST` | `/auth/password/reset/` | Request password reset email |
| `POST` | `/auth/password/reset/confirm/` | Confirm password reset |
| `POST` | `/auth/mfa/send-code/` | Send MFA setup/disable code to email |
| `POST` | `/auth/mfa/enable/` | Verify code and enable MFA |
| `POST` | `/auth/mfa/disable/` | Verify code and disable MFA |

### Resources (require `Authorization: Bearer <access>`)
| Endpoint | Description |
|----------|-------------|
| `/projects/` | Project CRUD + `publish`, `approve`, `reject`, `request-revision`, `resubmit-documents`, `bid` actions |
| `/suppliers/` | Supplier list/detail + `approve`, `reject`, `request-revision`, `resubmit` actions |
| `/bids/` | Bid list/detail + `qualify`, `disqualify`, `select-winner`, `request-revision`, `resubmit-documents` actions |
| `/awards/` | Award records |
| `/documents/` | Supplier compliance document records |
| `/notifications/` | In-app notifications + `mark-read` action |
| `/public/procurement/` | Public procurement results (no auth required) |

---

## Deployment

The app is deployed using:
- **Backend** → [Render](https://render.com) (Web Service, Gunicorn)
- **Frontend** → [Vercel](https://vercel.com)
- **Database** → [Supabase](https://supabase.com) (PostgreSQL)
- **File Storage** → Supabase Storage (S3-compatible)

### Deploy via Render Blueprint

```bash
# Push to GitHub, then in Render:
# New → Blueprint → select this repository
# Fill in environment variables in the Render dashboard
```

### Manual backup

```bash
python manage.py backup_db              # saves to backups/ folder
python manage.py backup_db -o /my/path  # custom output directory
python manage.py loaddata <file>        # restore from backup
```

---

## Procurement Flow Diagram

```
Admin creates project (Planning)
        │
        ▼
Head reviews → Approve / Reject / Flag documents for revision
        │
        ▼ (approved)
Admin publishes → Bidding deadline computed (today + bidding period)
        │
        ▼
Eligible suppliers submit bids (with documents)
        │
        ▼
Admin evaluates bids → Qualify / Disqualify / Flag bid documents
        │
        ▼
Admin selects winner → Award created, delivery date computed
        │
        ▼
Public Results Portal shows awarded contract
```

---

## License

This project was developed as an academic capstone project.
