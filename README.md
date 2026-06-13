# E-Procurement System

A procurement management system with three roles — **Admin**, **Head**, and
**Supplier** — covering the full flow: project creation, head approval,
publishing, supplier bidding, evaluation, and awarding.

## Stack

| Layer    | Tech                                            |
|----------|-------------------------------------------------|
| Frontend | React 19 + Vite, React Router, lucide-react     |
| Backend  | Django + Django REST Framework, JWT auth, SQLite|

## Project layout

```
Capstone-project/
├─ frontend/   # React + Vite UI            (see frontend/README.md)
└─ backend/    # Django + DRF REST API      (see backend/README.md)
```

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
venv\Scripts\activate
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
| `admin`    | admin    |
| `head`     | head     |
| `supplier` | supplier |
