import { useState, useEffect, useRef } from 'react'
import { Routes, Route, Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, Calendar, Users, Pencil, Award, BarChart2,
  Search, ChevronRight, LogOut, Shield,
  Plus, FileText, Activity, UserCheck, Info, Eye, X, ExternalLink,
  CheckCircle2, AlertTriangle, XCircle, Check, Menu, ImageIcon, Clock, ArrowLeft,
  Upload, ShieldCheck, Link2, Copy, Loader2, Hash,
} from 'lucide-react'
import {
  apiLogout, apiListSuppliers, apiGetSupplier,
  apiSupplierApprove, apiSupplierReject, apiSupplierRequestRevision, apiAdminRegisterSupplier,
  apiSupplierApproveCategories, apiSupplierRejectCategories,
  apiListProjectBids, apiQualifyBid, apiDisqualifyBid, apiSelectWinner, apiGetProject,
  apiListAwards, apiListDocuments, apiBidRequestRevision,
  apiUploadAwardDocument, apiGenerateAwardDocument,
} from '../api'
import {
  useProjects, createProject, publishProject, refreshProjects, isExpired, deadlineLabel, deliveryLabel,
  resubmitProjectDocuments,
} from '../store/projectsStore'
import { CATEGORIES } from '../constants/categories'
import { Skeleton, TableSkeleton, ListSkeleton } from '../components/Skeleton'
import AppSidebar from '../components/shell/AppSidebar'
import AppHeader, { storedUser } from '../components/shell/AppHeader'
import StatusBadge from '../components/ui/StatusBadge'
import EmptyState, { TableEmpty } from '../components/ui/EmptyState'
import PageHeader from '../components/ui/PageHeader'
import Stepper from '../components/ui/Stepper'
import { expiryMeta } from '../utils/format'
import AnchorActivity from '../components/AnchorActivity'
import BlockchainTrail, { BlockchainBadge } from '../components/BlockchainTrail'
import { runAnchor } from '../blockchain/anchorStore'
import { exportReportCSV, exportReportPDF } from '../utils/exportReport'
import '../style/AdminDashboard.css'

const NAV_SECTIONS = [
  { label: 'Overview', items: [
    { icon: LayoutDashboard, label: 'Dashboard', to: '/admin' },
  ] },
  { label: 'Procurement', items: [
    { icon: Calendar,   label: 'Planning', to: '/admin/planning' },
    { icon: FolderOpen, label: 'Projects', to: '/admin/projects' },
    { icon: Pencil,     label: 'Bids',     to: '/admin/bids' },
    { icon: Award,      label: 'Awards',   to: '/admin/awards' },
  ] },
  { label: 'Management', items: [
    { icon: Users,     label: 'Suppliers', to: '/admin/suppliers' },
    { icon: BarChart2, label: 'Reports',   to: '/admin/reports' },
  ] },
]

const STATUS_LABEL = {
  draft: 'Draft', pending_head: 'Pending', needs_revision: 'Needs Revision', approved: 'Approved', rejected: 'Rejected',
  published: 'Open for Bidding', awarded: 'Awarded', closed: 'Closed', active: 'Active',
}
const STATUS_CLS = {
  draft: 'badge-gray', pending_head: 'badge-yellow', needs_revision: 'badge-orange', approved: 'badge-green', rejected: 'badge-red',
  published: 'badge-blue', awarded: 'badge-awarded', active: 'badge-blue',
}

// ── Reference Code ────────────────────────────────────────────────────────────
// Every procurement carries a human-readable reference (e.g. "P-2026-001") that
// doubles as its public lookup key: it is what anyone types into the Public
// Verifier to replay the whole trail from the Sepolia ledger. Admins hand this
// code out constantly, so it gets a deliberately loud, monospace, click-to-copy
// treatment everywhere instead of being buried in muted subtitle text.
function RefCode({ code, size = 'sm' }) {
  const [copied, setCopied] = useState(false)
  if (!code) return <span className="ad-muted ad-small">—</span>

  const copy = async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* Clipboard blocked (insecure origin / denied) — the code is still on
         screen to be read or selected by hand, so there is nothing to report. */
    }
  }

  return (
    <button
      type="button"
      className={`ad-ref ad-ref-${size}${copied ? ' ad-ref-copied' : ''}`}
      onClick={copy}
      title={copied ? 'Copied!' : `${code} — click to copy. Use this reference in the Public Verifier.`}
    >
      <span className="ad-ref-text">{code}</span>
      {copied ? <Check size={11} /> : <Copy size={11} className="ad-ref-copy" />}
    </button>
  )
}

// Deadline column: the real date once published; before that, a compact
// "N-day period" chip whose tooltip explains the date is set on publish.
function DeadlineCell({ project }) {
  if (project.deadline) return <span className="ad-nowrap">{project.deadline}</span>
  if (project.biddingPeriodDays) {
    return (
      <span
        className="ui-badge ui-badge--neutral"
        data-tip="Deadline is set automatically when the project is published"
        title="Deadline is set automatically when the project is published"
        tabIndex={0}
      >
        <Clock size={11} aria-hidden="true" /> {project.biddingPeriodDays}-day period
      </span>
    )
  }
  return <span className="ad-muted">—</span>
}

// ── Dashboard Home ────────────────────────────────────────────────────────────

