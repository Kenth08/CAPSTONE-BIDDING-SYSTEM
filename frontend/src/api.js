import { protectedFilePath } from './utils/fileUrls'
import { resetSessionCache } from './utils/sessionCache'

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
  resetSessionCache()
}

export function clearSession() {
  localStorage.removeItem('access')
  localStorage.removeItem('refresh')
  localStorage.removeItem('role')
  localStorage.removeItem('user')
  resetSessionCache()
}

// Logs out instantly from the user's point of view (local session is cleared
// synchronously, so the UI never waits on the network) while also telling the
// backend to blacklist the refresh token, so a copied/stolen token can't be
// reused after logout. Best-effort: if the request fails the token simply
// expires naturally later — logout itself never fails.
export function apiLogout() {
  const refresh = localStorage.getItem('refresh')
  clearSession()
  if (!refresh) return
  fetch(`${API_URL}/auth/logout/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh }),
  }).catch(() => {})
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

// ── Two-factor sign-in (Admin and Head) ─────────────────────────────────────────
// After a correct password an MFA account gets { mfa_required, mfa_enrolled,
// mfa_token } instead of tokens; these finish the sign-in. No JWT yet, so raw fetch.
async function postMfa(path, body, fallback) {
  let res
  try {
    res = await fetch(`${API_URL}/auth/mfa/${path}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(readError(data, fallback))
  return data
}

/** Start authenticator enrolment → { secret, otpauth_uri, qr } */
export const apiMfaSetup = (mfaToken) =>
  postMfa('setup', { mfa_token: mfaToken }, 'Could not start two-factor setup.')

/** Finish sign-in with a 6-digit or backup code → { access, refresh, user, backup_codes? } */
export const apiMfaVerify = (mfaToken, code) =>
  postMfa('verify', { mfa_token: mfaToken, code }, 'That code is not valid.')

// Public (no token attached on purpose — see apiLogin above for why these use
// raw fetch instead of apiFetch: an expired/garbage access token sitting in
// localStorage would otherwise turn into a spurious 401 on a route that
// doesn't even require auth).
export async function apiRequestPasswordReset(email) {
  let res
  try {
    res = await fetch(`${API_URL}/auth/password/reset/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(readError(body, 'Could not process your request. Please try again.'))
  }
  return res.json()
}

export async function apiConfirmPasswordReset(uid, token, newPassword) {
  let res
  try {
    res = await fetch(`${API_URL}/auth/password/reset/confirm/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, token, new_password: newPassword }),
    })
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(readError(body, 'This password reset link is invalid or has expired.'))
  }
  return res.json()
}

// Which documents the chosen business categories require: the base documents
// plus each category's extra licenses. Public (registration has no login yet).
// Returns [{ key, label, required, has_expiry, help_text, source, category }].
export async function apiDocumentRequirements(categories) {
  const qs = new URLSearchParams({ categories: (categories || []).join(',') })
  let res
  try {
    res = await fetch(`${API_URL}/suppliers/document-requirements/?${qs}`)
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(readError(body, 'Could not load the required documents.'))
  }
  return res.json()
}

// Multi-step supplier registration with document uploads (multipart/form-data).
// `data` is a FormData instance — do NOT set Content-Type; the browser adds the
// correct multipart boundary automatically.
export async function apiRegisterSupplier(formData) {
  let res
  try {
    res = await fetch(`${API_URL}/auth/register/supplier/`, {
      method: 'POST',
      body: formData,
    })
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const msg = Object.entries(err)
      .map(([field, val]) => `${field}: ${Array.isArray(val) ? val.join(' ') : val}`)
      .join('\n')
    const error = new Error(msg || 'Registration failed.')
    // Raw { field: [messages] } so the form can show each one beside its field.
    error.fields = err && typeof err === 'object' ? err : {}
    error.status = res.status
    throw error
  }
  return res.json()
}

