# E-Procurement Backend (Django + DRF)

REST API for the E-Procurement system. Replaces the frontend's hardcoded
data and `localStorage` role hack with a real database and JWT auth.

## Setup

```bash
cd backend
py -m venv venv
venv\Scripts\activate            # Windows
pip install -r requirements.txt
python manage.py migrate
python manage.py seed            # loads demo data + role accounts
python manage.py runserver       # http://127.0.0.1:8000
```

## Demo accounts

| username   | role     |
|------------|----------|
| `admin`    | admin    |
| `head`     | head     |
| `supplier` | supplier |

Passwords are printed to the console when `python manage.py seed` runs.
`admin` is also a Django superuser → log into `/admin/`.

## Running tests

```bash
python manage.py test
```

Tests always run against a **local SQLite** database, even when `.env` points
`DB_HOST` at Supabase. Without that rule the test runner would create a
`test_postgres` database on the live server — slow, unusable offline, and it
consumes free-tier storage (an interrupted run leaves the database behind).

This is safe because nothing here is PostgreSQL-specific: every JSON column is
Django's cross-database `models.JSONField`, and there is no raw SQL or
full-text search. See the `RUNNING_TESTS` block in
[`config/settings.py`](config/settings.py).

To verify against PostgreSQL instead — prefer a **local** instance, not Supabase:

```bash
TEST_USE_POSTGRES=1 python manage.py test
```

## API

Base URL: `http://127.0.0.1:8000/api/`

### Auth
| Method | Endpoint           | Body                       | Returns               |
|--------|--------------------|----------------------------|-----------------------|
| POST   | `/auth/login/`     | `{username, password}`     | `{access, refresh, user}` |
| POST   | `/auth/register/`  | `{username, password, ...}`| new user              |
| POST   | `/auth/refresh/`   | `{refresh}`                | `{access}`            |
| GET    | `/auth/me/`        | (Bearer token)             | current user          |

### Resources (all require `Authorization: Bearer <access>`)
- `/api/projects/`  (+ `/api/projects/stats/`, `POST /api/projects/{id}/publish/`)
- `/api/suppliers/`
- `/api/bids/`
- `/api/awards/`
- `/api/documents/`

Standard REST: `GET` list, `POST` create, `GET/PUT/PATCH/DELETE /{id}/`.
