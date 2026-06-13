# E-Procurement Frontend (React + Vite)

React UI for the E-Procurement system, with three role dashboards:
Admin, Head, and Supplier.

## Setup

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
```

## Scripts

| Command           | Description                          |
|-------------------|--------------------------------------|
| `npm run dev`     | Start the Vite dev server (port 3000)|
| `npm run build`   | Build for production into `dist/`    |
| `npm run preview` | Preview the production build locally |

## Structure

```
src/
├─ main.jsx              # entry point
├─ App.jsx               # routes (landing, login, role dashboards)
├─ index.css            # global styles + CSS variables
├─ pages/                # LandingPage, LoginPage, Admin/Head/SupplierDashboard
└─ style/                # one CSS file per page
```

## Backend

The API lives in `../backend` (Django + DRF). Start it on port 8000 so the
frontend can authenticate and load data. See `backend/README.md`.