export async function apiVerifyEmail(uid, token) {
  let res
  try {
    res = await fetch(`${API_URL}/auth/verify-email/confirm/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, token }),
    })
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(readError(body, 'This verification link is invalid or has expired.'))
  }
  return res.json()
}

// Authenticated supplier resends their own verification email.
export const apiResendVerification = () =>
  apiFetch('/auth/verify-email/resend/', { method: 'POST', body: '{}' })

// ── Public (no auth) ────────────────────────────────────────────────────────
// The public "Public Results" page anyone can browse: procurements open for
// bidding + already-awarded contracts. No token is sent.
export async function apiPublicProcurement() {
  let res
  try {
    res = await fetch(`${API_URL}/public/procurement/`)
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  if (!res.ok) throw new Error('Unable to load public results right now. Please try again later.')
  return res.json() // { biddings: [...], winners: [...] }
}

// Live landing-page numbers: open biddings, awards, total ABC published and
// up to 6 open biddings + 6 recent awards (public fields only). No token.
export async function apiPublicSummary() {
  let res
  try {
    res = await fetch(`${API_URL}/public/summary/`)
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  if (!res.ok) throw new Error('Unable to load live procurement numbers right now.')
  return res.json()
}

// The public blockchain trail for one procurement code: the hash recorded at
// each lifecycle step plus the Sepolia transaction that witnesses it. No token —
// verification is open to anyone, with no account and no wallet.
// `deep` additionally re-reads every anchored document and re-hashes it, which
// catches a file swapped after the fact. Off by default — that's one storage
// read per anchor, too slow for every page load.
export async function apiPublicAnchors(code, { deep = false } = {}) {
  let res
  try {
    res = await fetch(
      `${API_URL}/public/procurement/${encodeURIComponent(code)}/anchors/${deep ? '?deep=1' : ''}`)
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  if (res.status === 404) throw new Error(`No procurement found with reference "${code}".`)
  if (!res.ok) throw new Error('Unable to load the blockchain trail right now. Please try again later.')
  return res.json() // { code, name, status, contract_address, anchors: [...] }
}

// One procurement's public result: winner and date only (no amounts, no bids).
// 404 for anything that was never opened to the public. No token.
export async function apiPublicRecord(code) {
  let res
  try {
    res = await fetch(`${API_URL}/public/procurement/${encodeURIComponent(code)}/`)
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  if (res.status === 404) throw new Error(`No public procurement found with reference "${code}".`)
  if (!res.ok) throw new Error('Unable to load this procurement right now. Please try again later.')
  return res.json() // { code, name, status, result: { state, winner?, awarded_at? }, ... }
}

// One record of a public procurement in full (record details page).
export async function apiPublicAnchorDetail(code, anchorId) {
  let res
  try {
    res = await fetch(
      `${API_URL}/public/procurement/${encodeURIComponent(code)}/anchors/${encodeURIComponent(anchorId)}/`)
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  if (res.status === 404) throw new Error('Not found.')
  if (!res.ok) throw new Error('Unable to load this record right now. Please try again later.')
  return res.json()
}

// One PUBLIC anchor's verification packet (project stages of a public
// procurement only). 404 → null: the record has no public packet.
export async function apiPublicPacket(code, anchorId) {
  let res
  try {
    res = await fetch(
      `${API_URL}/public/procurement/${encodeURIComponent(code)}/anchors/${encodeURIComponent(anchorId)}/packet/`)
  } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.')
  }
  if (res.status === 404) return null
  if (!res.ok) throw new Error('Unable to load the verification packet right now.')
  return res.json()
}

// ── Token refresh ─────────────────────────────────────────────────────────────
// Access tokens live 15 minutes; refresh tokens a day and are ROTATED: every
// refresh returns a new refresh token and the server blacklists the old one.
// An expired access token is renewed here, transparently, and the request is
// retried — users are never logged out mid-task, only after a day idle.
//
// Rotation makes concurrency matter. If two requests (or two TABS, which share
// localStorage) refreshed with the same refresh token, the second would be
// refused as blacklisted and log the user out. So:
//   * within a tab, concurrent callers share one in-flight refresh;
//   * across tabs, the refresh runs under a Web Lock, and a tab that waited
//     for the lock first checks whether another tab already rotated the token.

let refreshInflight = null
const REFRESH_LOCK = 'eprocurement-token-refresh'

async function refreshUnderLock(staleRefresh) {
  // Another tab may have rotated while we waited — just use its result.
  const current = localStorage.getItem('refresh')
  if (!current) return null
  if (current !== staleRefresh) return localStorage.getItem('access')

  const res = await fetch(`${API_URL}/auth/refresh/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh: current }),
  })
  if (!res.ok) return null
  const data = await res.json()
  if (!data?.access) return null
  localStorage.setItem('access', data.access)
  if (data.refresh) localStorage.setItem('refresh', data.refresh)
  return data.access
}

