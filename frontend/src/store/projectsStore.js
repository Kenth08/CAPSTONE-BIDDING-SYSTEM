// Shared projects store — the single source of truth for procurement projects
// across BOTH the Admin and Head dashboards, backed by the Django REST API.
//
// Admin creates a project in Planning (status `pending_head`); the Head sees it
// under "Pending Approval" and approves/rejects it; an approved project then
// flows into the Admin "Projects" page. Because the two dashboards are separate
// routes, the data lives here (outside React) in a small external store that
// fetches from the backend and caches the result, so revisiting a page shows
// data instantly and refreshes silently (stale-while-revalidate).
import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import {
  apiListProjects, apiCreateProject, apiApproveProject, apiRejectProject, apiPublishProject,
} from '../api'

// ── Internal state ────────────────────────────────────────────────────────────
let projects = []
let loaded = false
let loading = false
let error = ''
let inflight = null
let lastLoaded = 0

// How long fetched data is considered "fresh". Within this window, a table that
// mounts reuses the cache instead of re-hitting the server — so navigating
// between the project tables is instant and doesn't spam the API.
const STALE_MS = 30_000

const listeners = new Set()
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l) }

// useSyncExternalStore needs a stable snapshot reference between renders, so we
// only rebuild it when something actually changes.
let snapshot = { projects, loading, error, loaded }
const rebuild = () => { snapshot = { projects, loading, error, loaded } }
const getSnapshot = () => snapshot
const emit = () => { rebuild(); listeners.forEach(l => l()) }

// ── Mapping between the API shape and the shape the UI components expect ────────
const fmtDate = (v) =>
  v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
const fmtPeso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH')

function fromApi(p) {
  return {
    id: p.id,                       // numeric PK — used for actions & React keys
    code: p.code,                   // human id, e.g. "P-2026-001" — shown in the UI
    name: p.name,
    type: p.type,
    category: p.category || '',
    budget: fmtPeso(p.budget),
    deadline: fmtDate(p.deadline),
    deliveryLocation: p.delivery_location || '',
    expectedDelivery: fmtDate(p.expected_delivery_date),
    eligibleTypes: p.eligible_types,
    bids: p.bid_count,
    status: p.status,
    description: p.description,
    documents: p.documents || [],   // [{ key, label, required, url }]
    submittedAt: fmtDate(p.created_at),
    reviewedAt: p.reviewed_at ? fmtDate(p.reviewed_at) : null,
    rejectReason: p.reject_reason || '',
  }
}

const parseBudget = (s) => Number(String(s).replace(/[^\d.]/g, '')) || 0

// ── Fetching ───────────────────────────────────────────────────────────────────
function doFetch({ background }) {
  if (inflight) return inflight        // de-dupe concurrent loads
  loading = true
  if (!background) emit()              // first load: show the loading state
  inflight = (async () => {
    try {
      const data = await apiListProjects()
      projects = data.map(fromApi)
      loaded = true
      lastLoaded = Date.now()
      error = ''
    } catch (e) {
      // A failed background refresh keeps the data already on screen.
      if (!loaded) error = e.message || 'Failed to load projects.'
    } finally {
      loading = false
      inflight = null
      emit()
    }
  })()
  return inflight
}

// Load only when needed: never loaded yet → fetch (with loader); cache gone
// stale → refresh silently in the background; cache still fresh → do nothing.
function ensureLoaded() {
  const fresh = loaded && Date.now() - lastLoaded < STALE_MS
  if (fresh) return
  return doFetch({ background: loaded })
}

// React hook used by EACH table/page that needs projects. The page owns its own
// data loading; the shared cache means co-existing tables don't refetch.
export function useProjects() {
  const snap = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => { ensureLoaded() }, [])
  return snap
}

// ── Actions ────────────────────────────────────────────────────────────────────
// Each mutation endpoint returns the updated project, so we merge that single
// response into the store instead of re-fetching the whole list (1 request, not 2).
function upsert(apiProject) {
  const mapped = fromApi(apiProject)
  const i = projects.findIndex(p => p.id === mapped.id)
  projects = i >= 0
    ? projects.map(p => (p.id === mapped.id ? mapped : p))
    : [mapped, ...projects]
  emit()
}

// Procurement creation is multipart — text fields + the required document files.
export async function createProject(form, files = {}) {
  const fd = new FormData()
  fd.append('name', form.name)
  fd.append('description', form.description || '')
  fd.append('type', form.type)
  fd.append('category', form.category)
  fd.append('budget', parseBudget(form.budget))
  fd.append('delivery_location', form.delivery_location || '')
  if (form.deadline) fd.append('deadline', form.deadline)
  if (form.expected_delivery_date) fd.append('expected_delivery_date', form.expected_delivery_date)
  fd.append('eligible_types', 'Open to All')
  Object.entries(files).forEach(([key, file]) => { if (file) fd.append(key, file) })
  upsert(await apiCreateProject(fd))
}

export async function approveProject(id) {
  upsert(await apiApproveProject(id))
}

export async function rejectProject(id, reason = '') {
  upsert(await apiRejectProject(id, reason))
}

// Admin publishes an approved procurement → status `published` (open for bidding).
export async function publishProject(id) {
  upsert(await apiPublishProject(id))
}

// Force a silent refresh — used after an out-of-store change (e.g. selecting a
// bid winner flips a project to "awarded" on the backend).
export function refreshProjects() {
  return doFetch({ background: true })
}

// ── Derived helpers (status semantics) ──────────────────────────────────────────
export const isReviewed = (p) =>
  p.status === 'rejected' ||
  ['approved', 'published', 'active', 'awarded', 'closed'].includes(p.status)
export const decisionOf = (p) => (p.status === 'rejected' ? 'rejected' : 'approved')
