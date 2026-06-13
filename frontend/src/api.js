// Central API layer for talking to the Django backend.
const API_URL = 'http://127.0.0.1:8000/api'

// ── Session storage ───────────────────────────────────────────────────────────
export function saveSession({ access, refresh, user }) {
  localStorage.setItem('access', access)
  localStorage.setItem('refresh', refresh)
  localStorage.setItem('role', user.role)
  localStorage.setItem('user', JSON.stringify(user))
}

export function clearSession() {
  localStorage.removeItem('access')
  localStorage.removeItem('refresh')
  localStorage.removeItem('role')
  localStorage.removeItem('user')
}

export const getToken = () => localStorage.getItem('access')
export const getRole = () => localStorage.getItem('role')

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function apiLogin(username, password) {
  const res = await fetch(`${API_URL}/auth/login/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error('Invalid username or password.')
  return res.json() // { access, refresh, user }
}

// Multi-step supplier registration with document uploads (multipart/form-data).
// `data` is a FormData instance — do NOT set Content-Type; the browser adds the
// correct multipart boundary automatically.
export async function apiRegisterSupplier(formData) {
  const res = await fetch(`${API_URL}/auth/register/supplier/`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const msg = Object.entries(err)
      .map(([field, val]) => `${field}: ${Array.isArray(val) ? val.join(' ') : val}`)
      .join('\n')
    throw new Error(msg || 'Registration failed.')
  }
  return res.json()
}

// ── Authenticated requests (for wiring dashboard data later) ───────────────────
export async function apiFetch(path, options = {}) {
  const token = getToken()
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (res.status === 401) {
    clearSession()
    throw new Error('Session expired. Please log in again.')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `Request failed (${res.status}).`)
  }
  return res.status === 204 ? null : res.json()
}

// Authenticated multipart upload (no Content-Type header — the browser sets the
// multipart boundary). Used for supplier document re-submission.
async function apiUpload(path, formData, method = 'POST') {
  const token = getToken()
  const res = await fetch(`${API_URL}${path}`, {
    method,
    body: formData,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (res.status === 401) {
    clearSession()
    throw new Error('Session expired. Please log in again.')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `Upload failed (${res.status}).`)
  }
  return res.status === 204 ? null : res.json()
}

// ── Suppliers (admin review + supplier self-service) ───────────────────────────
export const apiListSuppliers = () => apiFetch('/suppliers/')
export const apiGetSupplier = (id) => apiFetch(`/suppliers/${id}/`)
export const apiSupplierApprove = (id) =>
  apiFetch(`/suppliers/${id}/approve/`, { method: 'POST', body: '{}' })
export const apiSupplierReject = (id, note) =>
  apiFetch(`/suppliers/${id}/reject/`, { method: 'POST', body: JSON.stringify({ note }) })
export const apiSupplierRequestRevision = (id, { note, documents }) =>
  apiFetch(`/suppliers/${id}/request-revision/`, {
    method: 'POST',
    body: JSON.stringify({ note, documents }),
  })

// Logged-in supplier's own profile + document re-submission.
export const apiGetMySupplier = () => apiFetch('/suppliers/me/')
export const apiResubmitDocuments = (formData) => apiUpload('/suppliers/resubmit/', formData)