async function refreshAccessToken() {
  const refresh = localStorage.getItem('refresh')
  if (!refresh) return null
  if (refreshInflight) return refreshInflight

  refreshInflight = (async () => {
    try {
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
      return locks
        ? await locks.request(REFRESH_LOCK, () => refreshUnderLock(refresh))
        : await refreshUnderLock(refresh)
    } catch {
      return null   // offline / server down — treat as "could not refresh"
    } finally {
      refreshInflight = null
    }
  })()
  return refreshInflight
}

// ── Authenticated requests (for wiring dashboard data later) ───────────────────
export async function apiFetch(path, options = {}) {
  const send = (token) =>
    fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    }).catch(() => {
      // Otherwise the browser's bare "Failed to fetch" reaches the user.
      throw new Error('Cannot reach the server. Please check your connection and try again.')
    })

  let res = await send(getToken())
  if (res.status === 401) {
    const renewed = await refreshAccessToken()
    // Retried exactly once. A 401 that survives a fresh token is a real
    // authorization failure, not an expiry, so retrying again would only loop.
    if (renewed) res = await send(renewed)
    if (!renewed || res.status === 401) {
      clearSession()
      throw new Error('Session expired. Please log in again.')
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(readError(err, `Request failed (${res.status}).`))
  }
  return res.status === 204 ? null : res.json()
}

// ── Protected files ───────────────────────────────────────────────────────────
// File URLs in API responses (e.g. https://api…/api/files/bid/7/quotation_document/)
// are addresses, not credentials: opening one without a login gives 404.
// See frontend/src/files.js for how a click becomes a download.

export { protectedFilePath }

/** Ask for a one-time, 2-minute download link for one file (JWT-authenticated). */
export async function apiFileDownloadLink(url) {
  const path = protectedFilePath(url)
  if (!path) throw new Error('This document link is not valid.')
  const data = await apiFetch(`${path}link/`, { method: 'POST', body: '{}' })
  return data.url
}

