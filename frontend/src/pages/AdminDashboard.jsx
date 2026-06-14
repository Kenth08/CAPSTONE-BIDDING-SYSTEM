import { useState, useEffect } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, Calendar, Users, Pencil, Award, BarChart2,
  Bell, Search, ChevronRight, LogOut, Shield,
  Plus, FileText, Activity, UserCheck, Info, Eye, X, ExternalLink,
  CheckCircle2, AlertTriangle, XCircle, Check
} from 'lucide-react'
import {
  clearSession, apiListSuppliers, apiGetSupplier,
  apiSupplierApprove, apiSupplierReject, apiSupplierRequestRevision,
  apiListProjectBids, apiQualifyBid, apiDisqualifyBid, apiSelectWinner,
} from '../api'
import { useProjects, createProject, publishProject, refreshProjects } from '../store/projectsStore'
import { CATEGORIES } from '../constants/categories'
import '../style/AdminDashboard.css'

const NAV = [
  { icon: LayoutDashboard, label: 'Dashboard', to: '/admin' },
  { icon: FolderOpen,      label: 'Projects',  to: '/admin/projects' },
  { icon: Calendar,        label: 'Planning',  to: '/admin/planning' },
  { icon: Users,           label: 'Suppliers', to: '/admin/suppliers' },
  { icon: Pencil,          label: 'Bids',      to: '/admin/bids' },
  { icon: Award,           label: 'Awards',    to: '/admin/awards' },
  { icon: BarChart2,       label: 'Reports',   to: '/admin/reports' },
]

const INITIAL_AWARDS = [
  { supplier: 'Kenthcharles Repollo', project: 'computer',     amount: '₱1,000',   date: 'June 1, 2026', status: 'won' },
  { supplier: 'Kenthcharles Repollo', project: 'chair/table',  amount: '₱100,000', date: 'June 1, 2026', status: 'won' },
]

const EXPIRING_DOCS = [
  { company: 'PA co.', docType: "Mayor's Permit", date: '7/4/2026' },
  { company: 'PA co.', docType: 'Tax Clearance',  date: '7/3/2026' },
]

const STATUS_LABEL = {
  draft: 'Draft', pending_head: 'Pending', approved: 'Approved', rejected: 'Rejected',
  published: 'Open for Bidding', awarded: 'Awarded', closed: 'Closed', active: 'Active',
}
const STATUS_CLS = {
  draft: 'badge-gray', pending_head: 'badge-yellow', approved: 'badge-green', rejected: 'badge-red',
  published: 'badge-blue', awarded: 'badge-awarded', active: 'badge-blue',
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ active }) {
  const navigate = useNavigate()
  return (
    <aside className="ad-sidebar">
      <div className="ad-sidebar-logo">
        <span className="ad-logo-icon"><Shield size={16} /></span>
        <div>
          <div className="ad-logo-name">E-Procurement</div>
          <div className="ad-logo-sub">Admin Workspace</div>
        </div>
      </div>

      <div className="ad-menu-section">
        <span className="ad-menu-label">MENU</span>
        <nav className="ad-sidebar-nav">
          {NAV.map(({ icon: Icon, label, to }) => (
            <Link key={to} to={to} className={`ad-nav-item${active === to ? ' active' : ''}`}>
              <Icon size={18} />
              <span>{label}</span>
              {active === to && <span className="ad-nav-dot" />}
            </Link>
          ))}
        </nav>
      </div>

      <div className="ad-sidebar-footer">
        <div className="ad-sidebar-user">
          <div className="ad-sidebar-avatar">S</div>
          <div className="ad-sidebar-user-info">
            <span className="ad-sidebar-user-name">System Administr...</span>
            <span className="ad-sidebar-user-email">admin@gmail.com</span>
          </div>
          <button
            className="ad-sidebar-expand"
            onClick={() => { clearSession(); navigate('/login') }}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </aside>
  )
}

// ── Header ────────────────────────────────────────────────────────────────────