function DashboardHome() {
  const { projects, loading } = useProjects()
  const [tab, setTab] = useState('All')
  const [expiringDocs, setExpiringDocs] = useState([])
  const [docsLoading, setDocsLoading] = useState(true)
  const TABS = ['All', 'Draft', 'Active', 'Closed', 'Awarded']

  useEffect(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() + 30)
    apiListDocuments()
      .then(docs => setExpiringDocs(docs.filter(d => new Date(d.expiry_date) <= cutoff)))
      .catch(() => setExpiringDocs([]))
      .finally(() => setDocsLoading(false))
  }, [])

  const totalProjects    = projects.length
  const totalBids        = projects.reduce((s, p) => s + p.bids, 0)
  const activeBidding    = projects.filter(p => p.status === 'published' || p.status === 'active').length
  const awardedContracts = projects.filter(p => p.status === 'awarded').length

  const awaitingPublish = projects.filter(p => p.status === 'approved').length
  const awaitingHead    = projects.filter(p => p.status === 'pending_head' || p.status === 'needs_revision').length

  const STATS = [
    { label: 'Total Projects',    value: totalProjects,    sub: 'All created procurement projects', icon: FolderOpen  },
    { label: 'Total Bids',        value: totalBids,        sub: 'Submitted bid entries',            icon: FileText    },
    { label: 'Active Bidding',    value: activeBidding,    sub: 'Projects currently open',          icon: Activity    },
    { label: 'Awarded Contracts', value: awardedContracts, sub: 'Finalized awards',                 icon: UserCheck   },
  ]

  const filtered = projects.filter(p => {
    if (tab === 'All')     return true
    if (tab === 'Awarded') return p.status === 'awarded'
    if (tab === 'Active')  return p.status === 'published' || p.status === 'active'
    if (tab === 'Draft')   return p.status === 'draft'
    if (tab === 'Closed')  return p.status === 'closed'
    return true
  })
  // The card promises the last 10; the full list lives on Projects / Planning.
  const recent = filtered.slice(0, 10)

  const NEXT_ACTIONS = [
    {
      to: '/admin/projects', icon: FolderOpen, title: 'Create or Manage Projects',
      desc: 'Review draft, active, and awarded projects',
      count: awaitingPublish, countLabel: 'ready to publish',
    },
    {
      to: '/admin/planning', icon: Calendar, title: 'Track Planning',
      desc: 'Projects waiting on the Head or needing revision',
      count: awaitingHead, countLabel: 'in review',
    },
    {
      to: '/admin/suppliers', icon: Users, title: 'Review Suppliers',
      desc: 'Check supplier profiles and approvals',
    },
    {
      to: '/admin/bids', icon: Pencil, title: 'Evaluate Bids',
      desc: 'Open bid evaluation for submitted projects',
      count: activeBidding, countLabel: 'open for bidding',
    },
  ]

  return (
    <div className="ad-content ad-dash-page">
      <div className="ad-stats">
        {STATS.map(({ label, value, sub, icon: Icon }) => (
          <div className="ad-stat-card" key={label}>
            <div className="ad-stat-top">
              <span className="ad-stat-label">{label}</span>
              <div className="ad-stat-icon-wrap" aria-hidden="true"><Icon size={18} /></div>
            </div>
            <div className="ad-stat-value">{loading && projects.length === 0 ? <Skeleton width={48} height={26} /> : value}</div>
            <div className="ad-stat-sub">{sub}</div>
          </div>
        ))}
      </div>

      <div className="ad-dash-grid">
        <div className="ad-dash-main">
          <div className="ad-card">
            <div className="ad-card-header">
              <div>
                <h2>Recent Projects</h2>
                <p>Last 10 projects by status</p>
              </div>
              <Link to="/admin/projects" className="ad-view-all">View all <ChevronRight size={14} /></Link>
            </div>
            <div className="ad-filter-pills" role="tablist" aria-label="Filter recent projects">
              {TABS.map(t => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  className={`ad-pill${tab === t ? ' ad-pill-active' : ''}`}
                  onClick={() => setTab(t)}
                >{t}</button>
              ))}
            </div>
            <div className="ad-project-list">
              {loading && filtered.length === 0
                ? <div style={{ padding: '12px 20px' }}><ListSkeleton rows={4} height={44} /></div>
                : recent.length === 0
                ? <EmptyState compact icon={FolderOpen} title="No projects here yet"
                    description={tab === 'All' ? 'Projects you create in Planning will show up here.' : `No ${tab.toLowerCase()} projects right now.`} />
                : recent.map(p => (
                  <div className="ad-project-row" key={p.id}>
                    <div className="ad-project-row-main">
                      <div className="ad-bold ad-truncate">{p.name}</div>
                      <div className="ad-project-row-meta">
                        <RefCode code={p.code} />
                        <span className="ad-muted ad-small">{p.budget}</span>
                        <span className="ad-dot-sep" aria-hidden="true" />
                        <span className="ad-muted ad-small">{deadlineLabel(p)}</span>
                      </div>
                    </div>
                    <StatusBadge domain="project" status={p.status} />
                  </div>
                ))
              }
            </div>
          </div>

          <div className="ad-card ad-card-mt">
            <div className="ad-card-header">
              <div>
                <h2>Expiring Documents</h2>
                <p>Supplier documents expiring within 30 days</p>
              </div>
              {!docsLoading && expiringDocs.length > 0 && (
                <StatusBadge tone="warning" label={`${expiringDocs.length} to follow up`} />
              )}
            </div>
            <div className="ad-expiring-list">
              {docsLoading
                ? <div style={{ padding: '12px 20px' }}><ListSkeleton rows={2} height={40} /></div>
                : expiringDocs.length === 0
                ? <EmptyState compact icon={CheckCircle2} title="Nothing expiring soon"
                    description="No supplier documents expire in the next 30 days." />
                : expiringDocs.map(doc => {
                  const exp = expiryMeta(doc.expiry_date)
                  return (
                    <div className="ad-expiring-row" key={doc.id}>
                      <div className="ad-expiring-icon" aria-hidden="true"><FileText size={15} /></div>
                      <div className="ad-expiring-main">
                        <div className="ad-bold ad-truncate">{doc.company}</div>
                        <div className="ad-muted ad-small">{doc.doc_type} · {fmtDate(doc.expiry_date)}</div>
                      </div>
                      <StatusBadge tone={exp.tone} label={exp.label} icon={exp.tone === 'danger' ? AlertTriangle : Clock} />
                    </div>
                  )
                })
              }
            </div>
          </div>
        </div>

        <div className="ad-dash-side">
          <div className="ad-card">
            <div className="ad-card-header">
              <div>
                <h2>Next Actions</h2>
                <p>Where your attention is needed</p>
              </div>
            </div>
            <div className="ad-next-actions">
              {NEXT_ACTIONS.map(({ to, icon: Icon, title, desc, count, countLabel }) => (
                <Link to={to} className="ad-next-action" key={to}>
                  <span className="ad-next-icon" aria-hidden="true"><Icon size={17} /></span>
                  <div className="ad-next-body">
                    <div className="ad-bold">{title}</div>
                    <div className="ad-muted ad-small">{desc}</div>
                    {count > 0 && <span className="ad-next-count">{count} {countLabel}</span>}
                  </div>
                  <ChevronRight size={16} className="ad-action-arrow" aria-hidden="true" />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Projects Page ─────────────────────────────────────────────────────────────

function ProjectsPage() {
  const { projects, loading } = useProjects()
  const navigate = useNavigate()
  const [filterTab, setFilterTab] = useState('All')
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState(null)
  const FILTER_TABS = ['All', 'Active', 'Closed', 'Awarded']

  // Only projects the Head has already approved appear here. Projects still being
  // planned, awaiting approval, or rejected stay on the Planning page.
  const approved = projects.filter(p => !['draft', 'pending_head', 'needs_revision', 'rejected'].includes(p.status))

  // Once a project's bid deadline has passed, the bidding window is over — pull
  // it out of the active table and into History instead of leaving it to sit
  // here looking "Open for Bidding" forever.
  const active = approved.filter(p => !isExpired(p))
  const historyCount = approved.length - active.length

  const filtered = active.filter(p => {
    const q = search.toLowerCase()
    const matchSearch = !q || p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q)
    const matchTab =
      filterTab === 'All'     ? true :
      filterTab === 'Awarded' ? p.status === 'awarded' :
      filterTab === 'Active'  ? (p.status === 'approved' || p.status === 'published' || p.status === 'active') :
      filterTab === 'Closed'  ? p.status === 'closed' : true
    return matchSearch && matchTab
  })

  // No re-sort here: `projects` already arrives newest-first (API orders by
  // -created_at, and the store unshifts new/updated rows), so a freshly
  // created or published project shows up at the top right away.

  return (
    <div className="ad-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div className="ad-card">
        <div className="ad-card-header ad-toolbar-row">
          <div className="ad-filter-pills ad-filter-pills-inline" role="tablist" aria-label="Filter projects">
            {FILTER_TABS.map(t => (
              <button key={t} role="tab" aria-selected={filterTab === t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
            ))}
          </div>
          <div className="ad-toolbar">
            <label className="ad-search-inline">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search projects</span>
              <input placeholder="Search by title or ref code" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
            <button className="ad-btn-history" onClick={() => navigate('/admin/projects/history')}>
              <Clock size={13} /> History{historyCount > 0 ? ` (${historyCount})` : ''}
            </button>
          </div>
        </div>

        <div className="ad-table-scroll ad-x-scroll">
        <table className="ad-table">
          <thead>
            <tr>
              <th>Ref Code</th><th>Title</th><th className="ad-num">Budget</th><th>Deadline</th><th>Type</th>
              <th>Eligible Types</th><th>Status</th><th className="ad-actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && filtered.length === 0
              ? <TableSkeleton rows={4} cols={8} />
              : filtered.length === 0
              ? <TableEmpty colSpan={8} icon={FolderOpen}
                  title={search || filterTab !== 'All' ? 'No projects match your filters' : 'No approved projects yet'}
                  description={search || filterTab !== 'All'
                    ? 'Try a different search or filter.'
                    : 'Projects appear here once the Head approves them in Planning.'} />
              : filtered.map(p => (
                <tr key={p.id}>
                  <td><RefCode code={p.code} /></td>
                  <td className="ad-bold ad-cell-title">{p.name}</td>
                  <td className="ad-num">{p.budget}</td>
                  <td><DeadlineCell project={p} /></td>
                  <td className="ad-nowrap">{p.type}</td>
                  <td><span className="ui-badge ui-badge--neutral">{p.eligibleTypes}</span></td>
                  <td><StatusBadge domain="project" status={p.status} /></td>
                  <td className="ad-actions-col">
                    <div className="ad-actions">
                      {p.status === 'approved' && (
                        <PublishButton
                          project={p}
                          onPublished={(proj) => setToast({
                            type: 'success',
                            message: `"${proj.name}" published — suppliers can now submit bids.`,
                          })}
                        />
                      )}
                      <button className="ad-btn-view-sm" onClick={() => navigate(`/admin/bids/${p.id}`)}>
                        <Eye size={13} /> View Bids
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}

// ── Project History Page ─────────────────────────────────────────────────────
// Projects whose bid deadline has passed get pulled out of the active
// Projects table (see ProjectsPage filtering above) so closed biddings don't
// clutter the working view, but they stay one click away with full status
// and bid access. Purely a client-side split of the same `projects` cache —
// no extra request, so opening History never hits the API or slows anything.
function ProjectHistoryPage() {
  const { projects, loading } = useProjects()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  const approved = projects.filter(p => !['draft', 'pending_head', 'needs_revision', 'rejected'].includes(p.status))
  const history = approved.filter(isExpired)

  const filtered = history.filter(p => {
    const q = search.toLowerCase()
    return !q || p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q)
  })

  // Most recently closed first.
  const sorted = [...filtered].sort((a, b) => (a.deadlineRaw < b.deadlineRaw ? 1 : -1))

  // A row only lands here because its deadline has passed, so the badge should
  // say so — "Open for Bidding"/"Approved" would be stale and confusing once
  // the bidding window is actually over. Awarded is the one outcome worth
  // keeping distinct.
  const closedLabel = (p) => (p.status === 'awarded' ? 'Awarded' : 'Closed')
  const closedCls = (p) => (p.status === 'awarded' ? (STATUS_CLS.awarded || 'badge-awarded') : 'badge-gray')

  return (
    <div className="ad-content">
      <div className="ad-card">
        <div className="ad-card-header">
          <button className="ad-btn-view-sm" onClick={() => navigate('/admin/projects')}>
            <ArrowLeft size={12} /> Back to Projects
          </button>
          <div className="ad-toolbar">
            <label className="ad-search-inline">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search closed biddings</span>
              <input placeholder="Search closed biddings by title or ref code" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
          </div>
        </div>

        <div className="ad-table-scroll ad-x-scroll">
        <table className="ad-table">
          <thead>
            <tr>
              <th>Ref Code</th><th>Title</th><th className="ad-num">Budget</th><th>Closed On</th><th>Type</th>
              <th>Eligible Types</th><th>Status</th><th className="ad-actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && sorted.length === 0
              ? <TableSkeleton rows={4} cols={8} />
              : sorted.length === 0
              ? <TableEmpty colSpan={8} icon={Clock}
                  title={search ? 'No closed biddings match your search' : 'No closed biddings yet'}
                  description="Projects move here automatically once their bid deadline passes." />
              : sorted.map(p => (
                <tr key={p.id}>
                  <td><RefCode code={p.code} /></td>
                  <td className="ad-bold ad-cell-title">{p.name}</td>
                  <td className="ad-num">{p.budget}</td>
                  <td className="ad-nowrap">{deadlineLabel(p)}</td>
                  <td className="ad-nowrap">{p.type}</td>
                  <td><span className="ui-badge ui-badge--neutral">{p.eligibleTypes}</span></td>
                  <td>
                    <StatusBadge tone={p.status === 'awarded' ? 'success' : 'neutral'} label={closedLabel(p)} />
                  </td>
                  <td className="ad-actions-col">
                    <button className="ad-btn-view-sm" onClick={() => navigate(`/admin/bids/${p.id}`)}>
                      <Eye size={13} /> View Bids
                    </button>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}

// Publishes an approved procurement so eligible suppliers can start bidding.
function PublishButton({ project, onPublished }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const onPublish = async () => {
    setBusy(true); setErr('')
    try {
      await publishProject(project.id)
      onPublished?.(project)
    }
    catch (e) { setErr(e.message || 'Publish failed.'); setBusy(false) }
  }
  return (
    <>
      <button className="ad-btn-publish" onClick={onPublish} disabled={busy}>
        {busy ? 'Publishing…' : 'Publish'}
      </button>
      {err && <span style={{ color: '#ef4444', fontSize: 11, marginLeft: 6 }}>{err}</span>}
    </>
  )
}

// ── Planning Page ─────────────────────────────────────────────────────────────

const PROCUREMENT_TYPES = ['Goods', 'Services', 'Infrastructure', 'Consulting Services']
const EMPTY_PROJECT = {
  name: '', category: '', type: 'Goods', budget: '',
  delivery_location: '', bidding_period_days: '', delivery_period_days: '', description: '',
  reference_image: null,   // optional product reference photo (File)
  require_product_images: false,   // bidders must attach product photos
  product_image_instructions: '',  // optional guidance shown to bidders
}
// Common bidding windows — the deadline itself is computed at publish time
// (today + this many days), never chosen as a fixed calendar date, so it can
// never go stale while the project waits in approval.
const BIDDING_PERIOD_OPTIONS = [7, 14, 21, 30, 45, 60]
// Delivery windows, counted from AWARD (Notice to Proceed), not bid close —
// standard procurement practice. No same-day option: even an urgent order
// needs time for Notice of Award + contract signing first.
const DELIVERY_PERIOD_OPTIONS = [3, 7, 14, 30, 60, 90]
const REQUIRED_PROCUREMENT_DOCS = [
  { key: 'purchase_request', label: 'Purchase Request (PR)' },
  { key: 'technical_specifications', label: 'Technical Specifications' },
  { key: 'terms_of_reference', label: 'Terms of Reference (TOR)' },
  { key: 'approved_budget_document', label: 'Approved Budget Document' },
  { key: 'bid_evaluation_criteria', label: 'Bid Evaluation Criteria' },
]
const DOC_EXT = ['pdf', 'jpg', 'jpeg', 'png']
const checkDoc = (f) => {
  const ext = f.name.split('.').pop().toLowerCase()
  if (!DOC_EXT.includes(ext)) return `Unsupported type ".${ext}". Use PDF, JPG, or PNG.`
  if (f.size > 5 * 1024 * 1024) return 'File is too large (max 5 MB).'
  return ''
}

// Reference image rules: image types only (JPG/PNG/WEBP), max 5 MB. Returns an
// error message or '' when the file is acceptable.
const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp']
const checkImage = (f) => {
  const ext = f.name.split('.').pop().toLowerCase()
  if (!IMG_EXT.includes(ext)) return 'Only image files are accepted.'
  if (f.size > 5 * 1024 * 1024) return 'Image must be under 5MB.'
  return ''
}
// ── Assisted Registration (admin fills the supplier's form for a walk-in
// applicant who brought physical documents) ─────────────────────────────────
const ASSISTED_EMPTY = {
  full_name: '', email: '', password: '', confirm_password: '',
  company_name: '', company_address: '', phone_number: '', tin: '',
  representative_name: '', mayors_permit_expiry: '', tax_clearance_expiry: '',
  financial_statement_year: '', track_record_description: '',
  declaration_accepted: false,
}
const ASSISTED_REQUIRED_DOCS = [
  { key: 'sec_dti_certificate', label: 'SEC or DTI Certificate' },
  { key: 'mayors_permit', label: "Mayor's Permit / Business Permit" },
  { key: 'philgeps_certificate', label: 'PhilGEPS Registration Certificate' },
  { key: 'valid_id', label: 'Valid ID (Government-issued)' },
  { key: 'tax_clearance_certificate', label: 'Tax Clearance Certificate' },
  { key: 'audited_financial_statements', label: 'Audited Financial Statements' },
  { key: 'bank_reference_letter', label: 'Bank Reference Letter' },
  { key: 'authorization_letter', label: 'Authorization Letter / SPA' },
]
const ASSISTED_OPTIONAL_DOCS = [
  { key: 'performance_certificates', label: 'Performance Certificates / ISO' },
  { key: 'past_contracts', label: 'Past Contracts / Purchase Orders' },
]

const fmtBytes = (n) => {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Optional reference-image upload control: dashed drop zone that swaps to an
// image preview (with a remove button) once a file is chosen. `file` is a File;
// `existingUrl` is a previously-saved image shown when editing.
function ReferenceImageUploader({ file, existingUrl, onFile, onRemove }) {
  const [preview, setPreview] = useState('')
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file)
      setPreview(url)
      return () => URL.revokeObjectURL(url)
    }
    setPreview('')
  }, [file])

  const shown = preview || existingUrl
  const handleDrop = (e) => {
    e.preventDefault(); setDragOver(false)
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) onFile(dropped)
  }

  return (
    <div className="ad-form-full">
      <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-dark)' }}>
        Reference Image <span className="ad-opt-tag" style={{ marginLeft: 6 }}>Optional</span>
      </label>
      <div className="ad-muted ad-small" style={{ marginBottom: 10 }}>
        Upload a photo or image showing the exact product, model, color, or design you require.
        This helps suppliers understand exactly what to bid for.
      </div>

      {shown ? (
        <div className="ad-refimg-preview">
          <img src={shown} alt="Reference preview" className="ad-refimg-img" />
          <button type="button" className="ad-refimg-remove" onClick={onRemove} aria-label="Remove image">
            <X size={14} />
          </button>
          {file && (
            <div className="ad-refimg-meta">
              <span className="ad-refimg-name" title={file.name}>{file.name}</span>
              <span className="ad-muted ad-small">{fmtBytes(file.size)}</span>
            </div>
          )}
        </div>
      ) : (
        <label
          className={`ad-refimg-drop${dragOver ? ' ad-refimg-drop-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <ImageIcon size={28} className="ad-muted" />
          <span className="ad-refimg-cta">Click to upload or drag and drop</span>
          <span className="ad-muted ad-small">JPG, PNG, WEBP · max 5MB</span>
          <input type="file" accept=".jpg,.jpeg,.png,.webp" hidden
            onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = '' }} />
        </label>
      )}
    </div>
  )
}

// Single document upload control used in the procurement creation form.
function DocUploader({ doc, file, onFile, onRemove, optional }) {
  const inputId = `doc-${doc.key}`
  return (
    <div className="ad-doc-field">
      <div className="ad-doc-label">
        {doc.label} <span className={optional ? 'ad-doc-opt' : 'ad-doc-req'}>{optional ? 'Optional' : 'Required'}</span>
      </div>
      {file ? (
        <div className="ad-doc-file">
          <FileText size={14} />
          <span className="ad-doc-name" title={file.name}>{file.name}</span>
          <button type="button" onClick={onRemove} aria-label="Remove"><X size={14} /></button>
        </div>
      ) : (
        <label htmlFor={inputId} className="ad-doc-upload">
          <FileText size={14} /> Upload file
        </label>
      )}
      <input id={inputId} type="file" accept=".pdf,.jpg,.jpeg,.png" hidden
        onChange={e => onFile(doc.key, e.target.files[0])} />
    </div>
  )
}

// Read-only detail view for a planning procurement: its info + uploaded documents.
function ProjectDetailModal({ project, onClose, setToast }) {
  const needsRevision = project.status === 'needs_revision'
  const [files, setFiles] = useState({})   // { docKey: File }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const onFile = (key, file) => {
    if (!file) return
    const msg = checkDoc(file)
    if (msg) { setErr(`${key.replace(/_/g, ' ')}: ${msg}`); return }
    setErr('')
    setFiles(f => ({ ...f, [key]: file }))
  }

  const flaggedDocs = project.documents.filter(d => d.review_status === 'needs_revision')
  const allReplaced = flaggedDocs.every(d => files[d.key])

  const doResubmit = async () => {
    setBusy(true)
    try {
      const fd = new FormData()
      Object.entries(files).forEach(([k, file]) => fd.append(k, file))
      await resubmitProjectDocuments(project.id, fd)
      setToast({ type: 'success', message: 'Document(s) resubmitted — back in the Head\'s queue for review.' })
      onClose()
    } catch (e) {
      setErr(e.message || 'Could not resubmit documents.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ad-modal-overlay" onClick={onClose}>
      <div className="ad-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-header">
          <div>
            <h3>{project.name}</h3>
            <div className="ad-ref-line">
              <RefCode code={project.code} />
              <span className="ad-muted ad-small">{project.category || '—'}</span>
            </div>
          </div>
          <button className="ad-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="ad-modal-body">
          <div className="ad-modal-badges">
            <StatusBadge domain="project" status={project.status} />
          </div>

          {project.status === 'rejected' && project.rejectReason && (
            <div className="ad-modal-error"><AlertTriangle size={15} /> Reason: {project.rejectReason}</div>
          )}

          {needsRevision && (
            <div className="ad-modal-error" style={{ background: 'rgba(249,115,22,0.08)', borderColor: 'rgba(249,115,22,0.3)', color: '#c2410c' }}>
              <AlertTriangle size={15} /> The Head flagged {flaggedDocs.length} document(s) below — re-upload the
              fixed file(s) and resubmit. The project will go back to the Head's queue automatically.
            </div>
          )}

          {project.referenceImage && (
            <div className="ad-refimg-section">
              <div className="ad-refimg-section-label"><ImageIcon size={14} /> Reference Image</div>
              <img src={project.referenceImage} alt="Reference" className="ad-refimg-view" />
            </div>
          )}

          <div className="ad-info-grid">
            <Info2 label="Procurement Type" value={project.type} />
            <Info2 label="Approved Budget (ABC)" value={project.budget} />
            <Info2 label="Bid Submission Deadline" value={deadlineLabel(project)} />
            <Info2 label="Expected Delivery" value={deliveryLabel(project)} />
            <Info2 label="Delivery Location" value={project.deliveryLocation} />
            <Info2 label="Submitted" value={project.submittedAt} />
            <Info2
              label="Product Images from Bidders"
              value={project.requireProductImages ? 'Required' : 'Optional'}
            />
            {project.requireProductImages && project.productImageInstructions && (
              <Info2 label="Instructions for Bidders" value={project.productImageInstructions} full />
            )}
            <Info2 label="Description" value={project.description} full />
          </div>

          <div className="ad-docs-head"><FileText size={15} /> Procurement Documents</div>
          <div className="ad-docs-list">
            {project.documents.map(d => {
              const flagged = d.review_status === 'needs_revision'
              return (
                <div className={`ad-doc-row${flagged ? ' flagged' : ''}`} key={d.key}>
                  <div className="ad-doc-main">
                    <div className="ad-doc-name">
                      <span className="ad-bold">{d.label}</span>
                      <span className={d.required ? 'ad-req-tag' : 'ad-opt-tag'}>{d.required ? 'Required' : 'Optional'}</span>
                      {flagged
                        ? <span className="ad-doc-status ad-doc-flag">Flagged for revision</span>
                        : d.review_status === 'approved'
                          ? <span className="ad-doc-status ad-doc-ok"><Check size={11} /> Reviewed</span>
                          : null}
                    </div>
                    {d.url
                      ? <a className="ad-doc-view" href={d.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> View</a>
                      : <span className="ad-doc-missing">Not uploaded</span>}
                  </div>
                  {flagged && d.review_note && (
                    <div className="ad-doc-prevnote">Head's note: “{d.review_note}”</div>
                  )}
                  {flagged && (
                    files[d.key] ? (
                      <div className="ad-doc-file" style={{ marginTop: 8 }}>
                        <FileText size={14} />
                        <span className="ad-doc-name" title={files[d.key].name}>{files[d.key].name}</span>
                        <button type="button" onClick={() => setFiles(f => { const n = { ...f }; delete n[d.key]; return n })} aria-label="Remove"><X size={14} /></button>
                      </div>
                    ) : (
                      <label className="ad-doc-upload" style={{ marginTop: 8 }}>
                        <FileText size={14} /> Upload fixed file
                        <input type="file" accept=".pdf,.jpg,.jpeg,.png" hidden
                          onChange={e => onFile(d.key, e.target.files[0])} />
                      </label>
                    )
                  )}
                </div>
              )
            })}
          </div>
          {err && <div className="ad-modal-error" style={{ marginTop: 12 }}><AlertTriangle size={15} /> {err}</div>}
        </div>

        <div className="ad-modal-footer">
          <button className="ad-btn-cancel" onClick={onClose}>Close</button>
          {needsRevision && (
            <button className="ad-btn-primary" disabled={!allReplaced || busy} onClick={doResubmit}>
              {busy ? 'Resubmitting…' : 'Resubmit Documents'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function PlanningPage() {
  const { projects, loading } = useProjects()
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_PROJECT)
  const [files, setFiles] = useState({})        // { docKey: File }
  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState('')
  const [toast, setToast] = useState(null)      // { type, message }
  const [viewProject, setViewProject] = useState(null) // project shown in detail modal
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const onDoc = (key, file) => {
    if (!file) return
    const msg = checkDoc(file)
    if (msg) { setSubmitErr(`${key.replace(/_/g, ' ')}: ${msg}`); return }
    setSubmitErr('')
    setFiles(f => ({ ...f, [key]: file }))
  }

  // Optional reference image — validate type/size before keeping it; a bad image
  // never blocks the rest of the form (the field just stays empty).
  const onImage = (file) => {
    if (!file) return
    const msg = checkImage(file)
    if (msg) { setSubmitErr(msg); return }
    setSubmitErr('')
    set('reference_image', file)
  }

  const resetForm = () => { setForm(EMPTY_PROJECT); setFiles({}); setShowForm(false) }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const missingDocs = REQUIRED_PROCUREMENT_DOCS.filter(d => !files[d.key])
    if (!form.category) { setSubmitErr('Select a procurement category.'); return }
    if (missingDocs.length) {
      setSubmitErr(`Upload all required documents (${missingDocs.length} missing).`); return
    }
    setSubmitErr(''); setSubmitting(true)
    try {
      await createProject(form, files)
      resetForm()
      setToast({ type: 'success', message: 'Procurement submitted to the Head for approval.' })
    } catch (err) {
      setSubmitErr(err.message || 'Could not create the project. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // Planning holds projects still in the pipeline: drafts, those awaiting the
  // Head's approval, and any the Head rejected. Approved projects move to Projects.
  const planning = projects.filter(p => ['draft', 'pending_head', 'needs_revision', 'rejected'].includes(p.status))

  const filtered = planning.filter(p => {
    const q = search.toLowerCase()
    return !q || p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q) ||
      (p.code || '').toLowerCase().includes(q)
  })

  return (
    <div className="ad-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      {viewProject && (
        <ProjectDetailModal
          project={viewProject}
          onClose={() => setViewProject(null)}
          setToast={setToast}
        />
      )}
      <div className="ad-card">
        <div className="ad-card-header">
          <label className="ad-search-inline">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">Search planning requests</span>
            <input placeholder="Search by title, type, or ref code" value={search} onChange={e => setSearch(e.target.value)} />
          </label>
          <button className="ad-btn-primary" onClick={() => setShowForm(v => !v)}>
            <Plus size={14} /> {showForm ? 'Cancel' : 'Create Project'}
          </button>
        </div>

        {showForm && (
          <div className="ad-form-wrap">
            <div className="ad-form-title">Create New Procurement</div>
            <form onSubmit={handleSubmit} className="ad-form-grid">
              <div className="ad-form-group ad-form-full">
                <label>Project Title<span className="ui-req" aria-hidden="true">*</span></label>
                <input value={form.name} onChange={e => set('name', e.target.value)} required />
              </div>
              <div className="ad-form-group">
                <label>Procurement Category<span className="ui-req" aria-hidden="true">*</span></label>
                <select value={form.category} onChange={e => set('category', e.target.value)} required>
                  <option value="" disabled>Select a category…</option>
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="ad-form-group">
                <label>Procurement Type</label>
                <select value={form.type} onChange={e => set('type', e.target.value)}>
                  {PROCUREMENT_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div className="ad-form-group">
                <label>Approved Budget (ABC)<span className="ui-req" aria-hidden="true">*</span></label>
                <input value={form.budget} onChange={e => set('budget', e.target.value)} placeholder="e.g. ₱50,000" required />
              </div>
              <div className="ad-form-group">
                <label>Delivery Location<span className="ui-req" aria-hidden="true">*</span></label>
                <input value={form.delivery_location} onChange={e => set('delivery_location', e.target.value)} placeholder="e.g. Main Campus" required />
              </div>
              <div className="ad-form-group">
                <label>Bidding Period<span className="ui-req" aria-hidden="true">*</span></label>
                <select value={form.bidding_period_days} onChange={e => set('bidding_period_days', e.target.value)} required>
                  <option value="" disabled>Select a period…</option>
                  {BIDDING_PERIOD_OPTIONS.map(n => <option key={n} value={n}>{n} days</option>)}
                </select>
                <span className="ad-muted ad-small" style={{ marginTop: 4, display: 'block' }}>
                  The actual deadline is set automatically when you publish — suppliers always get the full window.
                </span>
              </div>
              <div className="ad-form-group">
                <label>Delivery Period<span className="ui-req" aria-hidden="true">*</span></label>
                <select value={form.delivery_period_days} onChange={e => set('delivery_period_days', e.target.value)} required>
                  <option value="" disabled>Select a period…</option>
                  {DELIVERY_PERIOD_OPTIONS.map(n => <option key={n} value={n}>{n} days</option>)}
                </select>
                <span className="ad-muted ad-small" style={{ marginTop: 4, display: 'block' }}>
                  Counted from the day a winner is selected, not from today.
                </span>
              </div>
              <div className="ad-form-group ad-form-full">
                <label>Project Description<span className="ui-req" aria-hidden="true">*</span></label>
                <textarea value={form.description} onChange={e => set('description', e.target.value)} rows={3} required />
              </div>

              <div className="ad-form-full">
                <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-dark)' }}>
                  Required Procurement Documents
                </label>
                <div className="ad-muted ad-small" style={{ marginBottom: 10 }}>
                  PDF, JPG, or PNG · max 5 MB each. All are required before submitting for approval.
                </div>
                <div className="ad-doc-grid">
                  {REQUIRED_PROCUREMENT_DOCS.map(d => (
                    <DocUploader key={d.key} doc={d} file={files[d.key]} onFile={onDoc}
                      onRemove={() => setFiles(f => { const n = { ...f }; delete n[d.key]; return n })} />
                  ))}
                </div>
              </div>

              <ReferenceImageUploader
                file={form.reference_image}
                onFile={onImage}
                onRemove={() => set('reference_image', null)}
              />

              {/* Off by default: only procurements where the exact product,
                  brand or style matters need bidders to show photos of it. */}
              <div className="ad-form-full ad-pimg-option">
                <label className="ad-pimg-toggle">
                  <input
                    type="checkbox"
                    checked={form.require_product_images}
                    onChange={e => set('require_product_images', e.target.checked)}
                  />
                  <span>
                    <strong>Require product images from bidders</strong>
                    <span className="ad-muted ad-small">
                      Each supplier must attach at least one photo (up to 5) of the exact product they are offering.
                    </span>
                  </span>
                </label>
                {form.require_product_images && (
                  <div className="ad-form-group" style={{ marginTop: 10 }}>
                    <label htmlFor="pimg-instructions">Instructions for bidders <span className="ad-opt-tag">Optional</span></label>
                    <textarea
                      id="pimg-instructions"
                      rows={2}
                      maxLength={300}
                      value={form.product_image_instructions}
                      onChange={e => set('product_image_instructions', e.target.value)}
                      placeholder="e.g. Show the exact brand/model and a photo of the actual product"
                    />
                    <span className="ad-muted ad-small">{form.product_image_instructions.length} / 300</span>
                  </div>
                )}
              </div>

              {submitErr && (
                <div className="ad-form-full ad-inline-error" role="alert">
                  <AlertTriangle size={15} aria-hidden="true" /> {submitErr}
                </div>
              )}
              <div className="ad-form-actions">
                <button type="button" className="ad-btn-cancel" onClick={resetForm}>Cancel</button>
                <button type="submit" className="ad-btn-primary" disabled={submitting}>
                  {submitting ? 'Submitting…' : 'Submit for Head Approval'}
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="ad-table-scroll ad-x-scroll">
        <table className="ad-table">
          <thead>
            <tr>
              <th>Ref Code</th><th>Project Title</th><th className="ad-num">Budget</th><th>Type</th>
              <th>Bidding Period</th><th>Status</th><th className="ad-actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && filtered.length === 0
              ? <TableSkeleton rows={4} cols={7} />
              : filtered.length === 0
              ? <TableEmpty colSpan={7} icon={Calendar}
                  title={search ? 'No planning requests match your search' : 'No planning requests yet'}
                  description={search
                    ? 'Try a different title, type, or ref code.'
                    : 'Create a procurement project to start the approval workflow. It goes to the Head for review before it can be published.'}
                  action={!search && !showForm && (
                    <button className="ad-btn-primary" onClick={() => setShowForm(true)}>
                      <Plus size={14} /> Create Project
                    </button>
                  )} />
              : filtered.map(p => (
                <tr key={p.id}>
                  <td><RefCode code={p.code} /></td>
                  <td className="ad-bold">
                    {p.name}
                    {p.status === 'rejected' && p.rejectReason && (
                      <div className="ad-muted ad-small" style={{ fontWeight: 400, marginTop: 2 }}>
                        Reason: {p.rejectReason}
                      </div>
                    )}
                    {p.status === 'needs_revision' && (
                      <div className="ad-muted ad-small" style={{ fontWeight: 400, marginTop: 2, color: '#c2410c' }}>
                        {p.documents.filter(d => d.review_status === 'needs_revision').length} document(s) flagged by the Head — click View Details to fix.
                      </div>
                    )}
                  </td>
                  <td className="ad-num">{p.budget}</td>
                  <td className="ad-nowrap">{p.type}</td>
                  <td><DeadlineCell project={p} /></td>
                  <td>
                    <StatusBadge domain="project" status={p.status} />
                  </td>
                  <td className="ad-actions-col">
                    <div className="ad-actions">
                      <button className="ad-btn-view-sm" onClick={() => setViewProject(p)}>
                        <Eye size={12} /> View Details
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}

// ── Suppliers Page ────────────────────────────────────────────────────────────

const QUAL_CLS = {
  verified: 'badge-green',
  waiting_admin_approval: 'badge-yellow',
  needs_revision: 'badge-orange',
  rejected: 'badge-red',
}
const QUAL_LABEL = {
  verified: 'Verified',
  waiting_admin_approval: 'Waiting Admin Approval',
  needs_revision: 'Needs Revision',
  rejected: 'Rejected',
}
const SUP_STATUS_CLS = {
  draft: 'badge-gray', approved: 'badge-green',
  rejected: 'badge-red', pending: 'badge-yellow',
}

// Module-level cache: the supplier list survives navigating away and back, so
// returning to this page shows data instantly instead of a full "Loading…" pass.
let supplierCache = null

// Placeholder row shown while the supplier list loads (matches the 8 columns).
function SupplierRowSkeleton() {
  const widths = ['70%', '60%', '80%', '50%', '65%', '55%', '60%', '40%']
  return (
    <tr>
      {widths.map((w, i) => (
        <td key={i}><span className="ad-skel" style={{ width: w }} /></td>
      ))}
    </tr>
  )
}

function SuppliersPage() {
  const [suppliers, setSuppliers] = useState(supplierCache || [])
  // Only show the loader on the very first load (when we have nothing cached yet).
  const [loading, setLoading] = useState(supplierCache === null)
  const [error, setError] = useState('')
  const [filterTab, setFilterTab] = useState('All')
  const [search, setSearch] = useState('')
  const [viewId, setViewId] = useState(null)
  const [toast, setToast] = useState(null) // { type, message }
  const TABS = ['All', 'Pending', 'Approved', 'Rejected']

  // ── Assisted Registration (walk-in supplier) ────────────────────────────────
  const [showRegisterForm, setShowRegisterForm] = useState(false)
  const [regForm, setRegForm] = useState(ASSISTED_EMPTY)
  const [regTypes, setRegTypes] = useState([])
  const [regFiles, setRegFiles] = useState({})
  const [regErr, setRegErr] = useState('')
  const [regSubmitting, setRegSubmitting] = useState(false)
  const setReg = (k, v) => setRegForm(f => ({ ...f, [k]: v }))
  const toggleRegType = (t) =>
    setRegTypes(list => list.includes(t) ? list.filter(x => x !== t) : [...list, t])
  const onRegDoc = (key, file) => {
    if (!file) return
    const msg = checkDoc(file)
    if (msg) { setRegErr(`${key.replace(/_/g, ' ')}: ${msg}`); return }
    setRegErr('')
    setRegFiles(f => ({ ...f, [key]: file }))
  }
  const removeRegFile = (key) => setRegFiles(f => { const n = { ...f }; delete n[key]; return n })
  const resetRegForm = () => {
    setRegForm(ASSISTED_EMPTY); setRegTypes([]); setRegFiles({}); setRegErr(''); setShowRegisterForm(false)
  }
  const handleRegSubmit = async (e) => {
    e.preventDefault()
    if (regForm.password !== regForm.confirm_password) { setRegErr('Passwords do not match.'); return }
    if (regTypes.length === 0) { setRegErr('Select at least one business type.'); return }
    const missing = ASSISTED_REQUIRED_DOCS.filter(d => !regFiles[d.key])
    if (missing.length) { setRegErr(`Upload all required documents (${missing.length} missing).`); return }
    if (!regForm.declaration_accepted) { setRegErr('Confirm the declaration before submitting.'); return }
    setRegErr(''); setRegSubmitting(true)
    try {
      const fd = new FormData()
      Object.entries(regForm).forEach(([k, v]) => { if (v !== '' && v !== false) fd.append(k, v) })
      fd.append('declaration_accepted', regForm.declaration_accepted)
      fd.append('business_types', JSON.stringify(regTypes))
      Object.entries(regFiles).forEach(([k, file]) => fd.append(k, file))
      await apiAdminRegisterSupplier(fd)
      resetRegForm()
      showToast('success', 'Supplier registered. Pending admin verification.')
      load({ background: true })
    } catch (err) {
      setRegErr(err.message || 'Could not register the supplier. Please try again.')
    } finally {
      setRegSubmitting(false)
    }
  }

  // `background` = refresh silently without blanking the table (used on revisit
  // and after a review action, since we already have data to show).
  const load = ({ background = false } = {}) => {
    if (!background) setLoading(true)
    apiListSuppliers()
      .then(data => { supplierCache = data; setSuppliers(data); setError('') })
      // A failed background refresh must NOT wipe data we're already showing —
      // only surface the error when the table is empty (i.e. the first load).
      .catch(err => { if (!supplierCache) setError(err.message) })
      .finally(() => setLoading(false))
  }
  // First visit: show the loader. Revisit (cache present): refresh in background.
  useEffect(() => { load({ background: supplierCache !== null }) }, [])

  const showToast = (type, message) => setToast({ type, message })

  const filtered = suppliers.filter(s => {
    const q = search.toLowerCase()
    const matchSearch = !q ||
      (s.company || '').toLowerCase().includes(q) ||
      (s.contact || '').toLowerCase().includes(q) ||
      (s.full_name || '').toLowerCase().includes(q)
    const qs = s.qualification_status
    const matchTab =
      filterTab === 'All'      ? true :
      filterTab === 'Pending'  ? (qs === 'waiting_admin_approval' || qs === 'needs_revision') :
      filterTab === 'Approved' ? qs === 'verified' :
      filterTab === 'Rejected' ? qs === 'rejected' : true
    return matchSearch && matchTab
  })

  return (
    <div className="ad-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      {viewId !== null && (
        <SupplierDetailModal
          supplierId={viewId}
          onClose={() => setViewId(null)}
          onReviewed={(message) => { showToast('success', message); load({ background: true }) }}
        />
      )}

      <div className="ad-card">
        <div className="ad-card-header ad-toolbar-row">
          <div className="ad-filter-pills ad-filter-pills-inline" role="tablist" aria-label="Filter suppliers">
            {TABS.map(t => (
              <button key={t} role="tab" aria-selected={filterTab === t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
            ))}
          </div>
          <div className="ad-toolbar">
            <label className="ad-search-inline">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search suppliers</span>
              <input placeholder="Search by company or name" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
            <button className="ad-btn-primary" onClick={() => setShowRegisterForm(true)}>
              <Plus size={14} /> Register Supplier
            </button>
          </div>
        </div>

        {showRegisterForm && (
          <AssistedRegisterModal
            form={regForm} set={setReg} types={regTypes} toggleType={toggleRegType}
            files={regFiles} onFile={onRegDoc} removeFile={removeRegFile}
            error={regErr} setError={setRegErr} submitting={regSubmitting}
            onSubmit={handleRegSubmit} onClose={resetRegForm}
          />
        )}

        <div className="ad-table-scroll ad-x-scroll">
        <table className="ad-table">
          <thead>
            <tr>
              <th>Company</th><th>Contact</th><th>Business Type</th><th>Status</th>
              <th>Qualification Status</th><th>Email Verified</th><th>Registered</th><th className="ad-actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }).map((_, i) => <SupplierRowSkeleton key={i} />)
              : error
              ? <TableEmpty colSpan={8} icon={AlertTriangle} title="Could not load suppliers" description={error} />
              : filtered.length === 0
              ? <TableEmpty colSpan={8} icon={Users}
                  title={search || filterTab !== 'All' ? 'No suppliers match your filters' : 'No suppliers yet'}
                  description={search || filterTab !== 'All'
                    ? 'Try a different search or filter.'
                    : 'Suppliers appear here when they self-register or you register one in person.'} />
              : filtered.map(s => (
                <tr key={s.id}>
                  <td className="ad-bold">{s.company}</td>
                  <td>{s.contact || s.full_name}</td>
                  <td className="ad-muted" style={{ maxWidth: 200, wordBreak: 'break-word', fontSize: 12 }}>{s.business_type}</td>
                  <td><StatusBadge domain="supplier" status={s.status} /></td>
                  <td>
                    <div className="ad-badge-stack">
                      <StatusBadge domain="qualification" status={s.qualification_status} />
                      {s.category_request_status === 'pending' && (
                        <StatusBadge tone="warning" dot={false} label="Category change"
                          title="This supplier asked to change their business categories" />
                      )}
                    </div>
                  </td>
                  <td><StatusBadge domain="email" status={!!s.email_verified} /></td>
                  <td className="ad-muted ad-nowrap">{s.registered}</td>
                  <td className="ad-actions-col">
                    <button className="ad-btn-view-sm" onClick={() => setViewId(s.id)}>
                      <Eye size={13} /> View
                    </button>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}

// Walk-in supplier registration, filled out by the Admin on the supplier's
// behalf. Same fields/validation as the public self-registration form — only
// who fills it in differs. Opens as a modal so it never pushes the table down.
// Label + input pair with a proper htmlFor link, required marker and hint.
// Module-level (not inside the modal) so inputs keep focus while typing.
function FormField({ id, label, required = true, hint, full, children }) {
  return (
    <div className={`ad-form-group${full ? ' ad-form-full' : ''}`}>
      <label htmlFor={id}>
        {label}{required && <span className="ui-req" aria-hidden="true">*</span>}
      </label>
      {children}
      {hint && <span className="ui-hint">{hint}</span>}
    </div>
  )
}

const ASSISTED_STEPS = ['Basic Info', 'Documents', 'Declaration', 'Review']

function AssistedRegisterModal({ form, set, types, toggleType, files, onFile, removeFile, error, setError, submitting, onSubmit, onClose }) {
  const [step, setStep] = useState(0)

  const validateStep = () => {
    if (step === 0) {
      const need = ['full_name', 'email', 'company_name', 'company_address',
        'phone_number', 'tin', 'representative_name']
      if (need.some(k => !form[k].trim())) return 'Please fill in all required fields.'
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return 'Enter a valid email address.'
      if (!/^\d+$/.test(form.phone_number)) return 'Phone number must contain digits only.'
      if (!/^[\d-]+$/.test(form.tin)) return 'TIN must contain digits only.'
      if (form.password.length < 8) return 'Password must be at least 8 characters.'
      if (form.password !== form.confirm_password) return 'Passwords do not match.'
      if (types.length === 0) return 'Select at least one business type.'
    }
    if (step === 1) {
      const missing = ASSISTED_REQUIRED_DOCS.filter(d => !files[d.key])
      if (missing.length) return `Upload all required documents (${missing.length} missing).`
    }
    if (step === 2 && !form.declaration_accepted) {
      return 'Confirm the declaration before continuing.'
    }
    return ''
  }

  const next = () => {
    const msg = validateStep()
    if (msg) { setError(msg); return }
    setError('')
    setStep(s => Math.min(s + 1, ASSISTED_STEPS.length - 1))
  }
  const back = () => { setError(''); setStep(s => Math.max(s - 1, 0)) }

  const requiredUploaded = ASSISTED_REQUIRED_DOCS.filter(d => files[d.key]).length
  const optionalUploaded = ASSISTED_OPTIONAL_DOCS.filter(d => files[d.key]).length

  return (
    <div className="ad-modal-overlay" onClick={onClose}>
      <div
        className="ad-modal ad-modal-wizard"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 720 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="assisted-reg-title"
      >
        <div className="ad-modal-header">
          <div>
            <h3 id="assisted-reg-title">Assisted Supplier Registration</h3>
            <p className="ad-muted ad-small" style={{ marginTop: 4, maxWidth: 560 }}>
              For a supplier who came in person with physical documents — their account is created the
              same way as a self-registration and still needs your approval before they can bid.
            </p>
          </div>
          <button type="button" className="ad-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="ad-wizard-steps">
          <Stepper steps={ASSISTED_STEPS} current={step} label="Registration steps" />
        </div>

        <div className="ad-modal-body">
          {error && <div className="ad-modal-error" role="alert"><AlertTriangle size={15} /> {error}</div>}

          {step === 0 && (
            <div>
              <section className="ui-form-section">
                <div className="ui-form-section-title">Account login</div>
                <div className="ad-form-grid">
                  <FormField id="ar-full-name" label="Full Name">
                    <input id="ar-full-name" autoComplete="off" value={form.full_name} onChange={e => set('full_name', e.target.value)} />
                  </FormField>
                  <FormField id="ar-email" label="Email Address" hint="The supplier signs in with this and receives the verification link.">
                    <input id="ar-email" type="email" autoComplete="off" inputMode="email" value={form.email} onChange={e => set('email', e.target.value)} />
                  </FormField>
                  <FormField id="ar-password" label="Password" hint="At least 8 characters.">
                    <input id="ar-password" type="password" autoComplete="new-password" value={form.password} onChange={e => set('password', e.target.value)} />
                  </FormField>
                  <FormField id="ar-confirm" label="Confirm Password">
                    <input id="ar-confirm" type="password" autoComplete="new-password" value={form.confirm_password} onChange={e => set('confirm_password', e.target.value)} />
                  </FormField>
                </div>
              </section>

              <section className="ui-form-section">
                <div className="ui-form-section-title">Company details</div>
                <div className="ad-form-grid">
                  <FormField id="ar-company" label="Company Name" full>
                    <input id="ar-company" autoComplete="off" value={form.company_name} onChange={e => set('company_name', e.target.value)} />
                  </FormField>
                  <FormField id="ar-address" label="Company Address" full>
                    <input id="ar-address" autoComplete="off" value={form.company_address} onChange={e => set('company_address', e.target.value)} />
                  </FormField>
                  <FormField id="ar-phone" label="Phone Number" hint="Digits only.">
                    <input id="ar-phone" autoComplete="off" inputMode="numeric" value={form.phone_number} onChange={e => set('phone_number', e.target.value.replace(/[^\d]/g, ''))} />
                  </FormField>
                  <FormField id="ar-tin" label="TIN" hint="Digits and dashes only.">
                    <input id="ar-tin" autoComplete="off" inputMode="numeric" value={form.tin} onChange={e => set('tin', e.target.value.replace(/[^\d-]/g, ''))} />
                  </FormField>
                  <FormField id="ar-rep" label="Representative Name" full>
                    <input id="ar-rep" autoComplete="off" value={form.representative_name} onChange={e => set('representative_name', e.target.value)} />
                  </FormField>
                </div>
              </section>

              <section className="ui-form-section">
                <div className="ui-form-section-title">
                  Business type<span className="ui-req" aria-hidden="true">*</span>
                </div>
                <p className="ui-hint" style={{ marginTop: -6, marginBottom: 10 }}>
                  Select every category the supplier can bid on. At least one is required.
                </p>
                <div className="ad-checks" role="group" aria-label="Business type">
                  {CATEGORIES.map(t => (
                    <label key={t} className={types.includes(t) ? 'on' : ''}>
                      <input type="checkbox" checked={types.includes(t)} onChange={() => toggleType(t)} />
                      {t}
                    </label>
                  ))}
                </div>
              </section>
            </div>
          )}

          {step === 1 && (
            <div>
              <section className="ui-form-section">
                <div className="ui-form-section-title ad-section-title-row">
                  <span>Required documents<span className="ui-req" aria-hidden="true">*</span></span>
                  <StatusBadge
                    tone={requiredUploaded === ASSISTED_REQUIRED_DOCS.length ? 'success' : 'neutral'}
                    label={`${requiredUploaded} / ${ASSISTED_REQUIRED_DOCS.length} uploaded`}
                  />
                </div>
                <p className="ui-hint" style={{ marginTop: -6, marginBottom: 12 }}>
                  Upload a clear scanned copy or photo of the document. Make sure the full document is readable.
                  PDF, JPG, or PNG · max 5 MB each.
                </p>
                <div className="ad-doc-grid">
                  {ASSISTED_REQUIRED_DOCS.map(d => (
                    <DocUploader key={d.key} doc={d} file={files[d.key]} onFile={onFile}
                      onRemove={() => removeFile(d.key)} />
                  ))}
                </div>
              </section>

              <section className="ui-form-section">
                <div className="ui-form-section-title">Validity &amp; financials</div>
                <div className="ad-form-grid">
                  <FormField id="ar-mp-exp" label="Mayor's Permit Expiry" required={false}>
                    <input id="ar-mp-exp" type="date" value={form.mayors_permit_expiry} onChange={e => set('mayors_permit_expiry', e.target.value)} />
                  </FormField>
                  <FormField id="ar-tc-exp" label="Tax Clearance Expiry" required={false}>
                    <input id="ar-tc-exp" type="date" value={form.tax_clearance_expiry} onChange={e => set('tax_clearance_expiry', e.target.value)} />
                  </FormField>
                  <FormField id="ar-fs-year" label="Financial Statement Year" required={false} hint="Four-digit year, e.g. 2026.">
                    <input id="ar-fs-year" inputMode="numeric" autoComplete="off" value={form.financial_statement_year}
                      onChange={e => set('financial_statement_year', e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
                      placeholder="e.g. 2026" />
                  </FormField>
                </div>
              </section>

              <section className="ui-form-section">
                <div className="ui-form-section-title">Optional documents</div>
                <div className="ad-doc-grid">
                  {ASSISTED_OPTIONAL_DOCS.map(d => (
                    <DocUploader key={d.key} doc={d} file={files[d.key]} onFile={onFile}
                      onRemove={() => removeFile(d.key)} optional />
                  ))}
                </div>
                <div className="ad-form-grid" style={{ marginTop: 14 }}>
                  <FormField id="ar-track" label="Track Record Description" required={false} full>
                    <textarea id="ar-track" rows={2} value={form.track_record_description}
                      onChange={e => set('track_record_description', e.target.value)}
                      placeholder="Brief description of similar projects" />
                  </FormField>
                </div>
              </section>
            </div>
          )}

          {step === 2 && (
            <section className="ui-form-section">
              <div className="ui-form-section-title">Declaration</div>
              <p className="ad-small" style={{ lineHeight: 1.6, color: 'var(--text-body)' }}>
                Before submitting, confirm with the supplier (present in person) that all information and
                documents provided are true, accurate, and authentic. Any false statement or falsified
                document is grounds for disqualification.
              </p>
              <label className={`ad-declare${form.declaration_accepted ? ' on' : ''}`}>
                <input type="checkbox" checked={form.declaration_accepted}
                  onChange={e => set('declaration_accepted', e.target.checked)} />
                <span>The supplier confirms the information and documents provided are true, accurate, and authentic to the best of their knowledge.<span className="ui-req" aria-hidden="true">*</span></span>
              </label>
            </section>
          )}

          {step === 3 && (
            <section className="ui-form-section">
              <div className="ui-form-section-title">Review before submitting</div>
              <div className="ad-info-grid">
                <Info2 label="Company" value={form.company_name} />
                <Info2 label="Representative" value={form.representative_name} />
                <Info2 label="Email" value={form.email} />
                <Info2 label="Phone" value={form.phone_number} />
                <Info2 label="Required Docs Uploaded" value={`${requiredUploaded}/${ASSISTED_REQUIRED_DOCS.length}`} />
                <Info2 label="Optional Docs Uploaded" value={`${optionalUploaded}`} />
                <Info2 label="Status After Submission" value="Pending Verification" />
              </div>
              <div className="ui-callout ui-callout--neutral" style={{ marginTop: 12 }}>
                <Info size={16} className="ui-callout-icon" />
                <span>
                  The supplier account is created now and queued the same as any self-registration — review
                  and approve it from this Suppliers list before they can bid.
                </span>
              </div>
            </section>
          )}
        </div>

        <div className="ad-modal-footer">
          <button type="button" className="ui-btn ui-btn--ghost" onClick={onClose}>Cancel</button>
          <div className="ad-modal-footer-actions">
            {step > 0 && (
              <button type="button" className="ad-btn-cancel" onClick={back}>
                <ArrowLeft size={14} /> Back
              </button>
            )}
            {step < ASSISTED_STEPS.length - 1
              ? <button type="button" className="ad-btn-primary" onClick={next}>Continue <ChevronRight size={14} /></button>
              : <button type="button" className="ad-btn-primary" disabled={submitting} onClick={onSubmit}>
                  {submitting ? <><Loader2 size={14} className="ui-spin" /> Registering…</> : <><Check size={14} /> Register Supplier</>}
                </button>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Supplier detail / review modal ────────────────────────────────────────────

// Per-supplier detail cache so reopening the same supplier's profile is instant.
const supplierDetailCache = new Map()

// Placeholder layout shown while a supplier's profile loads in the modal.
function SupplierDetailSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <span className="ad-skel" style={{ width: 90, height: 22, borderRadius: 12 }} />
        <span className="ad-skel" style={{ width: 120, height: 22, borderRadius: 12 }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="ad-skel" style={{ width: '40%', height: 10 }} />
            <span className="ad-skel" style={{ width: '75%' }} />
          </div>
        ))}
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <span key={i} className="ad-skel" style={{ width: '100%', height: 40, borderRadius: 8 }} />
      ))}
    </div>
  )
}

// Builds the initial "needs revision" flags from a supplier's documents.
const initFlagsFrom = (data) => {
  const initial = {}
  ;(data?.documents || []).forEach(d => {
    if (d.review_status === 'needs_revision') initial[d.key] = { checked: true, note: d.review_note || '' }
  })
  return initial
}

function SupplierDetailModal({ supplierId, onClose, onReviewed }) {
  const cached = supplierDetailCache.get(supplierId)
  const [supplier, setSupplier] = useState(cached || null)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState('')
  // Seed the editable fields from cache so a reopened modal is fully populated.
  const [flags, setFlags] = useState(() => initFlagsFrom(cached))   // { key: { checked, note } }
  const [note, setNote] = useState(cached?.admin_notes || '')        // overall message
  const [confirm, setConfirm] = useState(null) // { title, message, tone, onConfirm }
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const hadCache = supplierDetailCache.has(supplierId)
    if (!hadCache) setLoading(true)
    apiGetSupplier(supplierId)
      .then(data => {
        supplierDetailCache.set(supplierId, data)
        setSupplier(data)
        // Only seed the editable fields on the first load — don't overwrite the
        // admin's in-progress edits when a background refresh resolves.
        if (!hadCache) {
          setNote(data.admin_notes || '')
          setFlags(initFlagsFrom(data))
        }
      })
      // A failed background refresh keeps the cached profile on screen.
      .catch(err => { if (!supplierDetailCache.has(supplierId)) setError(err.message) })
      .finally(() => setLoading(false))
  }, [supplierId])

  const toggleFlag = (key) =>
    setFlags(f => ({ ...f, [key]: { checked: !f[key]?.checked, note: f[key]?.note || '' } }))
  const setFlagNote = (key, val) =>
    setFlags(f => ({ ...f, [key]: { checked: f[key]?.checked ?? true, note: val } }))

  const flaggedDocs = () => {
    const out = {}
    Object.entries(flags).forEach(([k, v]) => { if (v.checked) out[k] = v.note || '' })
    return out
  }

  const runAction = async (fn, successMsg) => {
    setBusy(true)
    try {
      await fn()
      // The action changed this supplier — drop the stale detail cache so a
      // reopen reloads fresh (the list refresh is handled by onReviewed).
      supplierDetailCache.delete(supplierId)
      onReviewed(successMsg)
      onClose()
    } catch (err) {
      setError(err.message)
      setConfirm(null)
    } finally {
      setBusy(false)
    }
  }

  const handleApprove = () => setConfirm({
    title: 'Approve supplier?',
    message: `${supplier.company} will be marked Verified and allowed to submit bids.`,
    tone: 'green',
    confirmLabel: 'Approve',
    onConfirm: () => runAction(() => apiSupplierApprove(supplierId), 'Supplier approved.'),
  })

  const handleRequestRevision = () => {
    const docs = flaggedDocs()
    if (Object.keys(docs).length === 0) {
      setError('Flag at least one document for revision (check the box next to it).')
      return
    }
    setConfirm({
      title: 'Request revision?',
      message: `The supplier will be notified to re-upload ${Object.keys(docs).length} document(s). They cannot bid until re-approved.`,
      tone: 'orange',
      confirmLabel: 'Send Revision Request',
      onConfirm: () => runAction(
        () => apiSupplierRequestRevision(supplierId, { note, documents: docs }),
        'Revision request sent to supplier.'
      ),
    })
  }

  const handleReject = () => setConfirm({
    title: 'Reject supplier?',
    message: `${supplier.company} will be marked Rejected. Add a reason below so they understand why.`,
    tone: 'red',
    confirmLabel: 'Reject',
    onConfirm: () => runAction(() => apiSupplierReject(supplierId, note), 'Supplier rejected.'),
  })

  // Once a supplier has been approved (or rejected), the modal becomes a
  // read-only profile view — no checkboxes, no decision footer.
  const decided = supplier?.qualification_status === 'verified' || supplier?.qualification_status === 'rejected'

  return (
    <div className="ad-modal-overlay" onClick={onClose}>
      <div className="ad-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-header">
          <div>
            {loading
              ? <span className="ad-skel" style={{ width: 180, height: 18 }} />
              : <h3>{supplier?.company}</h3>}
            {!loading && supplier && (
              <p className="ad-muted ad-small">{supplier.full_name || supplier.contact} · {supplier.email}</p>
            )}
          </div>
          <button className="ad-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {loading ? (
          <div className="ad-modal-body"><SupplierDetailSkeleton /></div>
        ) : !supplier ? (
          <div className="ad-modal-body" style={{ padding: 40, textAlign: 'center' }}>{error || 'Could not load supplier.'}</div>
        ) : (
          <>
            <div className="ad-modal-body">
              {error && <div className="ad-modal-error"><AlertTriangle size={15} /> {error}</div>}
              {!decided && !supplier.email_verified && (
                <div className="ad-modal-error" role="status">
                  <AlertTriangle size={15} /> Email not verified yet — this supplier can't be approved
                  until they open the verification link sent to {supplier.email}.
                </div>
              )}

              <div className="ad-modal-badges">
                <StatusBadge domain="supplier" status={supplier.status} />
                <StatusBadge domain="qualification" status={supplier.qualification_status} />
                <StatusBadge domain="email" status={!!supplier.email_verified} label={supplier.email_verified ? 'Email Verified' : 'Email Unverified'} />
              </div>

              <div className="ad-info-grid">
                <Info2 label="Representative" value={supplier.representative_name || supplier.contact} />
                <Info2 label="Email" value={supplier.email} />
                <Info2 label="Phone" value={supplier.phone_number} />
                <Info2 label="TIN" value={supplier.tin} />
                <Info2 label="Address" value={supplier.company_address} full />
                <BusinessTypesInfo supplier={supplier} />
                <Info2 label="Registered" value={supplier.registered} />
                <Info2 label="Financial Year" value={supplier.financial_statement_year} />
              </div>

              <CategoryRequestPanel
                supplier={supplier}
                busy={busy}
                onApprove={() => setConfirm({
                  title: 'Approve category change?',
                  message: `${supplier.company} will be able to see and bid on procurements in the requested categories.`,
                  tone: 'green',
                  confirmLabel: 'Approve change',
                  onConfirm: () => runAction(() => apiSupplierApproveCategories(supplierId), 'Category change approved.'),
                })}
                onReject={(reason) => setConfirm({
                  title: 'Decline category change?',
                  message: `${supplier.company} keeps their current categories.`,
                  tone: 'red',
                  confirmLabel: 'Decline change',
                  onConfirm: () => runAction(() => apiSupplierRejectCategories(supplierId, reason), 'Category change declined.'),
                })}
              />

              <div className="ad-docs-head">
                <FileText size={15} /> Uploaded Documents
              </div>
              {!decided && (
                <div className="ad-docs-hint">
                  <Info size={15} />
                  <span>
                    <strong>Tick the checkbox</strong> next to any document that has a problem to flag it for revision,
                    then click <strong>Request Revision</strong> to send it back to the supplier.
                  </span>
                </div>
              )}
              <div className="ad-docs-list">
                {supplier.documents.map(d => {
                  const checked = !!flags[d.key]?.checked
                  const rs = d.review_status
                  const rowCls = checked ? ' flagged' : rs === 'resubmitted' ? ' resubmitted' : ''
                  return (
                    <div className={`ad-doc-row${rowCls}`} key={d.key}>
                      <div className="ad-doc-main">
                        {!decided && (
                          <label className="ad-doc-check">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!d.url}
                              onChange={() => toggleFlag(d.key)}
                            />
                          </label>
                        )}
                        <div className="ad-doc-name">
                          <span className="ad-bold">{d.label}</span>
                          <span className={d.required ? 'ad-req-tag' : 'ad-opt-tag'}>{d.required ? 'Required' : 'Optional'}</span>
                          {/* Review state at a glance — the admin can still re-check any doc to double-check it. */}
                          {checked
                            ? <span className="ad-doc-status ad-doc-flag">Flagged for revision</span>
                            : rs === 'resubmitted'
                              ? <span className="ad-doc-status ad-doc-resub">Resubmitted — please review</span>
                              : rs === 'approved'
                                ? <span className="ad-doc-status ad-doc-ok"><Check size={11} /> Reviewed</span>
                                : null}
                        </div>
                        {d.url
                          ? <a className="ad-doc-view" href={d.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> View</a>
                          : <span className="ad-doc-missing">Not uploaded</span>}
                      </div>
                      {/* Remind the admin why this doc was sent back, now that it's been re-uploaded. */}
                      {!checked && rs === 'resubmitted' && d.review_note && (
                        <div className="ad-doc-prevnote">Previously flagged: “{d.review_note}”</div>
                      )}
                      {checked && (
                        <input
                          className="ad-doc-note"
                          placeholder="What needs fixing? (e.g. blurry scan, expired)"
                          value={flags[d.key]?.note || ''}
                          onChange={e => setFlagNote(d.key, e.target.value)}
                        />
                      )}
                    </div>
                  )
                })}
              </div>

              {decided ? (
                supplier.admin_notes ? (
                  <div className="ad-field">
                    <label>Message to supplier</label>
                    <p className="ad-muted ad-small" style={{ margin: 0 }}>{supplier.admin_notes}</p>
                  </div>
                ) : null
              ) : (
                <div className="ad-field">
                  <label>Message to supplier (overall note)</label>
                  <textarea
                    rows={2}
                    placeholder="Optional message shown to the supplier with your decision…"
                    value={note}
                    onChange={e => setNote(e.target.value)}
                  />
                </div>
              )}
            </div>

            <div className="ad-modal-footer">
              <button className="ad-btn-cancel" onClick={onClose}>Close</button>
              {!decided && (
                <div className="ad-modal-footer-actions">
                  <button className="ad-btn-reject" disabled={busy} onClick={handleReject}>
                    <XCircle size={14} /> {busy ? 'Working…' : 'Reject'}
                  </button>
                  <button className="ad-btn-revision" disabled={busy} onClick={handleRequestRevision}>
                    <AlertTriangle size={14} /> {busy ? 'Working…' : 'Request Revision'}
                  </button>
                  {/* The server refuses this too (SupplierViewSet.approve); the
                      disabled state just explains why before the Admin tries. */}
                  <button
                    className="ad-btn-approve"
                    disabled={busy || !supplier.email_verified}
                    title={supplier.email_verified ? undefined : 'The supplier must verify their email address before approval.'}
                    onClick={handleApprove}
                  >
                    <Check size={14} /> {busy ? 'Working…' : 'Approve'}
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {confirm && (
          <ConfirmDialog
            {...confirm}
            busy={busy}
            onCancel={() => setConfirm(null)}
          />
        )}
      </div>
    </div>
  )
}

function Info2({ label, value, full }) {
  return (
    <div className={`ad-info-item${full ? ' ad-info-full' : ''}`}>
      <span className="ad-info-label">{label}</span>
      <span className="ad-info-value">{value || '—'}</span>
    </div>
  )
}

// Normalize a supplier's business types into a list (the JSON list is the source
// of truth; fall back to splitting the legacy comma-joined string).
function supplierBusinessTypes(supplier) {
  if (Array.isArray(supplier?.business_types) && supplier.business_types.length) {
    return supplier.business_types
  }
  return (supplier?.business_type || '')
    .split(',').map(s => s.trim()).filter(Boolean)
}

// Shows every category the supplier is APPROVED for as chips (handles many).
function BusinessTypesInfo({ supplier }) {
  const types = supplierBusinessTypes(supplier)
  return (
    <div className="ad-info-item ad-info-full">
      <span className="ad-info-label">Business Types{supplier?.category_request_status === 'pending' ? ' (approved)' : ''}</span>
      {types.length === 0 ? (
        <span className="ad-info-value">—</span>
      ) : (
        <div className="ad-chips">
          {types.map(t => <span className="ad-chip" key={t}>{t}</span>)}
        </div>
      )}
    </div>
  )
}

// A verified supplier's pending category change: only an Admin decision here
// changes which procurements they can bid on (enforced server-side by
// approve-categories / reject-categories). Rendered whether or not the
// supplier's registration has already been decided — category requests come
// from VERIFIED suppliers.
function CategoryRequestPanel({ supplier, busy, onApprove, onReject }) {
  const [reason, setReason] = useState('')
  if (supplier?.category_request_status !== 'pending') return null
  const approved = supplierBusinessTypes(supplier)
  const requested = supplier.pending_business_types || []
  const added = requested.filter(c => !approved.includes(c))
  const removed = approved.filter(c => !requested.includes(c))
  return (
    <div className="ad-field">
      <label>Category change request</label>
      <div className="ad-docs-hint">
        <Info size={15} />
        <span>
          Requested {supplier.category_requested_at ? new Date(supplier.category_requested_at).toLocaleDateString() : ''}.
          {' '}They keep bidding only in their approved categories until you decide.
        </span>
      </div>
      {added.length > 0 && (
        <div className="ad-chips" aria-label="Categories to add">
          {added.map(t => <span className="ad-chip" key={`add-${t}`}>+ {t}</span>)}
        </div>
      )}
      {removed.length > 0 && (
        <div className="ad-chips" aria-label="Categories to remove">
          {removed.map(t => <span className="ad-chip" key={`rm-${t}`}>− {t}</span>)}
        </div>
      )}
      <textarea
        rows={2}
        placeholder="Reason (shown to the supplier if you decline)…"
        value={reason}
        onChange={e => setReason(e.target.value)}
      />
      <div className="ad-modal-footer-actions">
        <button className="ad-btn-reject" disabled={busy} onClick={() => onReject(reason)}>
          <XCircle size={14} /> Decline change
        </button>
        <button className="ad-btn-approve" disabled={busy} onClick={onApprove}>
          <Check size={14} /> Approve change
        </button>
      </div>
    </div>
  )
}

// ── Confirmation dialog ───────────────────────────────────────────────────────

function ConfirmDialog({ title, message, tone = 'green', confirmLabel = 'Confirm', busy, onConfirm, onCancel }) {
  return (
    <div className="ad-confirm-overlay" onClick={onCancel}>
      <div className="ad-confirm" onClick={e => e.stopPropagation()}>
        <div className={`ad-confirm-icon ad-confirm-${tone}`}>
          {tone === 'green' ? <CheckCircle2 size={22} /> : tone === 'red' ? <XCircle size={22} /> : <AlertTriangle size={22} />}
        </div>
        <h4>{title}</h4>
        <p>{message}</p>
        <div className="ad-confirm-actions">
          <button className="ad-btn-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={`ad-btn-confirm ad-confirm-${tone}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ type, message, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000)
    return () => clearTimeout(t)
  }, [onClose])
  return (
    <div className={`ad-toast ad-toast-${type}`} role="status">
      {type === 'success' ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
      <span>{message}</span>
      <button onClick={onClose} aria-label="Dismiss"><X size={15} /></button>
    </div>
  )
}

// ── Bids Page ─────────────────────────────────────────────────────────────────

// Status groups for the evaluation list. "Active" hides finished (awarded/closed)
// projects so the ones still needing a decision are front and centre.
const BID_STATUS_FILTERS = {
  active:  { label: 'Active (needs review)', test: p => ['approved', 'published', 'active'].includes(p.status) },
  awarded: { label: 'Awarded',              test: p => p.status === 'awarded' },
  all:     { label: 'All statuses',         test: () => true },
}
const BID_SORTS = {
  bids_desc: { label: 'Most bids',        cmp: (a, b) => b.bids - a.bids },
  deadline:  { label: 'Deadline soonest', cmp: (a, b) => bidDeadlineVal(a) - bidDeadlineVal(b) },
  name:      { label: 'Name (A–Z)',       cmp: (a, b) => a.name.localeCompare(b.name) },
}
// Sort projects with no/invalid deadline to the end.
function bidDeadlineVal(p) {
  const t = new Date(p.deadline).getTime()
  return Number.isNaN(t) ? Infinity : t
}

function BidsPage() {
  const { projects, loading } = useProjects()
  const navigate = useNavigate()
  const [filterTab, setFilterTab] = useState('All')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('active')
  const [sort, setSort] = useState('bids_desc')
  const TABS = ['All', 'Goods', 'Services', 'Infrastructure', 'More']

  // Only Head-approved projects can receive/evaluate bids — not drafts, items
  // still awaiting approval, or rejected ones (those stay in Planning).
  const biddable = projects.filter(p => !['draft', 'pending_head', 'needs_revision', 'rejected'].includes(p.status))

  const matchesType = (p) => {
    if (filterTab === 'Services')       return p.type.includes('Services')
    if (filterTab === 'Goods')          return p.type.includes('Equipment') || p.type.includes('Goods')
    if (filterTab === 'Infrastructure') return p.type.includes('Infrastructure')
    return true  // 'All' and 'More'
  }

  const q = search.trim().toLowerCase()
  const filtered = biddable
    .filter(p =>
      matchesType(p) &&
      BID_STATUS_FILTERS[statusFilter].test(p) &&
      (!q || p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q))
    )
    .sort(BID_SORTS[sort].cmp)

  return (
    <div className="ad-content">
      <PageHeader
        title="Select a Project to Evaluate"
        description="Click a project below to review and evaluate submitted bids."
      />

      <div className="ad-card ad-bids-toolbar-card">
        <div className="ad-bids-toolbar">
          <label className="ad-search-inline">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">Search projects</span>
            <input
              placeholder="Search by project name or code"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </label>
          <div className="ad-filter-pills ad-filter-pills-inline" role="tablist" aria-label="Filter by type">
            {TABS.map(t => (
              <button key={t} role="tab" aria-selected={filterTab === t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
            ))}
          </div>
          <div className="ad-bids-toolbar-right">
            <label className="ad-select-wrap">
              <span>Status</span>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                {Object.entries(BID_STATUS_FILTERS).map(([key, { label }]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </label>
            <label className="ad-select-wrap">
              <span>Sort</span>
              <select value={sort} onChange={e => setSort(e.target.value)}>
                {Object.entries(BID_SORTS).map(([key, { label }]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>

      {!loading && (
        <div className="ad-bids-count" aria-live="polite">
          Showing {filtered.length} of {biddable.length} project{biddable.length !== 1 ? 's' : ''}
        </div>
      )}

      <div className="ad-bid-cards">
        {loading && filtered.length === 0
          ? Array.from({ length: 3 }).map((_, i) => (
              <div className="ad-bid-card" key={i}>
                <Skeleton width={40} height={40} radius={10} />
                <Skeleton width="70%" height={16} style={{ marginTop: 14 }} />
                <Skeleton width="40%" style={{ marginTop: 10 }} />
                <Skeleton width="100%" height={36} radius={8} style={{ marginTop: 14 }} />
              </div>
            ))
          : filtered.length === 0
          ? <div className="ad-card ad-bid-cards-empty">
              <EmptyState
                icon={biddable.length === 0 ? FolderOpen : Search}
                title={biddable.length === 0 ? 'No projects available for bidding yet' : 'No projects match your search or filters'}
                description={biddable.length === 0
                  ? 'Projects appear here once the Head approves them and you publish them for bidding.'
                  : 'Try a different search term, type, or status filter.'}
                action={biddable.length === 0 && (
                  <Link to="/admin/projects" className="ad-btn-cancel">Go to Projects</Link>
                )}
              />
            </div>
          : filtered.map(p => (
            <div
              className="ad-bid-card"
              key={p.id}
              onClick={() => navigate(`/admin/bids/${p.id}`)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/admin/bids/${p.id}`) } }}
              role="button"
              tabIndex={0}
              aria-label={`Evaluate bids for ${p.name}`}
            >
              <div className="ad-bid-card-top">
                <div className="ad-bid-card-icon" aria-hidden="true"><FolderOpen size={18} /></div>
                <StatusBadge domain="project" status={p.status} />
              </div>
              <div className="ad-bid-card-name">{p.name}</div>
              <div className="ad-ref-line"><RefCode code={p.code} /></div>
              <dl className="ad-bid-card-meta">
                <div><dt>Budget (ABC)</dt><dd className="ad-bid-card-budget">{p.budget}</dd></div>
                <div><dt>Type</dt><dd>{p.type}</dd></div>
                {p.category && <div className="ad-bid-card-meta-full"><dt>Category</dt><dd>{p.category}</dd></div>}
              </dl>
              <div className="ad-bid-card-footer">
                <span className="ad-bid-card-count">
                  <FileText size={13} aria-hidden="true" /> {p.bids} bid{p.bids !== 1 ? 's' : ''}
                </span>
                <span className="ad-bid-card-cta">Evaluate <ChevronRight size={14} className="ad-bid-card-arrow" aria-hidden="true" /></span>
              </div>
            </div>
          ))
        }
      </div>
    </div>
  )
}

// Qualification status display for bids.
const QUAL_BID_LABEL = {
  under_review: 'Under Review', qualified: 'Qualified',
  disqualified: 'Disqualified', winner: 'Winner Selected',
}
const QUAL_BID_CLS = {
  under_review: 'badge-yellow', qualified: 'badge-green',
  disqualified: 'badge-red', winner: 'badge-awarded',
}

// Declaration fields in display order: [serializer key, badge label].
const BID_DECLARATIONS = [
  ['terms_accepted', 'Terms and Conditions Accepted'],
  ['interest_declared', 'Declaration of Interest Confirmed'],
  ['scm_declared', 'Past SCM Practices Declared'],
  ['accuracy_confirmed', 'Accuracy of Information Confirmed'],
  ['specification_confirmed', 'Specification Match Confirmed'],
]

// Flatten every uploaded file on a bid into { label, name, url } rows.
function collectBidFiles(b) {
  const base = (url) => (url ? decodeURIComponent(url.split('/').pop()) : '')
  const out = []
  if (b.quotation_document_url) out.push({ label: 'Quotation', name: base(b.quotation_document_url), url: b.quotation_document_url })
  if (b.technical_document_url) out.push({ label: 'Technical Proposal', name: base(b.technical_document_url), url: b.technical_document_url })
  if (b.supplier_product_image_url) out.push({ label: 'Product Image', name: base(b.supplier_product_image_url), url: b.supplier_product_image_url })
  if (b.supplier_datasheet_url) out.push({ label: 'Datasheet', name: base(b.supplier_datasheet_url), url: b.supplier_datasheet_url })
  if (b.supplier_compliance_doc_url) out.push({ label: 'Compliance', name: base(b.supplier_compliance_doc_url), url: b.supplier_compliance_doc_url })
  ;(b.attachments || []).forEach(a => out.push({ label: 'Other', name: a.file_name, url: a.url }))
  return out
}

const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const isImageFile = (name) => IMAGE_FILE_RE.test(name || '')

/**
 * The offered product at a glance: the supplier's own product photo plus brand
 * and model, shown inline in the bids table.
 *
 * Both are optional on a bid, so this degrades gracefully — a photo with no
 * brand, a brand with no photo, or neither. It exists so the Admin can compare
 * what is actually being offered across every bidder in one screen, instead of
 * opening each bid in turn and judging on price alone. Clicking opens the full
 * image; the row's own click handler still opens the bid.
 */
function BidProductCell({ bid }) {
  // Legacy single image first (older bids), else the first of the new gallery.
  const url = bid.supplier_product_image_url || bid.product_images?.[0]?.url
  const spec = [bid.brand_name, bid.model_number].filter(Boolean).join(' ')

  if (!url && !spec) return <span className="ad-muted ad-small">—</span>

  return (
    <div className="ad-prod-cell">
      {url ? (
        <a
          className="ad-prod-thumb"
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={e => e.stopPropagation()}
          title="Open the full product image"
        >
          <img src={url} alt={spec ? `${spec} offered by ${bid.supplier_name}` : `Product offered by ${bid.supplier_name}`} loading="lazy" />
        </a>
      ) : (
        <span className="ad-prod-thumb ad-prod-thumb-empty" title="No product image submitted">
          <ImageIcon size={14} />
        </span>
      )}
      {spec && <span className="ad-prod-spec" title={spec}>{spec}</span>}
    </div>
  )
}

const peso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH')
const fmtDate = (v) => v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const fmtDateTime = (v) => v ? new Date(v).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
}) : null

// Decision label shown per bidder in the merged Bids & Evaluation table.
const BID_DECISION_LABEL = {
  under_review: 'Pending Review', qualified: 'Qualified',
  disqualified: 'Disqualified', winner: 'Qualified',
}

// Builds the full procurement timeline (one entry per lifecycle milestone) from
// whatever timestamps the project/bids currently have — works for any project,
// at any stage, not just one hard-coded case. "Bids Received" and "Evaluation"
// are merged into a single per-supplier table (one row each) instead of two
// separate lists, so the same supplier name doesn't repeat and the modal stays
// readable no matter how many suppliers bid.
function buildProjectTimeline(project, bids) {
  const bySubmit = [...bids].sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at))
  const rejected = project.status === 'rejected'
  const winner = bids.find(b => b.status === 'winner')

  return [
    { key: 'created', label: 'Bid Created', at: project.created_at, status: 'done' },
    { key: 'submitted', label: 'Submitted for Approval', at: project.created_at, status: 'done' },
    rejected
      ? { key: 'reviewed', label: 'Rejected by Head', at: project.reviewed_at, status: 'rejected', note: project.reject_reason }
      : { key: 'reviewed', label: 'Approved by Head', at: project.reviewed_at, status: project.reviewed_at ? 'done' : 'pending' },
    { key: 'published', label: 'Bid Published', at: project.published_at, status: project.published_at ? 'done' : 'pending' },
    {
      key: 'bids', label: 'Bids & Evaluation', at: bySubmit[0]?.submitted_at || null,
      status: bySubmit.length ? 'done' : 'pending',
      table: bySubmit.map(b => ({
        supplier: b.supplier_name,
        submittedAt: b.submitted_at,
        decision: BID_DECISION_LABEL[b.status] || b.status,
        decisionAt: b.reviewed_at,
        decisionTone: b.status === 'disqualified' ? 'red' : (b.status === 'qualified' || b.status === 'winner') ? 'green' : 'gray',
      })),
    },
    {
      key: 'awarded',
      label: project.status === 'awarded' ? `Awarded to ${winner?.supplier_name || '—'}` : 'Awarded',
      at: project.awarded_at, status: project.status === 'awarded' ? 'done' : 'pending',
    },
  ]
}

// How many bidder rows to show before collapsing behind "Show all" — keeps the
// modal short whether one supplier bid or fifty did.
const BID_TABLE_PREVIEW_COUNT = 3

// One row of the merged Bids & Evaluation table: supplier, amount, submitted
// time, and the qualify/disqualify decision + its time (if decided yet).
function BidTimelineRow({ row }) {
  return (
    <div className="ad-timeline-bidrow">
      <div className="ad-timeline-bidrow-main">
        <span className="ad-bold">{row.supplier}</span>
      </div>
      <div className="ad-timeline-bidrow-meta">
        <span className="ad-muted ad-small">Submitted {fmtDateTime(row.submittedAt)}</span>
        <StatusBadge
          tone={row.decisionTone === 'gray' ? 'neutral' : row.decisionTone === 'red' ? 'danger' : 'success'}
          label={`${row.decision}${row.decisionAt ? ` · ${fmtDateTime(row.decisionAt)}` : ''}`}
        />
      </div>
    </div>
  )
}

// Modal showing the full timestamped lifecycle of a procurement — when it was
// created, approved, published, every bid received + its evaluation decision,
// and the award. Built from live project/bid data, so it's the same component
// for every procurement, not specific to any one of them.
function TimelineModal({ project, bids, onClose }) {
  const groups = buildProjectTimeline(project, bids)
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="ad-modal-overlay" onClick={onClose}>
      <div className="ad-modal ad-timeline-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-header">
          <div>
            <h3>Procurement Timeline</h3>
            <div className="ad-ref-line">
              <RefCode code={project.code} />
              <span className="ad-muted ad-small">{project.name}</span>
            </div>
          </div>
          <button className="ad-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="ad-modal-body">
          <div className="ad-timeline">
            {groups.map(g => {
              const rows = g.table && !expanded ? g.table.slice(0, BID_TABLE_PREVIEW_COUNT) : g.table
              return (
                <div className={`ad-timeline-row ad-timeline-${g.status}`} key={g.key}>
                  <div className="ad-timeline-dot" />
                  <div className="ad-timeline-content">
                    <div className="ad-timeline-label">
                      {g.label}{g.table && g.table.length > 0 && <span className="ad-timeline-count"> ({g.table.length})</span>}
                    </div>
                    <div className="ad-timeline-time">{fmtDateTime(g.at) || 'Not reached yet'}</div>
                    {g.note && <div className="ad-timeline-note">Reason: {g.note}</div>}
                    {rows && rows.length > 0 && (
                      <div className="ad-timeline-bidtable">
                        {rows.map((row, i) => <BidTimelineRow row={row} key={i} />)}
                        {g.table.length > BID_TABLE_PREVIEW_COUNT && (
                          <button className="ad-timeline-showmore" onClick={() => setExpanded(e => !e)}>
                            {expanded ? 'Show less' : `Show all ${g.table.length} bids`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <div className="ad-modal-footer">
          <button className="ad-btn-cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// Enlarged view of one product image, inside the bid modal. Esc, the close
// button, or a click on the backdrop closes it; arrows step through the set.
function ImageLightbox({ images, index, onIndex, onClose }) {
  const img = images[index]
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1)
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, images.length, onIndex, onClose])
  if (!img) return null
  return (
    <div className="ad-lightbox" role="dialog" aria-modal="true" aria-label="Product image" onClick={onClose}>
      <div className="ad-lightbox-inner" onClick={e => e.stopPropagation()}>
        <button className="ad-lightbox-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <img src={img.url} alt={img.caption || `Product image ${index + 1}`} />
        <div className="ad-lightbox-bar">
          <button disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Previous image">‹</button>
          <span>
            {img.caption || <span className="ad-muted">No caption</span>}
            <span className="ad-muted ad-small"> · {index + 1} / {images.length}</span>
          </span>
          <button disabled={index === images.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next image">›</button>
        </div>
        <a className="ad-lightbox-open" href={img.url} target="_blank" rel="noreferrer">
          <ExternalLink size={12} /> Open original
        </a>
      </div>
    </div>
  )
}

// Supplier's product photos on a bid — thumbnail gallery, click to enlarge.
function BidProductGallery({ bid }) {
  const images = bid.product_images || []
  const [open, setOpen] = useState(null)
  if (images.length === 0) {
    return bid.project_requires_product_images
      ? <p className="ad-muted ad-small">No product images on this bid.</p>
      : null
  }
  return (
    <>
      <div className="ad-img-grid">
        {images.map((img, i) => (
          <button type="button" key={img.id} className="ad-img-card ad-img-card-btn" onClick={() => setOpen(i)}
            title={img.caption || 'View larger'}>
            <img src={img.url} alt={img.caption || `Product image ${i + 1}`} loading="lazy" />
            <span className="ad-img-cap">{img.caption || `Image ${i + 1}`}</span>
          </button>
        ))}
      </div>
      {open !== null && (
        <ImageLightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
    </>
  )
}

// Full bid detail modal (admin evaluation) — opened by clicking a supplier's row.
// Shows every field, with images previewed inline so the admin doesn't have to
// download each one to check it.
function BidDetailModal({ bid, awarded, busyId, projectName, onQualify, onDisqualify, onMarkWinner, onRequestRevision, confirm, onConfirmWinner, onCancelConfirm, onClose }) {
  const files = collectBidFiles(bid)
  const images = files.filter(f => isImageFile(f.name))
  const docs = files.filter(f => !isImageFile(f.name))

  // Per-document review flags — same { key: { checked, note } } shape and
  // initFlagsFrom() helper the Supplier document review modal uses.
  const [flags, setFlags] = useState(() => initFlagsFrom(bid))
  const toggleFlag = (key) =>
    setFlags(f => ({ ...f, [key]: { checked: !f[key]?.checked, note: f[key]?.note || '' } }))
  const setFlagNote = (key, val) =>
    setFlags(f => ({ ...f, [key]: { checked: f[key]?.checked ?? true, note: val } }))
  const flaggedDocs = () => {
    const out = {}
    Object.entries(flags).forEach(([k, v]) => { if (v.checked) out[k] = v.note || '' })
    return out
  }
  const hasFlaggedDocs = (bid.documents || []).some(d => d.review_status === 'needs_revision')
  const canDecide = bid.status !== 'winner' && !awarded

  return (
    <div className="ad-modal-overlay" onClick={onClose}>
      <div className="ad-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-header">
          <div>
            <h3>{bid.supplier_name}</h3>
            <p className="ad-muted ad-small">{peso(bid.amount)} · Submitted {fmtDate(bid.submitted_at)}</p>
          </div>
          <button className="ad-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="ad-modal-body">
          <div className="ad-modal-badges">
            {bid.status === 'winner'
              ? <StatusBadge tone="success" icon={Award} label="Winning Bidder" />
              : <StatusBadge domain="bid" status={bid.status} />}
            <BlockchainBadge anchors={bid.anchors} />
          </div>

          <div className="ad-info-grid">
            <Info2 label="Delivery Timeline" value={bid.delivery_timeline} />
            {bid.brand_name && <Info2 label="Brand Name" value={bid.brand_name} />}
            {bid.model_number && <Info2 label="Model Number" value={bid.model_number} />}
            {bid.warranty_period && <Info2 label="Warranty Period" value={bid.warranty_period} />}
            {bid.additional_comments && <Info2 label="Additional Comments" value={bid.additional_comments} full />}
          </div>

          {((bid.product_images || []).length > 0 || bid.project_requires_product_images) && (
            <div className="ad-bid-details-sec">
              <div className="ad-bid-details-title">
                <ImageIcon size={13} /> Product Images
                {bid.project_requires_product_images && <span className="ad-req-tag" style={{ marginLeft: 6 }}>Required</span>}
              </div>
              <BidProductGallery bid={bid} />
            </div>
          )}

          {images.length > 0 && (
            <div className="ad-bid-details-sec">
              <div className="ad-bid-details-title"><ImageIcon size={13} /> Submitted Images</div>
              <div className="ad-img-grid">
                {images.map((f, i) => (
                  <a key={i} className="ad-img-card" href={f.url} target="_blank" rel="noreferrer" title={f.name}>
                    <img src={f.url} alt={f.name} loading="lazy" />
                    <span className="ad-img-cap">{f.label}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="ad-bid-details-sec">
            <div className="ad-bid-details-title">Submitted Documents</div>
            {docs.length === 0 ? (
              <p className="ad-muted ad-small">No additional documents submitted.</p>
            ) : (
              <div className="ad-doc-list">
                {docs.map((f, i) => (
                  <a key={i} className="ad-doc-link-row" href={f.url} target="_blank" rel="noreferrer">
                    <span className="ad-doc-check"><Check size={12} /></span>
                    <span className="ad-doc-name" title={f.name}>{f.name}</span>
                    <span className="ad-doc-tag-mini">{f.label}</span>
                    <span className="ad-doc-view"><ExternalLink size={12} /> View</span>
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* This bid's own on-chain record: submission and evaluation result,
              each bound to the quotation document that was on file at the time. */}
          <div className="ad-bid-details-sec">
            <BlockchainTrail
              anchors={bid.anchors}
              title="Blockchain Record for this Bid"
              entityRef={bid.project_code}
            />
          </div>

          <div className="ad-bid-details-sec">
            <div className="ad-bid-details-title">Document Review</div>
            {canDecide && (
              <div className="ad-docs-hint">
                <Info size={15} />
                <span>
                  <strong>Tick the checkbox</strong> next to a document with a problem and add a note, then click
                  <strong> Request Revision</strong>. The bid stays in this bidding — the supplier just re-uploads
                  the flagged file.
                </span>
              </div>
            )}
            <div className="ad-docs-list">
              {(bid.documents || []).map(d => {
                const checked = !!flags[d.key]?.checked
                const rs = d.review_status
                const rowCls = checked ? ' flagged' : rs === 'resubmitted' ? ' resubmitted' : ''
                return (
                  <div className={`ad-doc-row${rowCls}`} key={d.key}>
                    <div className="ad-doc-main">
                      {canDecide && (
                        <label className="ad-doc-check">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!d.url}
                            onChange={() => toggleFlag(d.key)}
                          />
                        </label>
                      )}
                      <div className="ad-doc-name">
                        <span className="ad-bold">{d.label}{d.count ? ` (${d.count})` : ''}</span>
                        <span className={d.required ? 'ad-req-tag' : 'ad-opt-tag'}>{d.required ? 'Required' : 'Optional'}</span>
                        {checked
                          ? <span className="ad-doc-status ad-doc-flag">Flagged for revision</span>
                          : rs === 'resubmitted'
                            ? <span className="ad-doc-status ad-doc-resub">Resubmitted — please review</span>
                            : rs === 'approved'
                              ? <span className="ad-doc-status ad-doc-ok"><Check size={11} /> Reviewed</span>
                              : null}
                      </div>
                      {d.url
                        ? <a className="ad-doc-view" href={d.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> View</a>
                        : <span className="ad-doc-missing">Not uploaded</span>}
                    </div>
                    {!checked && rs === 'resubmitted' && d.review_note && (
                      <div className="ad-doc-prevnote">Previously flagged: “{d.review_note}”</div>
                    )}
                    {checked && (
                      <input
                        className="ad-doc-note"
                        placeholder="What needs fixing? (e.g. wrong file, illegible scan)"
                        value={flags[d.key]?.note || ''}
                        onChange={e => setFlagNote(d.key, e.target.value)}
                      />
                    )}
                  </div>
                )
              })}
            </div>
            {hasFlaggedDocs && (
              <p className="ad-muted ad-small" style={{ marginTop: 8 }}>
                This bid can't be selected as the winner until the flagged document(s) above are fixed.
              </p>
            )}
          </div>

          <div className="ad-bid-details-sec">
            <div className="ad-bid-details-title">Declarations</div>
            <div className="ad-decl-badges">
              {BID_DECLARATIONS.map(([key, label]) => (
                <div className={`ad-decl-badge${bid[key] ? '' : ' ad-decl-badge-no'}`} key={key}>
                  {bid[key] ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="ad-modal-footer">
          <button className="ad-btn-cancel" onClick={onClose}>Close</button>
          {canDecide && (
            <div className="ad-modal-footer-actions">
              <button
                className="ad-btn-revision"
                disabled={busyId === bid.id || Object.keys(flaggedDocs()).length === 0}
                onClick={() => onRequestRevision(bid, flaggedDocs())}
              >
                <AlertTriangle size={14} /> {busyId === bid.id ? 'Working…' : 'Request Revision'}
              </button>
              {bid.status !== 'qualified' && (
                <button className="ad-btn-approve" disabled={busyId === bid.id} onClick={() => onQualify(bid)}>
                  <Check size={14} /> {busyId === bid.id ? 'Working…' : 'Qualify'}
                </button>
              )}
              {bid.status !== 'disqualified' && (
                <button className="ad-btn-reject" disabled={busyId === bid.id} onClick={() => onDisqualify(bid)}>
                  <XCircle size={14} /> {busyId === bid.id ? 'Working…' : 'Disqualify'}
                </button>
              )}
              {bid.status === 'qualified' && !hasFlaggedDocs && (
                <button className="ad-btn-publish" disabled={busyId === bid.id} onClick={() => onMarkWinner(bid)}>
                  <Award size={14} /> {busyId === bid.id ? 'Working…' : 'Mark as Winner'}
                </button>
              )}
            </div>
          )}
        </div>

        {confirm && confirm.bid.id === bid.id && (
          <ConfirmDialog
            title="Select winning bidder?"
            message={`Award "${projectName}" to ${bid.supplier_name} for ${peso(bid.amount)}? This marks the procurement as Awarded and notifies the bidders.`}
            tone="green"
            confirmLabel="Confirm Winner"
            busy={busyId === bid.id}
            onConfirm={onConfirmWinner}
            onCancel={onCancelConfirm}
          />
        )}
      </div>
    </div>
  )
}

// ── Bid evaluation progress bar ───────────────────────────────────────────────
const EVAL_STEPS = [
  'Bid Created', 'Submitted for Approval', 'Approved by Head',
  'Bid Published', 'Bids Received', 'Evaluation', 'Awarded',
]
// Map the project's current status (+ bid activity) to the active step index.
function evalStepIndex(status, bids) {
  if (status === 'awarded') return 6
  if (status === 'published') {
    if (bids.some(b => b.status !== 'under_review')) return 5  // Evaluation
    if (bids.length > 0) return 4                              // Bids Received
    return 3                                                   // Bid Published
  }
  if (status === 'approved') return 2
  if (status === 'pending_head') return 1
  return 0  // draft
}

function EvalProgressBar({ status, bids }) {
  return (
    <div className="ad-eval-stepper">
      <Stepper steps={EVAL_STEPS} current={evalStepIndex(status, bids)} label="Procurement progress" />
    </div>
  )
}

// ── Bid evaluation detail page (admin) — /admin/bids/:id ───────────────────────
function BidEvaluationPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [project, setProject] = useState(null)
  const [bids, setBids] = useState([])
  // Loaded independently — the project header and the bids table are
  // unrelated requests, so one being slow shouldn't hold the other back.
  const [loadingProject, setLoadingProject] = useState(true)
  const [loadingBids, setLoadingBids] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [confirm, setConfirm] = useState(null)   // { bid }
  const [toast, setToast] = useState(null)
  const [viewBid, setViewBid] = useState(null)   // bid shown in the detail modal
  const [showTimeline, setShowTimeline] = useState(false)

  const loadProject = () => {
    setLoadingProject(true)
    apiGetProject(id)
      .then(setProject)
      .catch(() => setToast({ type: 'error', message: 'Could not load this procurement.' }))
      .finally(() => setLoadingProject(false))
  }
  const loadBidsList = () => {
    setLoadingBids(true)
    apiListProjectBids(id)
      .then(setBids)
      .catch(() => setToast({ type: 'error', message: 'Could not load the bids for this procurement.' }))
      .finally(() => setLoadingBids(false))
  }
  // Only used where both genuinely need to refresh together (selecting a
  // winner changes the project's own status, not just a bid's).
  const load = () => { loadProject(); loadBidsList() }
  useEffect(load, [id])

  // Keep the open detail modal in sync with the bid's latest status after an action.
  useEffect(() => {
    if (!viewBid) return
    const updated = bids.find(b => b.id === viewBid.id)
    if (updated && updated !== viewBid) setViewBid(updated)
  }, [bids])

  const awarded = project?.status === 'awarded'

  // Qualify/disqualify only change the bid's own status — refetch just the
  // bids table, not the project header too. The evaluation decision is anchored
  // afterwards (not awaited: the decision is already saved, and the on-chain
  // write is an optional witness that can be retried from the bid's trail).
  const act = async (bid, fn, errMsg, stageLabel) => {
    setBusyId(bid.id)
    try {
      const updated = await fn(bid.id)
      loadBidsList()
      if (updated?.anchor) {
        runAnchor(updated.anchor, { label: `${project?.code || ''} · ${stageLabel}` })
      }
    }
    catch (e) { setToast({ type: 'error', message: e.message || errMsg }) }
    finally { setBusyId(null) }
  }

  const requestRevision = async (bid, documents) => {
    setBusyId(bid.id)
    try {
      await apiBidRequestRevision(bid.id, { documents })
      loadBidsList()
      // Close the modal — its checkbox/note UI reflects local clicks, not the
      // server's confirmed state, so leaving it open after a successful submit
      // looks like nothing happened. Closing (then reopening, if needed) shows
      // the real "Flagged for revision" status fresh from the server.
      setViewBid(null)
      setToast({ type: 'success', message: 'Revision request sent to the supplier.' })
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Could not request revision.' })
    } finally {
      setBusyId(null)
    }
  }

  const confirmWinner = async () => {
    const bid = confirm.bid
    setBusyId(bid.id); setConfirm(null)
    try {
      const result = await apiSelectWinner(bid.id)
      await load()
      refreshProjects()  // the project is now Awarded — refresh the shared store
      setToast({ type: 'success', message: `${bid.supplier_name} selected as the winning bidder.` })
      // Final link in the chain: the award itself. Anchored as AWARD, so the
      // public trail ends with an unambiguous "this contract went to this bid".
      if (result?.anchor) {
        runAnchor(result.anchor, { label: `${project?.code || ''} · Contract awarded` })
      }
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Could not select winner.' })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="ad-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}

      <button className="ad-back-link" onClick={() => navigate('/admin/projects')}>
        <ArrowLeft size={14} /> Back to projects
      </button>

      {loadingProject && !project ? (
        <div className="ad-card" style={{ padding: '20px 24px' }}>
          <Skeleton width="40%" height={20} />
          <Skeleton width="60%" style={{ marginTop: 10 }} />
          <div style={{ display: 'flex', gap: 24, marginTop: 24 }}>
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, flex: 1 }}>
                <Skeleton width={30} height={30} radius={15} />
                <Skeleton width="80%" height={9} />
              </div>
            ))}
          </div>
        </div>
      ) : !project ? (
        <div className="ad-card">
          <EmptyState icon={Search} title="Procurement not found"
            description="It may have been removed, or the link is incorrect."
            action={<button className="ad-btn-cancel" onClick={() => navigate('/admin/projects')}><ArrowLeft size={14} /> Back to projects</button>} />
        </div>
      ) : (
        <>
          <div className="ad-card" style={{ padding: '20px 24px' }}>
            <div className="ad-eval-head-row">
              <div style={{ minWidth: 0 }}>
                <div className="ad-eval-title-row">
                  <h2 className="ad-eval-title">{project.name}</h2>
                  <StatusBadge domain="project" status={project.status} />
                </div>
                <div className="ad-ref-line" style={{ marginTop: 8 }}>
                  <RefCode code={project.code} size="lg" />
                  <span className="ad-muted ad-small">
                    {project.category || '—'} · ABC <strong className="ad-eval-abc">{peso(project.budget)}</strong>
                  </span>
                </div>
              </div>
              <div className="ad-eval-head-actions">
                <BlockchainBadge anchors={project.anchors} />
                <button className="ad-btn-timeline" onClick={() => setShowTimeline(true)}>
                  <Clock size={14} /> View Timeline
                </button>
              </div>
            </div>
            {project.reference_image_url && (
              <div className="ad-eval-refimg">
                <div className="ad-refimg-section-label"><ImageIcon size={14} /> Project Reference Image</div>
                <a href={project.reference_image_url} target="_blank" rel="noreferrer" title="Open full size">
                  <img src={project.reference_image_url} alt="Project reference" className="ad-refimg-thumb" />
                </a>
              </div>
            )}
            <EvalProgressBar status={project.status} bids={bids} />
          </div>

          <div className="ad-card">
            <div className="ad-card-header">
              <div>
                <h2>Submitted Bids</h2>
                <p className="ad-muted ad-small">Suppliers who submitted a bid for this procurement</p>
              </div>
              {awarded
                ? <StatusBadge domain="project" status="awarded" />
                : !loadingBids && bids.length > 0 && <StatusBadge tone="neutral" dot={false} label={`${bids.length} bid${bids.length !== 1 ? 's' : ''}`} />}
            </div>
            <div className="ad-x-scroll">
            <table className="ad-table">
              <thead>
                <tr><th>Product</th><th>Supplier</th><th className="ad-num">Bid Amount</th><th>Submitted</th><th>Qualification Status</th><th className="ad-actions-col">Actions</th></tr>
              </thead>
              <tbody>
                {loadingBids
                  ? <TableSkeleton rows={3} cols={6} />
                  : bids.length === 0
                  ? <TableEmpty colSpan={6} icon={FileText}
                      title="No bids submitted yet"
                      description={project.status === 'published'
                        ? 'Eligible suppliers can bid until the deadline. New bids will appear here automatically.'
                        : 'Bids open once this project is published.'} />
                  : bids.map(b => (
                    <tr key={b.id} className="ad-bid-row" onClick={() => setViewBid(b)}>
                      <td><BidProductCell bid={b} /></td>
                      <td className="ad-bold ad-bid-supplier-cell">{b.supplier_name}</td>
                      <td className="ad-num">{peso(b.amount)}</td>
                      <td className="ad-muted ad-nowrap">{fmtDate(b.submitted_at)}</td>
                      <td>
                        <div className="ad-badge-stack">
                          <StatusBadge domain="bid" status={b.status} />
                          {(b.documents || []).some(d => d.review_status === 'needs_revision') && (
                            <StatusBadge tone="warning" icon={AlertTriangle} label="Docs Flagged" />
                          )}
                        </div>
                      </td>
                      <td className="ad-actions-col" onClick={e => e.stopPropagation()}>
                        {b.status === 'winner' ? (
                          <StatusBadge tone="success" icon={Award} label="Winning Bidder" />
                        ) : awarded ? (
                          <span className="ad-muted ad-small">—</span>
                        ) : (
                          <button className="ad-btn-review" onClick={() => setViewBid(b)}>
                            <Eye size={13} /> Review
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
            </div>
          </div>

          {/* The whole procurement's on-chain trail: submission, Head decision,
              publication, every bid, and the award. Anything not yet anchored
              can be signed from here. */}
          <div className="ad-card" style={{ padding: 0, overflow: 'hidden' }}>
            <BlockchainTrail anchors={project.anchors} entityRef={project.code} />
          </div>
        </>
      )}

      {viewBid && (
        <BidDetailModal
          bid={viewBid}
          awarded={awarded}
          busyId={busyId}
          projectName={project.name}
          onQualify={(b) => act(b, apiQualifyBid, 'Could not qualify.', 'Bid qualified')}
          onDisqualify={(b) => act(b, apiDisqualifyBid, 'Could not disqualify.', 'Bid disqualified')}
          onMarkWinner={(b) => setConfirm({ bid: b })}
          onRequestRevision={requestRevision}
          confirm={confirm}
          onConfirmWinner={confirmWinner}
          onCancelConfirm={() => setConfirm(null)}
          onClose={() => { setViewBid(null); setConfirm(null) }}
        />
      )}

      {showTimeline && project && (
        <TimelineModal project={project} bids={bids} onClose={() => setShowTimeline(false)} />
      )}
    </div>
  )
}

// ── Awards Page ───────────────────────────────────────────────────────────────

// One post-award document cell: upload it if it hasn't been issued, or open it
// (with its blockchain state) once it has. Re-uploading is allowed and appends a
// NEW anchor rather than rewriting the old one, so a replacement is visible in
// the trail instead of silently overwriting history.
function AwardDocButton({ award, doc, busy, onUpload, onGenerate, onAnchor }) {
  const inputRef = useRef(null)
  const issued = !!doc.url
  const shortLabel = doc.label.replace(/ \(.*\)/, '')

  const pick = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''   // let the same file be re-picked after an error
    if (file) onUpload(award, doc, file)
  }

  const issuedOn = doc.issued_at ? fmtDate(doc.issued_at) : ''

  return (
    <div className={`ad-award-doc${issued ? ' is-issued' : ''}${issued && doc.anchored ? ' is-onchain' : ''}`}>
      {/* Must match validate_upload on the backend (PDF/JPG/PNG, 5 MB) — an
          accept list that offers more than the server takes just invites an
          error at the end of the upload. */}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png"
        style={{ display: 'none' }}
        onChange={pick}
        aria-hidden="true"
        tabIndex={-1}
      />
      {issued ? (
        <>
          <a className="ad-award-doc-name" href={doc.url} target="_blank" rel="noreferrer"
            title={`Issued ${issuedOn} — click to open`}>
            <FileText size={13} aria-hidden="true" /> <span>{shortLabel}</span>
          </a>
          {doc.anchored ? (
            <a
              className="ad-award-doc-chain is-anchored"
              href={doc.explorer_url}
              target="_blank"
              rel="noreferrer"
              title={`Anchored on-chain (tx ${doc.tx_hash})`}
              aria-label={`${shortLabel} is anchored on-chain — view transaction`}
            >
              <ShieldCheck size={11} /> On-chain
            </a>
          ) : (
            // The document is saved either way — this only completes the
            // optional on-chain step, re-signing the SAME hash. Declining
            // MetaMask earlier is never a dead end.
            <button
              className="ad-award-doc-chain is-retry"
              onClick={() => onAnchor(award, doc)}
              disabled={!doc.anchor}
              title={doc.anchor ? 'Record this document on the blockchain' : 'No anchor was recorded for this document'}
            >
              <Link2 size={11} /> {doc.anchor ? 'Anchor now' : 'Not anchored'}
            </button>
          )}
          {/* Replace the generated notice with the signed scan once it comes
              back. Appends a new anchor, so both versions stay in the trail. */}
          <button
            className="ui-icon-btn ad-award-doc-upload"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            data-tip="Replace with signed copy"
            aria-label={`Replace ${shortLabel} with the signed copy`}
          >
            {busy ? <Loader2 size={13} className="ui-spin" /> : <Upload size={13} />}
          </button>
        </>
      ) : (
        // Not issued yet: generate it from the award record (the normal path —
        // nothing to retype, and the notice can't disagree with the award), or
        // upload an already-signed copy.
        <>
          <span className="ad-award-doc-name is-missing">
            <FileText size={13} aria-hidden="true" /> <span>{shortLabel}</span>
          </span>
          <span className="ad-award-doc-chain is-pending">Pending</span>
          <button className="ad-award-doc-gen" disabled={busy} onClick={() => onGenerate(award, doc)}>
            {busy ? <><Loader2 size={12} className="ui-spin" /> Working…</> : <>Generate</>}
          </button>
          <button
            className="ui-icon-btn ad-award-doc-upload"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            data-tip="Upload a signed copy instead"
            aria-label={`Upload a signed copy of ${shortLabel}`}
          >
            <Upload size={13} />
          </button>
        </>
      )}
    </div>
  )
}

function AwardsPage() {
  const [awards, setAwards] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [busyDoc, setBusyDoc] = useState(null)   // `${awardId}:${key}` while uploading
  const [toast, setToast] = useState(null)

  const load = () => apiListAwards().then(setAwards).catch(() => {})

  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [])

  // Upload the signed document, then anchor it. The upload is what matters —
  // anchoring is the optional on-chain witness and is deliberately not awaited,
  // so a declined MetaMask prompt never looks like a failed upload.
  const issueDoc = async (award, doc, run, verb) => {
    setBusyDoc(`${award.id}:${doc.key}`)
    try {
      const updated = await run()
      setAwards(prev => prev.map(a => (a.id === updated.id ? updated : a)))
      setToast({ type: 'success', message: `${doc.label} issued for ${award.project_name}.` })
      if (updated.anchor) {
        runAnchor(updated.anchor, { label: `${updated.project_code} · ${doc.label}` })
      }
    } catch (e) {
      setToast({ type: 'error', message: e.message || `Could not ${verb} the ${doc.label}.` })
    } finally {
      setBusyDoc(null)
    }
  }

  // Built server-side from the award record, stored once, then hashed and
  // anchored. Every later download serves those same bytes, so the hash on the
  // blockchain stays reproducible.
  const generateDoc = (award, doc) =>
    issueDoc(award, doc, () => apiGenerateAwardDocument(award.id, doc.key), 'generate')

  // The signed scan, once the printed notice comes back.
  const uploadDoc = (award, doc, file) =>
    issueDoc(award, doc, () => apiUploadAwardDocument(award.id, doc.key, file), 'upload')

  // Complete the on-chain step for a document that was uploaded but never
  // anchored (MetaMask declined, no wallet at the time). It re-signs the hash
  // recorded at upload — the document itself is untouched — then refreshes so
  // the badge flips to "On-chain".
  const anchorDoc = async (award, doc) => {
    if (!doc.anchor) return
    const ok = await runAnchor(doc.anchor, { label: `${award.project_code} · ${doc.label}` })
    if (ok) load()
  }

  const filtered = awards.filter(a => {
    const q = search.toLowerCase()
    return !q || a.supplier_name.toLowerCase().includes(q) || a.project_name.toLowerCase().includes(q) ||
      (a.project_code || '').toLowerCase().includes(q)
  })

  const totalAmount = awards.reduce((sum, a) => sum + Number(a.amount || 0), 0)
  // Real count of issued documents — not awards × 3, which claimed documents
  // that had never been uploaded.
  const documentsIssued = awards.reduce(
    (sum, a) => sum + (a.documents || []).filter(d => d.url).length, 0)

  return (
    <div className="ad-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div className="ad-stats">
        {[
          { label: 'Total Awards', icon: Award, value: awards.length, sub: 'Contracts awarded' },
          { label: 'Total Awarded Amount', icon: BarChart2, value: peso(totalAmount), sub: 'Sum of winning bids' },
          {
            label: 'Documents Issued', icon: FileText,
            value: <>{documentsIssued}<span className="ad-stat-of">/{awards.length * 3}</span></>,
            sub: 'BAC Resolution · NOA · NTP',
          },
          { label: 'Latest Award Date', icon: Calendar, value: fmtDate(awards[0]?.awarded_at), sub: 'Most recent award', small: true },
        ].map(({ label, icon: Icon, value, sub, small }) => (
          <div className="ad-stat-card" key={label}>
            <div className="ad-stat-top">
              <span className="ad-stat-label">{label}</span>
              <div className="ad-stat-icon-wrap" aria-hidden="true"><Icon size={18} /></div>
            </div>
            <div className={`ad-stat-value${small ? ' ad-stat-value-sm' : ''}`}>
              {loading ? <Skeleton width={70} height={24} /> : value}
            </div>
            <div className="ad-stat-sub">{sub}</div>
          </div>
        ))}
      </div>

      <div className="ad-card">
        <div className="ad-card-header">
          <div>
            <h2>Awarded Contracts</h2>
            <p>Issue the post-award documents for each winning bid</p>
          </div>
          <label className="ad-search-inline">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">Search awards</span>
            <input
              placeholder="Search by supplier, project, or ref code"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </label>
        </div>
        <div className="ad-x-scroll">
        <table className="ad-table ad-awards-table">
          <thead>
            <tr>
              <th>Supplier</th><th>Project</th><th className="ad-num">Award Amount</th>
              <th>Award Date</th><th>Status</th><th>Documents</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <TableSkeleton rows={3} cols={6} />
            ) : filtered.length === 0 ? (
              <TableEmpty colSpan={6} icon={Award}
                title={search ? 'No awards match your search' : 'No awards yet'}
                description={search
                  ? 'Try a different supplier, project, or ref code.'
                  : 'Awards appear here after you mark a winning bid in Bid Evaluation.'}
                action={!search && <Link to="/admin/bids" className="ad-btn-cancel">Go to Bid Evaluation</Link>} />
            ) : filtered.map(a => (
              <tr key={a.id}>
                <td className="ad-bold">{a.supplier_name}</td>
                <td>
                  <div className="ad-cell-stack">
                    <span>{a.project_name}</span>
                    <RefCode code={a.project_code} />
                  </div>
                </td>
                <td className="ad-num">{peso(a.amount)}</td>
                <td className="ad-muted ad-nowrap">{fmtDate(a.awarded_at)}</td>
                <td><StatusBadge domain="award" status={a.status === 'won' ? 'won' : 'cancelled'} /></td>
                <td>
                  <div className="ad-doc-btns">
                    {(a.documents || []).map(d => (
                      <AwardDocButton
                        key={d.key}
                        award={a}
                        doc={d}
                        busy={busyDoc === `${a.id}:${d.key}`}
                        onUpload={uploadDoc}
                        onGenerate={generateDoc}
                        onAnchor={anchorDoc}
                      />
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <div className="ui-callout ad-award-callout">
        <Info size={18} className="ui-callout-icon" />
        <div>
          <div className="ui-callout-title">About Award Documents</div>
          <p style={{ marginBottom: 10 }}>
            Once a winning bid is selected, upload each signed document below. They are issued in this order:
          </p>
          <ol className="ad-award-steps">
            <li><span className="ad-award-step-n">1</span><div><strong>BAC Resolution</strong><span>Official resolution documenting the award decision</span></div></li>
            <li><span className="ad-award-step-n">2</span><div><strong>NOA</strong><span>Official notification to the winning supplier</span></div></li>
            <li><span className="ad-award-step-n">3</span><div><strong>NTP</strong><span>Authorization for the supplier to begin work</span></div></li>
          </ol>
          <p style={{ marginTop: 10 }}>
            Each upload is hashed together with its issue date and recorded on the blockchain, so a
            notice can never be swapped or backdated afterwards. Replacing a document adds a new
            entry to the trail rather than overwriting the original.
          </p>
          <p className="ad-muted ad-small" style={{ marginTop: 6 }}>
            Accepted formats: PDF, JPG or PNG, up to 5 MB. Scan or export the signed document.
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Reports Page ──────────────────────────────────────────────────────────────

function ReportsPage() {
  const { projects } = useProjects()
  const [awards, setAwards] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [reportTab, setReportTab] = useState('procurement')

  useEffect(() => {
    apiListAwards().then(setAwards).catch(() => {})
    apiListSuppliers().then(setSuppliers).catch(() => {})
  }, [])

  // ── Procurement report data ────────────────────────────────────────────
  const totalProjects  = projects.length
  const activePrj      = projects.filter(p => p.status === 'published' || p.status === 'active').length
  const awardedPrj     = projects.filter(p => p.status === 'awarded').length
  const totalBids       = projects.reduce((s, p) => s + p.bids, 0)
  const awardedAmount  = awards.reduce((sum, a) => sum + Number(a.amount || 0), 0)

  const typeCount = projects.reduce((acc, p) => {
    acc[p.type] = (acc[p.type] || 0) + 1
    return acc
  }, {})

  const procurementStats = [
    { label: 'TOTAL PROJECTS', value: totalProjects, cls: ''              },
    { label: 'ACTIVE',          value: activePrj,    cls: 'ad-val-blue'   },
    { label: 'AWARDED',         value: awardedPrj,   cls: 'ad-val-purple' },
    { label: 'TOTAL BIDS',      value: totalBids,    cls: 'ad-val-yellow' },
    { label: 'AWARDED AMOUNT',  value: peso(awardedAmount), cls: 'ad-val-green' },
  ]

  const procurementReportShape = {
    title: 'Procurement Report',
    stats: procurementStats.map(({ label, value }) => ({ label, value })),
    sections: [
      {
        heading: 'By Procurement Type',
        columns: ['Type', 'Count'],
        rows: Object.entries(typeCount).map(([type, count]) => [type, count]),
      },
      {
        heading: 'Recent Awards',
        columns: ['Project', 'Winner', 'Amount', 'Date'],
        rows: awards.map(a => [a.project_name, a.supplier_name, peso(a.amount), fmtDate(a.awarded_at)]),
      },
    ],
  }

  // ── Supplier report data ───────────────────────────────────────────────
  const totalSuppliers = suppliers.length
  const verifiedSup    = suppliers.filter(s => s.qualification_status === 'verified').length
  const pendingSup      = suppliers.filter(s =>
    s.qualification_status === 'waiting_admin_approval' || s.qualification_status === 'needs_revision').length
  const rejectedSup    = suppliers.filter(s => s.qualification_status === 'rejected').length

  const supplierAwardStats = suppliers.reduce((acc, s) => {
    const won = awards.filter(a => a.supplier === s.id)
    acc[s.id] = { count: won.length, amount: won.reduce((sum, a) => sum + Number(a.amount || 0), 0) }
    return acc
  }, {})
  const awardedSupCount = Object.values(supplierAwardStats).filter(v => v.count > 0).length

  const categoryCount = suppliers.reduce((acc, s) => {
    for (const cat of (s.business_types || [])) acc[cat] = (acc[cat] || 0) + 1
    return acc
  }, {})

  const supplierStats = [
    { label: 'TOTAL SUPPLIERS', value: totalSuppliers, cls: ''              },
    { label: 'VERIFIED',         value: verifiedSup,    cls: 'ad-val-green'  },
    { label: 'PENDING REVIEW',  value: pendingSup,     cls: 'ad-val-yellow' },
    { label: 'REJECTED',         value: rejectedSup,    cls: 'ad-val-red'    },
    { label: 'WITH AWARDS',     value: awardedSupCount, cls: 'ad-val-purple' },
  ]

  const supplierReportShape = {
    title: 'Supplier Report',
    stats: supplierStats.map(({ label, value }) => ({ label, value })),
    sections: [
      {
        heading: 'By Business Category',
        columns: ['Category', 'Suppliers'],
        rows: Object.entries(categoryCount).map(([cat, count]) => [cat, count]),
      },
      {
        heading: 'Supplier Directory',
        columns: ['Company', 'Qualification Status', 'Registered', 'Contracts Won', 'Awarded Amount'],
        rows: suppliers.map(s => [
          s.company,
          QUAL_LABEL[s.qualification_status] || s.qualification_status,
          fmtDate(s.registered),
          supplierAwardStats[s.id]?.count || 0,
          peso(supplierAwardStats[s.id]?.amount || 0),
        ]),
      },
    ],
  }

  const activeReport = reportTab === 'procurement' ? procurementReportShape : supplierReportShape

  return (
    <div className="ad-content">
      <div className="ad-report-bar">
        <div className="ad-report-tabs" role="tablist" aria-label="Report type">
          <button
            role="tab"
            aria-selected={reportTab === 'procurement'}
            className={`ad-report-tab${reportTab === 'procurement' ? ' active' : ''}`}
            onClick={() => setReportTab('procurement')}
          ><FolderOpen size={14} aria-hidden="true" /> Procurement Report</button>
          <button
            role="tab"
            aria-selected={reportTab === 'supplier'}
            className={`ad-report-tab${reportTab === 'supplier' ? ' active' : ''}`}
            onClick={() => setReportTab('supplier')}
          ><Users size={14} aria-hidden="true" /> Supplier Report</button>
        </div>
        <div className="ad-export-btns">
          <button
            className="ad-btn-export-csv"
            onClick={() => exportReportCSV(activeReport, `${reportTab}-report-${new Date().toISOString().slice(0, 10)}.csv`)}
          ><FileText size={14} aria-hidden="true" /> Export CSV</button>
          <button
            className="ad-btn-primary"
            onClick={() => exportReportPDF(activeReport, `${reportTab}-report-${new Date().toISOString().slice(0, 10)}.pdf`)}
          ><FileText size={14} aria-hidden="true" /> Export PDF</button>
        </div>
      </div>

      {reportTab === 'procurement' && (
        <>
          <div className="ad-report-stats">
            {procurementStats.map(({ label, value, cls }) => (
              <div className="ad-stat-card" key={label}>
                <div className="ad-stat-label">{label}</div>
                <div className="ad-stat-value ad-stat-value-sm">{value}</div>
              </div>
            ))}
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>By Procurement Type</h2></div>
            <table className="ad-table">
              <thead><tr><th>Type</th><th className="ad-num">Count</th></tr></thead>
              <tbody>
                {Object.keys(typeCount).length === 0 ? (
                  <TableEmpty colSpan={2} icon={BarChart2} title="No data yet" description="Numbers appear here as projects and suppliers are added." />
                ) : Object.entries(typeCount).map(([type, count]) => (
                  <tr key={type}><td>{type}</td><td className="ad-num">{count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>Recent Awards</h2></div>
            <table className="ad-table">
              <thead><tr><th>Project</th><th>Winner</th><th className="ad-num">Amount</th><th>Date</th></tr></thead>
              <tbody>
                {awards.length === 0 ? (
                  <TableEmpty colSpan={4} icon={Award} title="No awards yet" description="Awarded contracts will be summarised here." />
                ) : awards.map(a => (
                  <tr key={a.id}>
                    <td>{a.project_name}</td>
                    <td>{a.supplier_name}</td>
                    <td className="ad-num">{peso(a.amount)}</td>
                    <td className="ad-muted ad-nowrap">{fmtDate(a.awarded_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {reportTab === 'supplier' && (
        <>
          <div className="ad-report-stats">
            {supplierStats.map(({ label, value, cls }) => (
              <div className="ad-stat-card" key={label}>
                <div className="ad-stat-label">{label}</div>
                <div className="ad-stat-value ad-stat-value-sm">{value}</div>
              </div>
            ))}
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>By Business Category</h2></div>
            <table className="ad-table">
              <thead><tr><th>Category</th><th className="ad-num">Suppliers</th></tr></thead>
              <tbody>
                {Object.keys(categoryCount).length === 0 ? (
                  <TableEmpty colSpan={2} icon={BarChart2} title="No data yet" description="Numbers appear here as projects and suppliers are added." />
                ) : Object.entries(categoryCount).map(([cat, count]) => (
                  <tr key={cat}><td>{cat}</td><td className="ad-num">{count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>Supplier Directory</h2></div>
            <div className="ad-x-scroll">
            <table className="ad-table">
              <thead>
                <tr>
                  <th>Company</th><th>Qualification Status</th><th>Registered</th>
                  <th className="ad-num">Contracts Won</th><th className="ad-num">Awarded Amount</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.length === 0 ? (
                  <TableEmpty colSpan={5} icon={Users} title="No suppliers yet" description="Registered suppliers will be listed here." />
                ) : suppliers.map(s => (
                  <tr key={s.id}>
                    <td className="ad-bold">{s.company}</td>
                    <td><StatusBadge domain="qualification" status={s.qualification_status} /></td>
                    <td className="ad-muted">{fmtDate(s.registered)}</td>
                    <td className="ad-num">{supplierAwardStats[s.id]?.count || 0}</td>
                    <td className="ad-num">{peso(supplierAwardStats[s.id]?.amount || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const loc = useLocation()
  const navigate = useNavigate()
  const [navOpen, setNavOpen] = useState(false)
  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setNavOpen(false) }, [loc.pathname])

  const PAGE_TITLES = {
    '/admin':           'Admin Dashboard',
    '/admin/projects':  'Project Management',
    '/admin/projects/history': 'Bidding History',
    '/admin/planning':  'Procurement Planning',
    '/admin/suppliers': 'Supplier Management',
    '/admin/bids':      'Bid Evaluation',
    '/admin/awards':    'Awarding',
    '/admin/reports':   'Reports & Analytics',
  }
  const title = PAGE_TITLES[loc.pathname]
    || (loc.pathname.startsWith('/admin/bids/') ? 'Bid Evaluation' : 'Admin Dashboard')

  // Breadcrumbs: Admin › Section › (sub-page)
  const CRUMB_SECTIONS = {
    projects: 'Projects', planning: 'Planning', suppliers: 'Suppliers',
    bids: 'Bids', awards: 'Awards', reports: 'Reports',
  }
  const [, , section, sub] = loc.pathname.split('/')
  const crumbs = [{ label: 'Admin', to: '/admin' }]
  if (!section || !CRUMB_SECTIONS[section]) crumbs.push({ label: 'Dashboard' })
  else {
    crumbs.push({ label: CRUMB_SECTIONS[section], to: `/admin/${section}` })
    if (sub) crumbs.push({ label: section === 'bids' ? 'Evaluation' : sub === 'history' ? 'History' : sub })
  }

  // "/admin/projects/history" and "/admin/bids/:id" keep their parent highlighted.
  const isActive = (to) => to === '/admin' ? loc.pathname === '/admin' : loc.pathname === to || loc.pathname.startsWith(`${to}/`)

  const u = storedUser()
  const user = {
    name: u.full_name || u.username || 'System Administrator',
    email: u.email || '',
    role: 'Administrator',
  }

  return (
    <div className="ad-layout">
      <AppSidebar
        workspace="Admin Workspace"
        logoIcon={Shield}
        sections={NAV_SECTIONS}
        isActive={isActive}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />
      {navOpen && <div className="ad-nav-backdrop" onClick={() => setNavOpen(false)} />}
      <div className="ad-main">
        <AppHeader
          title={title}
          breadcrumbs={crumbs}
          onMenu={() => setNavOpen(true)}
          user={user}
          menu={[{ icon: LogOut, label: 'Log out', danger: true, onClick: () => { apiLogout(); navigate('/login') } }]}
        />
        <div className="ad-body">
          <Routes>
            <Route index element={<DashboardHome />} />
            <Route path="projects"  element={<ProjectsPage />} />
            <Route path="projects/history" element={<ProjectHistoryPage />} />
            <Route path="planning"  element={<PlanningPage />} />
            <Route path="suppliers" element={<SuppliersPage />} />
            <Route path="bids"      element={<BidsPage />} />
            <Route path="bids/:id"  element={<BidEvaluationPage />} />
            <Route path="awards"    element={<AwardsPage />} />
            <Route path="reports"   element={<ReportsPage />} />
            <Route path="*"         element={<DashboardHome />} />
          </Routes>
        </div>
      </div>
      {/* Blockchain anchoring feedback for every Admin transition (create,
          publish, qualify/disqualify, award). At the layout root so it survives
          route changes while a MetaMask prompt is open. */}
      <AnchorActivity />
    </div>
  )
}