/** Fetch a protected file's bytes with the JWT (inline images). Resolves to a Blob. */
export async function apiFetchFileBlob(url) {
  const path = protectedFilePath(url)
  if (!path) throw new Error('This image link is not valid.')
  const send = (token) =>
    fetch(`${API_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  let res = await send(getToken())
  if (res.status === 401) {
    const renewed = await refreshAccessToken()
    if (renewed) res = await send(renewed)
  }
  if (!res.ok) throw new Error(`Image unavailable (${res.status}).`)
  return res.blob()
}

// Authenticated multipart upload (no Content-Type header — the browser sets the
// multipart boundary). Used for supplier document re-submission.
async function apiUpload(path, formData, method = 'POST') {
  const send = (token) =>
    fetch(`${API_URL}${path}`, {
      method,
      body: formData,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch(() => {
      throw new Error('Cannot reach the server. Please check your connection and try again.')
    })

  let res = await send(getToken())
  if (res.status === 401) {
    const renewed = await refreshAccessToken()
    if (renewed) res = await send(renewed)
    if (!renewed || res.status === 401) {
      clearSession()
      throw new Error('Session expired. Please log in again.')
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(readError(err, `Upload failed (${res.status}).`))
  }
  return res.status === 204 ? null : res.json()
}

// Admin fills out the same registration form on behalf of a supplier who
// walked in with physical documents (scanned/photographed beforehand).
export const apiAdminRegisterSupplier = (formData) => apiUpload('/auth/admin/register-supplier/', formData)

// Admin: lift a sign-in lockout early (5 failed attempts lock an account for 15 minutes).
export const apiUnlockAccount = (userId) =>
  apiFetch(`/auth/users/${userId}/unlock/`, { method: 'POST', body: '{}' })

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

// Category change requests: a verified supplier's new business_types are only
// a request until an Admin approves them (enforced server-side).
export const apiSupplierApproveCategories = (id) =>
  apiFetch(`/suppliers/${id}/approve-categories/`, { method: 'POST', body: '{}' })
export const apiSupplierRejectCategories = (id, note) =>
  apiFetch(`/suppliers/${id}/reject-categories/`, { method: 'POST', body: JSON.stringify({ note }) })

// Logged-in supplier's own profile + document re-submission.
export const apiGetMySupplier = () => apiFetch('/suppliers/me/')
export const apiUpdateMySupplier = (data) =>
  apiFetch('/suppliers/me/', { method: 'PATCH', body: JSON.stringify(data) })
export const apiResubmitDocuments = (formData) => apiUpload('/suppliers/resubmit/', formData)
// Supplier uploads extra licenses for their categories or a pending category
// request: multipart catdoc_<key> (+ catdoc_<key>_expiry).
export const apiUploadCategoryDocuments = (formData) =>
  apiUpload('/suppliers/me/category-documents/', formData)

// ── Account settings (any role) ─────────────────────────────────────────────
export const apiChangePassword = (currentPassword, newPassword) =>
  apiFetch('/auth/password/change/', {
    method: 'POST',
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  })

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
// Head flags one or more procurement documents — does NOT reject the project,
// it bounces back to Admin's Planning queue for a fix.
export const apiProjectRequestRevision = (id, documents) =>
  apiFetch(`/projects/${id}/request-revision/`, {
    method: 'POST',
    body: JSON.stringify({ documents }),
  })
// Admin re-uploads just the flagged document(s) (multipart) — returns the
// project to pending_head automatically.
export const apiResubmitProjectDocuments = (id, formData) =>
  apiUpload(`/projects/${id}/resubmit-documents/`, formData)

// ── Bidding (supplier) ─────────────────────────────────────────────────────────
export const apiListMyBids = () => apiFetch('/bids/')
// Full bid submission with documents + declarations is multipart/form-data.
// `formData` is a FormData instance built by the bid modal.
export const apiSubmitBid = (projectId, formData) =>
  apiUpload(`/projects/${projectId}/bid/`, formData)
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
// Flag one or more documents on a bid as needing revision — does NOT
// disqualify the bid, the supplier just re-uploads the flagged file(s).
export const apiBidRequestRevision = (bidId, { note, documents }) =>
  apiFetch(`/bids/${bidId}/request-revision/`, {
    method: 'POST',
    body: JSON.stringify({ note, documents }),
  })
// Supplier re-uploads just the flagged document(s) on their own bid (multipart).
export const apiResubmitBidDocuments = (bidId, formData) =>
  apiUpload(`/bids/${bidId}/resubmit-documents/`, formData)
// Product images on the supplier's own bid — only while bidding is open.
// formData: `product_images` (files) + `product_image_captions` (same order).
export const apiUploadBidImages = (bidId, formData) =>
  apiUpload(`/bids/${bidId}/images/`, formData)
export const apiDeleteBidImage = (bidId, imageId) =>
  apiFetch(`/bids/${bidId}/images/${imageId}/`, { method: 'DELETE' })

// ── Awards ───────────────────────────────────────────────────────────────────────
// Admin/Head see every award; a supplier sees ONLY their own (scoped server-side
// in AwardViewSet.get_queryset), which is how the winner reaches the Notice of
// Award addressed to them.
export const apiListAwards = () => apiFetch('/awards/')
// Generate one official post-award document from the award record itself. The
// server builds the PDF ONCE and stores it — every later download serves those
// exact bytes, which is what keeps the anchored hash reproducible.
export const apiGenerateAwardDocument = (awardId, key) =>
  apiFetch(`/awards/${awardId}/documents/generate/`, {
    method: 'POST',
    body: JSON.stringify({ key }),
  })

// Upload a SIGNED post-award document instead (e.g. the scan that comes back
// after signing). Each is hashed with its issue date and anchored on-chain, so
// the response carries an `anchor` for the browser to sign — see
// blockchain/anchor.js.
export const apiUploadAwardDocument = (awardId, key, file) => {
  const fd = new FormData()
  fd.append('key', key)
  fd.append('file', file)
  return apiUpload(`/awards/${awardId}/documents/`, fd)
}

// ── Documents (admin) ────────────────────────────────────────────────────────────
export const apiListDocuments = () => apiFetch('/documents/')

// ── Blockchain anchoring ───────────────────────────────────────────────────────
// Every status-transition endpoint above now returns an extra `anchor` object:
//   { id, entity_type, entity_ref, stage, data_hash, attach_url, ... }
// `data_hash` is what gets signed into the ProcurementLedger contract, and
// `attach_url` is where the confirmed transaction is posted back — so the
// frontend never has to know which entity kind it's holding (see
// blockchain/anchor.js, which posts to attach_url via apiFetch).
//
// A record with no transaction yet simply reads as "not yet anchored" and can be
// retried; the procurement data itself is already saved either way.
export const apiListProjectAnchors = (projectId) => apiFetch(`/projects/${projectId}/anchors/`)
// Admin/Head: have the SERVER read this procurement's reported transactions
// back from Sepolia and check each receipt really records its anchor. Read-only
// on the chain — it never sends a transaction.
// The whole procurement, filing → award, with its blockchain evidence — scoped
// to the caller by the server (procurement/record.py). `deep` (Admin/Head)
// also re-reads and re-hashes every anchored document.
export const apiProjectRecord = (projectId, { deep = false } = {}) =>
  apiFetch(`/projects/${projectId}/record/${deep ? '?deep=1' : ''}`)
export const apiVerifyProjectChain = (projectId) =>
  apiFetch(`/projects/${projectId}/verify-chain/`, { method: 'POST' })
// One anchor's verification packet, scoped to the caller's role (server-side).
export const apiProjectPacket = (projectId, anchorId) =>
  apiFetch(`/projects/${projectId}/anchors/${anchorId}/packet/`)
// One record of a procurement in full, scoped to the caller's role (server-side).
export const apiProjectAnchorDetail = (projectId, anchorId) =>
  apiFetch(`/projects/${projectId}/anchors/${anchorId}/`)

// Explicit per-entity helpers, for callers that would rather not use attach_url.
const anchorBody = ({ anchorId, stage, txHash, blockNumber, actorAddress }) =>
  JSON.stringify({
    anchor_id: anchorId, stage, tx_hash: txHash,
    block_number: blockNumber, actor_address: actorAddress,
  })
export const apiAnchorProject = (projectId, payload) =>
  apiFetch(`/projects/${projectId}/anchor/`, { method: 'POST', body: anchorBody(payload) })
export const apiAnchorBid = (bidId, payload) =>
  apiFetch(`/bids/${bidId}/anchor/`, { method: 'POST', body: anchorBody(payload) })
export const apiAnchorAward = (awardId, payload) =>
  apiFetch(`/awards/${awardId}/anchor/`, { method: 'POST', body: anchorBody(payload) })

// ── Dashboard summaries (read-only) ─────────────────────────────────────────
export const apiAdminSummary = () => apiFetch('/dashboard/admin-summary/')
export const apiHeadSummary = () => apiFetch('/dashboard/head-summary/')

// ── Notifications ──────────────────────────────────────────────────────────────
export const apiListNotifications = () => apiFetch('/notifications/')
export const apiMarkNotificationsRead = () =>
  apiFetch('/notifications/mark-read/', { method: 'POST', body: '{}' })
