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