function Header({ title }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <header className="ad-header">
      <div className="ad-header-left">
        <div className="ad-workspace-label">ADMIN WORKSPACE</div>
        <h1 className="ad-page-title">{title}</h1>
      </div>
      <div className="ad-header-right">
        <div className="ad-search">
          <Search size={15} />
          <input placeholder="Search..." />
          <span className="ad-search-shortcut">Ctrl+4</span>
        </div>
        <button className="ad-notif">
          <Bell size={18} /><span className="ad-notif-dot" />
        </button>
        <div className="ad-user-wrap">
          <div className="ad-user" onClick={() => setOpen(o => !o)}>
            <div className="ad-avatar">S</div>
            <span className="ad-user-name">System Administrator</span>
            <div className="ad-avatar-dark">N</div>
          </div>
          {open && (
            <>
              <div className="ad-dropdown-backdrop" onClick={() => setOpen(false)} />
              <div className="ad-dropdown">
                <div className="ad-dropdown-header">
                  <div className="ad-avatar">S</div>
                  <div>
                    <div className="ad-dropdown-name">System Administrator</div>
                    <div className="ad-dropdown-email">admin@gmail.com</div>
                  </div>
                </div>
                <div className="ad-dropdown-divider" />
                <button className="ad-dropdown-item ad-dropdown-logout"
                  onClick={() => { clearSession(); navigate('/login') }}>
                  <LogOut size={15} /> Log out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

// ── Dashboard Home ────────────────────────────────────────────────────────────

function DashboardHome() {
  const { projects, loading } = useProjects()
  const awards = INITIAL_AWARDS
  const [tab, setTab] = useState('All')
  const TABS = ['All', 'Draft', 'Active', 'Closed', 'Awarded']

  const totalProjects    = projects.length
  const totalBids        = projects.reduce((s, p) => s + p.bids, 0)
  const activeBidding    = projects.filter(p => p.status === 'published' || p.status === 'active').length
  const awardedContracts = projects.filter(p => p.status === 'awarded').length

  const STATS = [
    { label: 'TOTAL PROJECTS',    value: totalProjects,    sub: 'All created procurement projects', icon: FolderOpen  },
    { label: 'TOTAL BIDS',        value: totalBids,        sub: 'Submitted bid entries',            icon: FileText    },
    { label: 'ACTIVE BIDDING',    value: activeBidding,    sub: 'Projects currently open',          icon: Activity    },
    { label: 'AWARDED CONTRACTS', value: awardedContracts, sub: 'Finalized awards',                 icon: UserCheck   },
  ]

  const filtered = projects.filter(p => {
    if (tab === 'All')     return true
    if (tab === 'Awarded') return p.status === 'awarded'
    if (tab === 'Active')  return p.status === 'published' || p.status === 'active'
    if (tab === 'Draft')   return p.status === 'draft'
    if (tab === 'Closed')  return p.status === 'closed'
    return true
  })

  return (
    <div className="ad-content">
      <div className="ad-stats">
        {STATS.map(({ label, value, sub, icon: Icon }) => (
          <div className="ad-stat-card" key={label}>
            <div className="ad-stat-top">
              <span className="ad-stat-label">{label}</span>
              <div className="ad-stat-icon-wrap"><Icon size={18} /></div>
            </div>
            <div className="ad-stat-value">{value}</div>
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
            </div>
            <div className="ad-filter-pills">
              {TABS.map(t => (
                <button
                  key={t}
                  className={`ad-pill${tab === t ? ' ad-pill-active' : ''}`}
                  onClick={() => setTab(t)}
                >{t}</button>
              ))}
            </div>
            <div className="ad-project-list">
              {loading && filtered.length === 0
                ? <div className="ad-empty-msg">Loading projects…</div>
                : filtered.length === 0
                ? <div className="ad-empty-msg">No projects in this category.</div>
                : filtered.map(p => (
                  <div className="ad-project-row" key={p.id}>
                    <div>
                      <div className="ad-bold">{p.name}</div>
                      <div className="ad-muted ad-small">{p.budget} · {p.deadline}</div>
                    </div>
                    <span className={`badge ${STATUS_CLS[p.status] || 'badge-gray'}`}>
                      • {STATUS_LABEL[p.status] || p.status}
                    </span>
                  </div>
                ))
              }
            </div>
          </div>

          <div className="ad-card ad-card-mt">
            <div className="ad-card-header">
              <h2>Expiring Documents (30 days)</h2>
            </div>
            <div className="ad-expiring-list">
              {EXPIRING_DOCS.map((doc, i) => (
                <div className="ad-expiring-row" key={i}>
                  <div>
                    <div className="ad-bold">{doc.company}</div>
                    <div className="ad-muted ad-small">{doc.docType}</div>
                  </div>
                  <span className="ad-expiring-date">{doc.date}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="ad-dash-side">
          <div className="ad-card">
            <div className="ad-card-header">
              <h2>Next Actions</h2>
            </div>
            <div className="ad-next-actions">
              <Link to="/admin/projects" className="ad-next-action">
                <div>
                  <div className="ad-bold">Create or Manage Projects</div>
                  <div className="ad-muted ad-small">Review draft, active, and awarded projects</div>
                </div>
                <ChevronRight size={16} className="ad-action-arrow" />
              </Link>
              <Link to="/admin/suppliers" className="ad-next-action">
                <div>
                  <div className="ad-bold">Review Suppliers</div>
                  <div className="ad-muted ad-small">Check supplier profiles and approvals</div>
                </div>
                <ChevronRight size={16} className="ad-action-arrow" />
              </Link>
              <Link to="/admin/bids" className="ad-next-action">
                <div>
                  <div className="ad-bold">Evaluate Bids</div>
                  <div className="ad-muted ad-small">Open bid evaluation for submitted projects</div>
                </div>
                <ChevronRight size={16} className="ad-action-arrow" />
              </Link>
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
  const [filterTab, setFilterTab] = useState('All')
  const [search, setSearch] = useState('')
  const FILTER_TABS = ['All', 'Active', 'Closed', 'Awarded']

  // Only projects the Head has already approved appear here. Projects still being
  // planned, awaiting approval, or rejected stay on the Planning page.
  const approved = projects.filter(p => !['draft', 'pending_head', 'rejected'].includes(p.status))

  const filtered = approved.filter(p => {
    const q = search.toLowerCase()
    const matchSearch = !q || p.name.toLowerCase().includes(q)
    const matchTab =
      filterTab === 'All'     ? true :
      filterTab === 'Awarded' ? p.status === 'awarded' :
      filterTab === 'Active'  ? (p.status === 'approved' || p.status === 'published' || p.status === 'active') :
      filterTab === 'Closed'  ? p.status === 'closed' : true
    return matchSearch && matchTab
  })

  return (
    <div className="ad-content">
      <div className="ad-card">
        <div className="ad-card-header">
          <div className="ad-filter-pills">
            {FILTER_TABS.map(t => (
              <button key={t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
            ))}
          </div>
          <div className="ad-toolbar">
            <div className="ad-search-inline">
              <Search size={14} />
              <input placeholder="Search projects" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
        </div>

        <table className="ad-table">
          <thead>
            <tr>
              <th>TITLE</th><th>BUDGET</th><th>DEADLINE</th><th>TYPE</th>
              <th>ELIGIBLE TYPES</th><th>STATUS</th><th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {loading && filtered.length === 0
              ? <tr><td colSpan={7} className="ad-empty-row">Loading projects…</td></tr>
              : filtered.length === 0
              ? <tr><td colSpan={7} className="ad-empty-row">No approved projects yet.</td></tr>
              : filtered.map(p => (
                <tr key={p.id}>
                  <td className="ad-bold">{p.name}</td>
                  <td>{p.budget}</td>
                  <td className="ad-muted">{p.deadline}</td>
                  <td>{p.type}</td>
                  <td><span className="badge badge-gray">{p.eligibleTypes}</span></td>
                  <td>
                    <span className={`badge ${STATUS_CLS[p.status] || 'badge-gray'}`}>
                      • {STATUS_LABEL[p.status] || p.status}
                    </span>
                  </td>
                  <td>
                    <div className="ad-actions">
                      {p.status === 'approved' && <PublishButton project={p} />}
                      <button className="ad-btn-view-sm"><Eye size={12} /> View Bids</button>
                    </div>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Publishes an approved procurement so eligible suppliers can start bidding.
function PublishButton({ project }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const onPublish = async () => {
    setBusy(true); setErr('')
    try { await publishProject(project.id) }
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
  delivery_location: '', deadline: '', expected_delivery_date: '', description: '',
}
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

// Single document upload control used in the procurement creation form.
function DocUploader({ doc, file, onFile, onRemove }) {
  const inputId = `doc-${doc.key}`
  return (
    <div className="ad-doc-field">
      <div className="ad-doc-label">{doc.label} <span className="ad-doc-req">Required</span></div>
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

function PlanningPage() {
  const { projects, loading } = useProjects()
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_PROJECT)
  const [files, setFiles] = useState({})        // { docKey: File }
  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const onDoc = (key, file) => {
    if (!file) return
    const msg = checkDoc(file)
    if (msg) { setSubmitErr(`${key.replace(/_/g, ' ')}: ${msg}`); return }
    setSubmitErr('')
    setFiles(f => ({ ...f, [key]: file }))
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
    } catch (err) {
      setSubmitErr(err.message || 'Could not create the project. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // Planning holds projects still in the pipeline: drafts, those awaiting the
  // Head's approval, and any the Head rejected. Approved projects move to Projects.
  const planning = projects.filter(p => ['draft', 'pending_head', 'rejected'].includes(p.status))

  const filtered = planning.filter(p => {
    const q = search.toLowerCase()
    return !q || p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q)
  })

  return (
    <div className="ad-content">
      <div className="ad-card">
        <div className="ad-card-header">
          <div className="ad-search-inline">
            <Search size={14} />
            <input placeholder="Search by title or type" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button className="ad-btn-primary" onClick={() => setShowForm(v => !v)}>
            <Plus size={14} /> {showForm ? 'Cancel' : 'Create Project'}
          </button>
        </div>

        {showForm && (
          <div className="ad-form-wrap">
            <div className="ad-form-title">Create New Procurement</div>
            <form onSubmit={handleSubmit} className="ad-form-grid">
              <div className="ad-form-group ad-form-full">
                <label>Project Title</label>
                <input value={form.name} onChange={e => set('name', e.target.value)} required />
              </div>
              <div className="ad-form-group">
                <label>Procurement Category</label>
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
                <label>Approved Budget (ABC)</label>
                <input value={form.budget} onChange={e => set('budget', e.target.value)} placeholder="e.g. ₱50,000" required />
              </div>
              <div className="ad-form-group">
                <label>Delivery Location</label>
                <input value={form.delivery_location} onChange={e => set('delivery_location', e.target.value)} placeholder="e.g. Main Campus" required />
              </div>
              <div className="ad-form-group">
                <label>Bid Submission Deadline</label>
                <input type="date" value={form.deadline} onChange={e => set('deadline', e.target.value)} required />
              </div>
              <div className="ad-form-group">
                <label>Expected Delivery Date</label>
                <input type="date" value={form.expected_delivery_date} onChange={e => set('expected_delivery_date', e.target.value)} required />
              </div>
              <div className="ad-form-group ad-form-full">
                <label>Project Description</label>
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

              {submitErr && (
                <div className="ad-form-full" style={{ color: '#ef4444', fontSize: 13, fontWeight: 500 }}>
                  {submitErr}
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

        <table className="ad-table">
          <thead>
            <tr>
              <th>PROJECT TITLE</th><th>BUDGET</th><th>TYPE</th>
              <th>DEADLINE</th><th>STATUS</th><th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {loading && filtered.length === 0
              ? <tr><td colSpan={6} className="ad-empty-row">Loading projects…</td></tr>
              : filtered.length === 0
              ? <tr><td colSpan={6} className="ad-empty-row">No planning requests yet. Click “Create Project” to add one.</td></tr>
              : filtered.map(p => (
                <tr key={p.id}>
                  <td className="ad-bold">
                    {p.name}
                    {p.status === 'rejected' && p.rejectReason && (
                      <div className="ad-muted ad-small" style={{ fontWeight: 400, marginTop: 2 }}>
                        Reason: {p.rejectReason}
                      </div>
                    )}
                  </td>
                  <td>{p.budget}</td>
                  <td>{p.type}</td>
                  <td className="ad-muted">{p.deadline}</td>
                  <td>
                    <span className={`badge ${STATUS_CLS[p.status] || 'badge-gray'}`}>
                      • {STATUS_LABEL[p.status] || p.status}
                    </span>
                  </td>
                  <td>
                    <div className="ad-actions">
                      <button className="ad-btn-view-sm"><Eye size={12} /> View Details</button>
                    </div>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
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
        <div className="ad-card-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <div className="ad-filter-pills">
            {TABS.map(t => (
              <button key={t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
            ))}
          </div>
          <div className="ad-search-inline">
            <Search size={14} />
            <input placeholder="Search by company or name" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <table className="ad-table">
          <thead>
            <tr>
              <th>COMPANY</th><th>CONTACT</th><th>BUSINESS TYPE</th><th>STATUS</th>
              <th>QUALIFICATION STATUS</th><th>EMAIL VERIFIED</th><th>REGISTERED</th><th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }).map((_, i) => <SupplierRowSkeleton key={i} />)
              : error
              ? <tr><td colSpan={8} className="ad-empty-row">{error}</td></tr>
              : filtered.length === 0
              ? <tr><td colSpan={8} className="ad-empty-row">No suppliers found.</td></tr>
              : filtered.map(s => (
                <tr key={s.id}>
                  <td className="ad-bold">{s.company}</td>
                  <td>{s.contact || s.full_name}</td>
                  <td className="ad-muted" style={{ maxWidth: 200, wordBreak: 'break-word', fontSize: 12 }}>{s.business_type}</td>
                  <td>
                    <span className={`badge ${SUP_STATUS_CLS[s.status] || 'badge-gray'}`}>
                      • {(s.status || '').toUpperCase()}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${QUAL_CLS[s.qualification_status] || 'badge-gray'}`}>
                      {QUAL_LABEL[s.qualification_status] || (s.qualification_status || '').replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td><span className={`badge ${s.email_verified ? 'badge-green' : 'badge-gray'}`}>{s.email_verified ? 'Verified' : 'Unverified'}</span></td>
                  <td className="ad-muted">{s.registered}</td>
                  <td>
                    <button className="ad-btn-view-sm" onClick={() => setViewId(s.id)}>
                      <Eye size={12} /> View
                    </button>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
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
          <button className="ad-modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        {loading ? (
          <div className="ad-modal-body"><SupplierDetailSkeleton /></div>
        ) : !supplier ? (
          <div className="ad-modal-body" style={{ padding: 40, textAlign: 'center' }}>{error || 'Could not load supplier.'}</div>
        ) : (
          <>
            <div className="ad-modal-body">
              {error && <div className="ad-modal-error"><AlertTriangle size={15} /> {error}</div>}

              <div className="ad-modal-badges">
                <span className={`badge ${SUP_STATUS_CLS[supplier.status] || 'badge-gray'}`}>• {(supplier.status || '').toUpperCase()}</span>
                <span className={`badge ${QUAL_CLS[supplier.qualification_status] || 'badge-gray'}`}>
                  {QUAL_LABEL[supplier.qualification_status] || supplier.qualification_status}
                </span>
              </div>

              <div className="ad-info-grid">
                <Info2 label="Representative" value={supplier.representative_name || supplier.contact} />
                <Info2 label="Email" value={supplier.email} />
                <Info2 label="Phone" value={supplier.phone_number} />
                <Info2 label="TIN" value={supplier.tin} />
                <Info2 label="Address" value={supplier.company_address} full />
                <Info2 label="Business Types" value={(supplier.business_types || []).join(', ') || supplier.business_type} full />
                <Info2 label="Registered" value={supplier.registered} />
                <Info2 label="Financial Year" value={supplier.financial_statement_year} />
              </div>

              <div className="ad-docs-head">
                <FileText size={15} /> Uploaded Documents
                <span className="ad-muted ad-small">Check a document to flag it for revision.</span>
              </div>
              <div className="ad-docs-list">
                {supplier.documents.map(d => (
                  <div className={`ad-doc-row${flags[d.key]?.checked ? ' flagged' : ''}`} key={d.key}>
                    <div className="ad-doc-main">
                      <label className="ad-doc-check">
                        <input
                          type="checkbox"
                          checked={!!flags[d.key]?.checked}
                          disabled={!d.url}
                          onChange={() => toggleFlag(d.key)}
                        />
                      </label>
                      <div className="ad-doc-name">
                        <span className="ad-bold">{d.label}</span>
                        <span className={d.required ? 'ad-req-tag' : 'ad-opt-tag'}>{d.required ? 'Required' : 'Optional'}</span>
                      </div>
                      {d.url
                        ? <a className="ad-doc-view" href={d.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> View</a>
                        : <span className="ad-doc-missing">Not uploaded</span>}
                    </div>
                    {flags[d.key]?.checked && (
                      <input
                        className="ad-doc-note"
                        placeholder="What needs fixing? (e.g. blurry scan, expired)"
                        value={flags[d.key]?.note || ''}
                        onChange={e => setFlagNote(d.key, e.target.value)}
                      />
                    )}
                  </div>
                ))}
              </div>

              <div className="ad-field">
                <label>Message to supplier (overall note)</label>
                <textarea
                  rows={2}
                  placeholder="Optional message shown to the supplier with your decision…"
                  value={note}
                  onChange={e => setNote(e.target.value)}
                />
              </div>
            </div>

            <div className="ad-modal-footer">
              <button className="ad-btn-cancel" onClick={onClose}>Close</button>
              <div className="ad-modal-footer-actions">
                <button className="ad-btn-reject" disabled={busy} onClick={handleReject}>
                  <XCircle size={14} /> Reject
                </button>
                <button className="ad-btn-revision" disabled={busy} onClick={handleRequestRevision}>
                  <AlertTriangle size={14} /> Request Revision
                </button>
                <button className="ad-btn-approve" disabled={busy} onClick={handleApprove}>
                  <Check size={14} /> Approve
                </button>
              </div>
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

function BidsPage() {
  const { projects, loading } = useProjects()
  const [filterTab, setFilterTab] = useState('All')
  const [evalProject, setEvalProject] = useState(null)
  const [toast, setToast] = useState(null)
  const TABS = ['All', 'Goods', 'Services', 'Infrastructure', 'More']

  // Only Head-approved projects can receive/evaluate bids — not drafts, items
  // still awaiting approval, or rejected ones (those stay in Planning).
  const biddable = projects.filter(p => !['draft', 'pending_head', 'rejected'].includes(p.status))

  const filtered = biddable.filter(p => {
    if (filterTab === 'All')            return true
    if (filterTab === 'Services')       return p.type.includes('Services')
    if (filterTab === 'Goods')          return p.type.includes('Equipment') || p.type.includes('Goods')
    if (filterTab === 'Infrastructure') return p.type.includes('Infrastructure')
    return true
  })

  return (
    <div className="ad-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      {evalProject && (
        <BidEvaluationModal
          project={evalProject}
          onClose={() => setEvalProject(null)}
          onAwarded={(msg) => { setToast({ type: 'success', message: msg }); refreshProjects(); setEvalProject(null) }}
          onToast={setToast}
        />
      )}
      <div>
        <h2 className="ad-bids-title">Select a Project to Evaluate</h2>
        <p className="ad-bids-sub">Click a project below to review and evaluate submitted bids.</p>
      </div>
      <div className="ad-filter-pills">
        {TABS.map(t => (
          <button key={t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
        ))}
      </div>
      <div className="ad-bid-cards">
        {loading && filtered.length === 0
          ? <div className="ad-empty-msg">Loading projects…</div>
          : filtered.length === 0
          ? <div className="ad-empty-msg">No projects available for bidding yet.</div>
          : filtered.map(p => (
            <div className="ad-bid-card" key={p.id} onClick={() => setEvalProject(p)} role="button" tabIndex={0}>
              <div className="ad-bid-card-top">
                <div className="ad-bid-card-icon"><FolderOpen size={18} /></div>
                <ChevronRight size={16} className="ad-bid-card-arrow" />
              </div>
              <div className="ad-bid-card-name">{p.name}</div>
              <div className="ad-bid-card-budget">{p.budget} budget</div>
              <span className="badge badge-blue ad-bid-card-type">{p.type}</span>
              <div className="ad-muted ad-small ad-bid-card-desc">
                Click to open the project, review submitted bids, and mark the winning supplier.
              </div>
              <div className="ad-bid-card-footer">
                <span className="ad-bid-card-count">{p.bids} bid{p.bids !== 1 ? 's' : ''}</span>
                <span className={`badge ${STATUS_CLS[p.status] || 'badge-gray'}`}>
                  • {STATUS_LABEL[p.status] || p.status}
                </span>
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

// ── Bid evaluation modal (admin) ──────────────────────────────────────────────
function BidEvaluationModal({ project, onClose, onAwarded, onToast }) {
  const [bids, setBids] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [confirm, setConfirm] = useState(null)   // { bid }
  const awarded = project.status === 'awarded'

  const load = () => {
    setLoading(true)
    apiListProjectBids(project.id)
      .then(setBids)
      .catch(() => onToast?.({ type: 'error', message: 'Could not load bids.' }))
      .finally(() => setLoading(false))
  }
  useEffect(load, [project.id])

  const act = async (bid, fn, errMsg) => {
    setBusyId(bid.id)
    try { await fn(bid.id); load() }
    catch (e) { onToast?.({ type: 'error', message: e.message || errMsg }) }
    finally { setBusyId(null) }
  }

  const confirmWinner = async () => {
    const bid = confirm.bid
    setBusyId(bid.id); setConfirm(null)
    try {
      await apiSelectWinner(bid.id)
      onAwarded(`${bid.supplier_name} selected as winner for ${project.name}.`)
    } catch (e) {
      onToast?.({ type: 'error', message: e.message || 'Could not select winner.' })
      setBusyId(null)
    }
  }

  const peso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH')

  return (
    <div className="ad-modal-overlay" onClick={onClose}>
      <div className="ad-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-header">
          <div>
            <h3>Bid Evaluation — {project.name}</h3>
            <p className="ad-muted ad-small">{project.code} · {project.category} · ABC {project.budget}</p>
          </div>
          <button className="ad-modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="ad-modal-body">
          {awarded && (
            <div className="ad-modal-error" style={{ background: '#f0fdf4', borderColor: '#bbf7d0', color: '#15803d' }}>
              <CheckCircle2 size={15} /> This procurement has been awarded.
            </div>
          )}
          {loading ? (
            <div style={{ padding: 30, textAlign: 'center' }}>Loading bids…</div>
          ) : bids.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-gray)' }}>No bids submitted yet.</div>
          ) : (
            <table className="ad-table">
              <thead>
                <tr><th>SUPPLIER</th><th>BID AMOUNT</th><th>NOTES</th><th>QUALIFICATION STATUS</th><th>ACTIONS</th></tr>
              </thead>
              <tbody>
                {bids.map(b => (
                  <tr key={b.id}>
                    <td className="ad-bold">{b.supplier_name}</td>
                    <td>{peso(b.amount)}</td>
                    <td className="ad-muted" style={{ maxWidth: 200, fontSize: 12 }}>{b.notes || '—'}</td>
                    <td>
                      <span className={`badge ${QUAL_BID_CLS[b.status] || 'badge-gray'}`}>
                        {QUAL_BID_LABEL[b.status] || b.status}
                      </span>
                    </td>
                    <td>
                      {b.status === 'winner' ? (
                        <span className="ad-muted ad-small">Winner</span>
                      ) : awarded ? (
                        <span className="ad-muted ad-small">—</span>
                      ) : (
                        <div className="ad-actions">
                          {b.status !== 'qualified' && (
                            <button className="ad-btn-approve" disabled={busyId === b.id}
                              onClick={() => act(b, apiQualifyBid, 'Could not qualify.')}>
                              <Check size={12} /> Qualify
                            </button>
                          )}
                          {b.status !== 'disqualified' && (
                            <button className="ad-btn-reject" disabled={busyId === b.id}
                              onClick={() => act(b, apiDisqualifyBid, 'Could not disqualify.')}>
                              <XCircle size={12} /> Disqualify
                            </button>
                          )}
                          {b.status === 'qualified' && (
                            <button className="ad-btn-publish" disabled={busyId === b.id}
                              onClick={() => setConfirm({ bid: b })}>
                              <Award size={12} /> Select Winner
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {confirm && (
          <ConfirmDialog
            title="Select winning bid?"
            message={`Award "${project.name}" to ${confirm.bid.supplier_name} for ${peso(confirm.bid.amount)}? This marks the procurement as Awarded and notifies the bidders.`}
            tone="green"
            confirmLabel="Confirm Winner"
            busy={busyId === confirm.bid.id}
            onConfirm={confirmWinner}
            onCancel={() => setConfirm(null)}
          />
        )}
      </div>
    </div>
  )
}

// ── Awards Page ───────────────────────────────────────────────────────────────

function AwardsPage() {
  const awards = INITIAL_AWARDS
  const [search, setSearch] = useState('')
  const filtered = awards.filter(a => {
    const q = search.toLowerCase()
    return !q || a.supplier.toLowerCase().includes(q) || a.project.toLowerCase().includes(q)
  })

  const totalAmount = awards.reduce((sum, a) => {
    return sum + (parseInt(a.amount.replace(/[^0-9]/g, ''), 10) || 0)
  }, 0)

  return (
    <div className="ad-content">
      <div className="ad-stats">
        <div className="ad-stat-card">
          <div className="ad-stat-label">TOTAL AWARDS</div>
          <div className="ad-stat-value ad-val-green">{awards.length}</div>
        </div>
        <div className="ad-stat-card">
          <div className="ad-stat-label">TOTAL AWARDED AMOUNT</div>
          <div className="ad-stat-value ad-val-blue">₱{totalAmount.toLocaleString()}</div>
        </div>
        <div className="ad-stat-card">
          <div className="ad-stat-label">DOCUMENTS AVAILABLE</div>
          <div className="ad-stat-value ad-val-purple">{awards.length * 3}</div>
        </div>
        <div className="ad-stat-card">
          <div className="ad-stat-label">LATEST AWARD DATE</div>
          <div className="ad-stat-value ad-val-yellow" style={{ fontSize: 18 }}>{awards[0]?.date || '—'}</div>
        </div>
      </div>

      <div className="ad-card">
        <div className="ad-card-header">
          <div className="ad-search-inline">
            <Search size={14} />
            <input
              placeholder="Search by supplier or project"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
        <table className="ad-table">
          <thead>
            <tr>
              <th>SUPPLIER</th><th>PROJECT</th><th>AWARD AMOUNT</th>
              <th>AWARD DATE</th><th>STATUS</th><th>DOCUMENTS</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a, i) => (
              <tr key={i}>
                <td className="ad-bold">{a.supplier}</td>
                <td>{a.project}</td>
                <td className="ad-bold">{a.amount}</td>
                <td className="ad-muted">{a.date}</td>
                <td><span className="badge badge-green">• WON</span></td>
                <td>
                  <div className="ad-doc-btns">
                    <button className="ad-doc-btn"><FileText size={12} /> NOA</button>
                    <button className="ad-doc-btn"><FileText size={12} /> NTP</button>
                    <button className="ad-doc-btn"><FileText size={12} /> Resolution</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ad-award-info">
        <Info size={18} className="ad-award-info-icon" />
        <div>
          <div className="ad-bold" style={{ marginBottom: 6 }}>About Award Documents</div>
          <p className="ad-muted ad-small" style={{ marginBottom: 8 }}>Once a winning bid is selected, three official documents are available:</p>
          <ul className="ad-award-info-list">
            <li><strong>NOA:</strong> Official notification to the winning supplier</li>
            <li><strong>NTP:</strong> Authorization for the supplier to begin work</li>
            <li><strong>Resolution:</strong> Official resolution documenting the award decision</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

// ── Reports Page ──────────────────────────────────────────────────────────────

function ReportsPage() {
  const { projects } = useProjects()
  const awards = INITIAL_AWARDS
  const [reportTab, setReportTab] = useState('procurement')

  const totalProjects  = projects.length
  const activePrj      = projects.filter(p => p.status === 'published' || p.status === 'active').length
  const awardedPrj     = projects.filter(p => p.status === 'awarded').length
  const totalBids      = projects.reduce((s, p) => s + p.bids, 0)
  const awardedAmount  = awards.reduce((sum, a) => sum + (parseInt(a.amount.replace(/[^0-9]/g, ''), 10) || 0), 0)

  const typeCount = projects.reduce((acc, p) => {
    acc[p.type] = (acc[p.type] || 0) + 1
    return acc
  }, {})

  return (
    <div className="ad-content">
      <div className="ad-report-bar">
        <div className="ad-report-tabs">
          <button
            className={`ad-report-tab${reportTab === 'procurement' ? ' active' : ''}`}
            onClick={() => setReportTab('procurement')}
          >Procurement Report</button>
          <button
            className={`ad-report-tab${reportTab === 'supplier' ? ' active' : ''}`}
            onClick={() => setReportTab('supplier')}
          >Supplier Report</button>
        </div>
        <div className="ad-export-btns">
          <button className="ad-btn-export-csv">Export CSV</button>
          <button className="ad-btn-primary">Export PDF</button>
        </div>
      </div>

      {reportTab === 'procurement' && (
        <>
          <div className="ad-report-stats">
            {[
              { label: 'TOTAL PROJECTS', value: totalProjects, cls: ''              },
              { label: 'ACTIVE',          value: activePrj,    cls: 'ad-val-blue'   },
              { label: 'AWARDED',         value: awardedPrj,   cls: 'ad-val-purple' },
              { label: 'TOTAL BIDS',      value: totalBids,    cls: 'ad-val-yellow' },
              { label: 'AWARDED AMOUNT',  value: `₱${awardedAmount.toLocaleString()}`, cls: 'ad-val-green' },
            ].map(({ label, value, cls }) => (
              <div className="ad-stat-card" key={label}>
                <div className="ad-stat-label">{label}</div>
                <div className={`ad-stat-value ${cls}`} style={{ fontSize: 22 }}>{value}</div>
              </div>
            ))}
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>By Procurement Type</h2></div>
            <table className="ad-table">
              <thead><tr><th>TYPE</th><th>COUNT</th></tr></thead>
              <tbody>
                {Object.entries(typeCount).map(([type, count]) => (
                  <tr key={type}><td>{type}</td><td>{count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>Recent Awards</h2></div>
            <table className="ad-table">
              <thead><tr><th>PROJECT</th><th>WINNER</th><th>AMOUNT</th><th>DATE</th></tr></thead>
              <tbody>
                {awards.map((a, i) => (
                  <tr key={i}>
                    <td>{a.project}</td>
                    <td>PA co.</td>
                    <td className="ad-bold">{a.amount}</td>
                    <td className="ad-muted">{a.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {reportTab === 'supplier' && (
        <div className="ad-card">
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--text-gray)', fontSize: 14 }}>
            Supplier report coming soon.
          </div>
        </div>
      )}
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const loc = useLocation()
  // The dashboard shell holds no data — each page below loads its own.

  const PAGE_TITLES = {
    '/admin':           'Admin Dashboard',
    '/admin/projects':  'Project Management',
    '/admin/planning':  'Procurement Planning',
    '/admin/suppliers': 'Supplier Management',
    '/admin/bids':      'Bid Evaluation',
    '/admin/awards':    'Awarding',
    '/admin/reports':   'Reports & Analytics',
  }
  const title = PAGE_TITLES[loc.pathname] || 'Admin Dashboard'

  return (
    <div className="ad-layout">
      <Sidebar active={loc.pathname} />
      <div className="ad-main">
        <Header title={title} />
        <div className="ad-body">
          <Routes>
            <Route index element={<DashboardHome />} />
            <Route path="projects"  element={<ProjectsPage />} />
            <Route path="planning"  element={<PlanningPage />} />
            <Route path="suppliers" element={<SuppliersPage />} />
            <Route path="bids"      element={<BidsPage />} />
            <Route path="awards"    element={<AwardsPage />} />
            <Route path="reports"   element={<ReportsPage />} />
            <Route path="*"         element={<DashboardHome />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
