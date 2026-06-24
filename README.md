# E-Procurement System

A full-stack procurement management system covering the complete lifecycle of a
public/organizational procurement process — project creation, head approval,
publishing, supplier registration & bidding, document review, evaluation, and
contract awarding — built around three distinct user roles.

## Roles & Flow

| Role         | Capabilities                                                                 |
|--------------|-------------------------------------------------------------------------------|
| **Admin**    | Create projects, manage suppliers (review documents/accreditation), publish approved projects, evaluate bids, award contracts, view reports |
| **Head**     | Review and approve/reject projects submitted by Admin before they can be published |
| **Supplier** | Register & upload accreditation documents, browse published projects, submit bids with attachments, track bid status, view award/notification history |

Public visitors can also view award results without logging in via the
**Public Results** page.

## Stack

| Layer    | Tech                                                                  |
|----------|------------------------------------------------------------------------|
| Frontend | React 19 + Vite, React Router 7, lucide-react icons, jsPDF (report export) |
| Backend  | Django 6 + Django REST Framework, JWT auth (SimpleJWT), SQLite (dev) / PostgreSQL (prod) |
| Deployment | Render (backend API + frontend static site), Supabase (Postgres), see [render.yaml](render.yaml) |

## Project layout

```
Capstone-project/
├─ frontend/   # React + Vite UI            (see frontend/README.md)
├─ backend/    # Django + DRF REST API      (see backend/README.md)
└─ render.yaml # Render Blueprint for deployment
```

### Frontend pages
`LandingPage`, `LoginPage`, `ForgotPasswordPage` / `ResetPasswordPage`,
`SupplierRegister`, `PublicResultsPage`, and role dashboards
`AdminDashboard`, `HeadDashboard`, `SupplierDashboard`.

### Backend apps
- **accounts** — custom `User` model with `role` (admin/head/supplier), auth, throttling
- **procurement** — `Supplier`, `Project`, `Bid`, `BidAttachment`, `Award`, `Document`, `Notification` models + REST endpoints

## Running locally

### One command (recommended)

From the project root, this starts **both** the backend and frontend together:

```bash
npm install      # first time only (installs the launcher)
npm run dev
```

- Backend → http://127.0.0.1:8000
- Frontend → http://localhost:3000

Press `Ctrl+C` once to stop both. Logs are labelled `[BACKEND]` / `[FRONTEND]`.

> First-time setup: make sure `cd frontend && npm install` and the backend
> steps below (venv + migrate + seed) have been run once.

### Or run them separately (two terminals)

**Backend** (port 8000):
```bash
cd backend
py -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py seed            # loads demo data + role accounts
python manage.py runserver
```

**Frontend** (port 3000):
```bash
cd frontend
npm install
npm run dev
```

## Demo accounts (password: `password123`)

| username   | role     |
|------------|----------|
| `admin`    | admin (also a Django superuser → `/admin/`) |
| `head`     | head     |
| `supplier` | supplier |

## API overview

Base URL: `http://127.0.0.1:8000/api/`

### Auth
| Method | Endpoint           | Body                        | Returns                   |
|--------|--------------------|------------------------------|----------------------------|
| POST   | `/auth/login/`     | `{username, password}`      | `{access, refresh, user}` |
| POST   | `/auth/register/`  | `{username, password, ...}` | new user                  |
| POST   | `/auth/refresh/`   | `{refresh}`                 | `{access}`                |
| GET    | `/auth/me/`        | (Bearer token)               | current user               |

### Resources (require `Authorization: Bearer <access>`)
- `/api/projects/` (+ `/api/projects/stats/`, `POST /api/projects/{id}/publish/`)
- `/api/suppliers/`
- `/api/bids/`
- `/api/awards/`
- `/api/documents/`

Standard REST verbs apply: `GET` list, `POST` create, `GET`/`PUT`/`PATCH`/`DELETE` on `/{id}/`.

See [backend/README.md](backend/README.md) for full backend setup and API details, and [frontend/README.md](frontend/README.md) for frontend-specific notes.

## Deployment

The app deploys as two Render services defined in [render.yaml](render.yaml):

- **eprocurement-api** — Django backend (Gunicorn), connects to a Supabase Postgres database
- **eprocurement-frontend** — static React build

Push to your repo, then in Render: **New → Blueprint** and select this repo.
Fill in the `sync: false` environment variables (Supabase DB credentials,
`FRONTEND_URL`, `VITE_API_URL`, optional SMTP settings) via the Render dashboard.

## Environment variables

See `backend/.env.example` for the full list of backend environment variables
(database connection, `SECRET_KEY`, `DEBUG`, CORS/`FRONTEND_URL`, email/SMTP).
The frontend reads `VITE_API_URL` to know where the API is hosted.
