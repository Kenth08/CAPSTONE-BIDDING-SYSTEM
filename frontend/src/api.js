// Central API layer for talking to the Django backend.
// In production set VITE_API_URL (e.g. https://api.yourdomain.com/api); locally
// it falls back to the dev server so nothing changes during development.
const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000/api'

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

// Pulls a readable message out of a DRF error body, whatever its shape:
// { detail: "x" } | { detail: ["x"] } | { field: ["x"] } | "x".
function readError(body, fallback) {
  if (!body) return fallback
  if (typeof body === 'string') return body
  if (body.detail) return Array.isArray(body.detail) ? body.detail.join(' ') : body.detail
  const first = Object.values(body)[0]
  if (first) return Array.isArray(first) ? first.join(' ') : String(first)
  return fallback
}

// ── Auth ──────────────────────────────────────────────────────────────────────
// `identifier` is the username OR email — the backend accepts either and returns
// the account's real role, so there is a single login for all roles.
export async function apiLogin(identifier, password) {
  let res
  try {
    res = await fetch(`${API_URL}/auth/login/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: identifier, password }),
    })
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(readError(body, 'Unable to sign in. Please check your credentials.'))
  }
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
    const err = await res.json().catch(() => null)
    throw new Error(readError(err, `Upload failed (${res.status}).`))
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

// ── Projects (admin create + head approval flow) ───────────────────────────────
export const apiListProjects = () => apiFetch('/projects/')
export const apiGetProject = (id) => apiFetch(`/projects/${id}/`)
// Create is multipart (procurement documents are uploaded with the form).
export const apiCreateProject = (formData) => apiUpload('/projects/', formData)
export const apiApproveProject = (id) =>
  apiFetch(`/projects/${id}/approve/`, { method: 'POST', body: '{}' })
export const apiRejectProject = (id, reason) =>
  apiFetch(`/projects/${id}/reject/`, { method: 'POST', body: JSON.stringify({ reason }) })
export const apiPublishProject = (id) =>
  apiFetch(`/projects/${id}/publish/`, { method: 'POST', body: '{}' })

// ── Bidding (supplier) ─────────────────────────────────────────────────────────
export const apiListMyBids = () => apiFetch('/bids/')
export const apiSubmitBid = (projectId, amount, notes) =>
  apiFetch(`/projects/${projectId}/bid/`, {
    method: 'POST', body: JSON.stringify({ amount, notes }),
  })
export const apiWithdrawBid = (bidId) =>
  apiFetch(`/bids/${bidId}/`, { method: 'DELETE' })

// ── Bid evaluation (admin) ─────────────────────────────────────────────────────
export const apiListProjectBids = (projectId) => apiFetch(`/bids/?project=${projectId}`)
export const apiQualifyBid = (bidId) =>
  apiFetch(`/bids/${bidId}/qualify/`, { method: 'POST', body: '{}' })
export const apiDisqualifyBid = (bidId) =>
  apiFetch(`/bids/${bidId}/disqualify/`, { method: 'POST', body: '{}' })
export const apiSelectWinner = (bidId) =>
  apiFetch(`/bids/${bidId}/select-winner/`, { method: 'POST', body: '{}' })

// ── Notifications ──────────────────────────────────────────────────────────────
export const apiListNotifications = () => apiFetch('/notifications/')
export const apiMarkNotificationsRead = () =>
  apiFetch('/notifications/mark-read/', { method: 'POST', body: '{}' })
