import { useState, useEffect } from 'react'
import { Routes, Route, Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, Calendar, Users, Pencil, Award, BarChart2,
  Search, ChevronRight, LogOut, Shield,
  Plus, FileText, Activity, UserCheck, Info, Eye, X, ExternalLink,
  CheckCircle2, AlertTriangle, XCircle, Check, Menu, ImageIcon, Clock, ArrowLeft
} from 'lucide-react'
import {
  apiLogout, apiListSuppliers, apiGetSupplier,
  apiSupplierApprove, apiSupplierReject, apiSupplierRequestRevision, apiAdminRegisterSupplier,
  apiListProjectBids, apiQualifyBid, apiDisqualifyBid, apiSelectWinner, apiGetProject,
  apiListAwards, apiListDocuments,
} from '../api'
import { useProjects, createProject, publishProject, refreshProjects, isExpired } from '../store/projectsStore'
import { CATEGORIES } from '../constants/categories'
import { Skeleton, TableSkeleton, ListSkeleton } from '../components/Skeleton'
import NotificationBell from '../components/NotificationBell'
import { exportReportCSV, exportReportPDF } from '../utils/exportReport'
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

const STATUS_LABEL = {
  draft: 'Draft', pending_head: 'Pending', approved: 'Approved', rejected: 'Rejected',
  published: 'Open for Bidding', awarded: 'Awarded', closed: 'Closed', active: 'Active',
}
const STATUS_CLS = {
  draft: 'badge-gray', pending_head: 'badge-yellow', approved: 'badge-green', rejected: 'badge-red',
  published: 'badge-blue', awarded: 'badge-awarded', active: 'badge-blue',
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ active, open, onClose }) {
  return (
    <aside className={`ad-sidebar${open ? ' open' : ''}`}>
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
          {NAV.map(({ icon: Icon, label, to }) => {
            // "/admin/projects/history" is a sub-view of Projects, so it keeps
            // the Projects nav item highlighted too.
            const isActive = active === to || (to === '/admin/projects' && active.startsWith(`${to}/`))
            return (
              <Link key={to} to={to} className={`ad-nav-item${isActive ? ' active' : ''}`} onClick={onClose}>
                <Icon size={18} />
                <span>{label}</span>
                {isActive && <span className="ad-nav-dot" />}
              </Link>
            )
          })}
        </nav>
      </div>

      <div className="ad-sidebar-footer">
        <div className="ad-sidebar-user">
          <div className="ad-sidebar-avatar">S</div>
          <div className="ad-sidebar-user-info">
            <span className="ad-sidebar-user-name">System Administr...</span>
            <span className="ad-sidebar-user-email">admin@gmail.com</span>
          </div>
        </div>
      </div>
    </aside>
  )
}

// ── Header ────────────────────────────────────────────────────────────────────

function Header({ title, onMenu }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <header className="ad-header">
      <div className="ad-header-left">
        <button className="ad-menu-btn" onClick={onMenu} aria-label="Open menu"><Menu size={20} /></button>
        <div>
          <div className="ad-workspace-label">ADMIN WORKSPACE</div>
          <h1 className="ad-page-title">{title}</h1>
        </div>
      </div>
      <div className="ad-header-right">
        <NotificationBell />
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
                  onClick={() => { apiLogout(); navigate('/login') }}>
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
                ? <ListSkeleton rows={4} height={48} />
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
              {docsLoading
                ? <ListSkeleton rows={2} height={40} />
                : expiringDocs.length === 0
                ? <div className="ad-empty-msg">No documents expiring soon.</div>
                : expiringDocs.map(doc => (
                  <div className="ad-expiring-row" key={doc.id}>
                    <div>
                      <div className="ad-bold">{doc.company}</div>
                      <div className="ad-muted ad-small">{doc.doc_type}</div>
                    </div>
                    <span className="ad-expiring-date">
                      {new Date(doc.expiry_date).toLocaleDateString()}
                    </span>
                  </div>
                ))
              }
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
  const navigate = useNavigate()
  const [filterTab, setFilterTab] = useState('All')
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState(null)
  const FILTER_TABS = ['All', 'Active', 'Closed', 'Awarded']

  // Only projects the Head has already approved appear here. Projects still being
  // planned, awaiting approval, or rejected stay on the Planning page.
  const approved = projects.filter(p => !['draft', 'pending_head', 'rejected'].includes(p.status))

  // Once a project's bid deadline has passed, the bidding window is over — pull
  // it out of the active table and into History instead of leaving it to sit
  // here looking "Open for Bidding" forever.
  const active = approved.filter(p => !isExpired(p))
  const historyCount = approved.length - active.length

  const filtered = active.filter(p => {
    const q = search.toLowerCase()
    const matchSearch = !q || p.name.toLowerCase().includes(q)
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
            <button className="ad-btn-history" onClick={() => navigate('/admin/projects/history')}>
              <Clock size={12} /> History{historyCount > 0 ? ` (${historyCount})` : ''}
            </button>
          </div>
        </div>

        <div className="ad-table-scroll">
        <table className="ad-table">
          <thead>
            <tr>
              <th>TITLE</th><th>BUDGET</th><th>DEADLINE</th><th>TYPE</th>
              <th>ELIGIBLE TYPES</th><th>STATUS</th><th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {loading && filtered.length === 0
              ? <TableSkeleton rows={4} cols={7} />
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
                        <Eye size={12} /> View Bids
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

  const approved = projects.filter(p => !['draft', 'pending_head', 'rejected'].includes(p.status))
  const history = approved.filter(isExpired)

  const filtered = history.filter(p => {
    const q = search.toLowerCase()
    return !q || p.name.toLowerCase().includes(q)
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
            <div className="ad-search-inline">
              <Search size={14} />
              <input placeholder="Search closed biddings" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
        </div>

        <div className="ad-table-scroll">
        <table className="ad-table">
          <thead>
            <tr>
              <th>TITLE</th><th>BUDGET</th><th>CLOSED ON</th><th>TYPE</th>
              <th>ELIGIBLE TYPES</th><th>STATUS</th><th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {loading && sorted.length === 0
              ? <TableSkeleton rows={4} cols={7} />
              : sorted.length === 0
              ? <tr><td colSpan={7} className="ad-empty-row">No closed biddings yet.</td></tr>
              : sorted.map(p => (
                <tr key={p.id}>
                  <td className="ad-bold">{p.name}</td>
                  <td>{p.budget}</td>
                  <td className="ad-muted">{p.deadline}</td>
                  <td>{p.type}</td>
                  <td><span className="badge badge-gray">{p.eligibleTypes}</span></td>
                  <td>
                    <span className={`badge ${closedCls(p)}`}>
                      • {closedLabel(p)}
                    </span>
                  </td>
                  <td>
                    <button className="ad-btn-view-sm" onClick={() => navigate(`/admin/bids/${p.id}`)}>
                      <Eye size={12} /> View Bids
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
  delivery_location: '', deadline: '', expected_delivery_date: '', description: '',
  reference_image: null,   // optional product reference photo (File)
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
function ProjectDetailModal({ project, onClose }) {
  return (
    <div className="ad-modal-overlay" onClick={onClose}>
      <div className="ad-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-header">
          <div>
            <h3>{project.name}</h3>
            <p className="ad-muted ad-small">{project.code} · {project.category || '—'}</p>
          </div>
          <button className="ad-modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="ad-modal-body">
          <div className="ad-modal-badges">
            <span className={`badge ${STATUS_CLS[project.status] || 'badge-gray'}`}>
              • {STATUS_LABEL[project.status] || project.status}
            </span>
          </div>

          {project.status === 'rejected' && project.rejectReason && (
            <div className="ad-modal-error"><AlertTriangle size={15} /> Reason: {project.rejectReason}</div>
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
            <Info2 label="Bid Submission Deadline" value={project.deadline} />
            <Info2 label="Expected Delivery" value={project.expectedDelivery} />
            <Info2 label="Delivery Location" value={project.deliveryLocation} />
            <Info2 label="Submitted" value={project.submittedAt} />
            <Info2 label="Description" value={project.description} full />
          </div>

          <div className="ad-docs-head"><FileText size={15} /> Procurement Documents</div>
          <div className="ad-docs-list">
            {project.documents.map(d => (
              <div className="ad-doc-row" key={d.key}>
                <div className="ad-doc-main">
                  <div className="ad-doc-name">
                    <span className="ad-bold">{d.label}</span>
                    <span className={d.required ? 'ad-req-tag' : 'ad-opt-tag'}>{d.required ? 'Required' : 'Optional'}</span>
                  </div>
                  {d.url
                    ? <a className="ad-doc-view" href={d.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> View</a>
                    : <span className="ad-doc-missing">Not uploaded</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="ad-modal-footer">
          <button className="ad-btn-cancel" onClick={onClose}>Close</button>
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
  const planning = projects.filter(p => ['draft', 'pending_head', 'rejected'].includes(p.status))

  const filtered = planning.filter(p => {
    const q = search.toLowerCase()
    return !q || p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q)
  })

  return (
    <div className="ad-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      {viewProject && <ProjectDetailModal project={viewProject} onClose={() => setViewProject(null)} />}
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

              <ReferenceImageUploader
                file={form.reference_image}
                onFile={onImage}
                onRemove={() => set('reference_image', null)}
              />

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

        <div className="ad-table-scroll">
        <table className="ad-table">
          <thead>
            <tr>
              <th>PROJECT TITLE</th><th>BUDGET</th><th>TYPE</th>
              <th>DEADLINE</th><th>STATUS</th><th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {loading && filtered.length === 0
              ? <TableSkeleton rows={4} cols={6} />
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
        <div className="ad-card-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', flexWrap: 'wrap', gap: 12 }}>
            <div className="ad-filter-pills">
              {TABS.map(t => (
                <button key={t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
              ))}
            </div>
            <button className="ad-btn-primary-sm" onClick={() => setShowRegisterForm(true)}>
              <Plus size={12} /> Register Supplier
            </button>
          </div>
          <div className="ad-search-inline">
            <Search size={14} />
            <input placeholder="Search by company or name" value={search} onChange={e => setSearch(e.target.value)} />
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

        <div className="ad-table-scroll">
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
    </div>
  )
}

// Walk-in supplier registration, filled out by the Admin on the supplier's
// behalf. Same fields/validation as the public self-registration form — only
// who fills it in differs. Opens as a modal so it never pushes the table down.
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
      <div className="ad-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 680 }}>
        <div className="ad-modal-header">
          <div>
            <h3>Assisted Supplier Registration</h3>
            <p className="ad-muted ad-small">
              For a supplier who came in person with physical documents — their account is created the
              same way as a self-registration and still needs your approval before they can bid.
            </p>
          </div>
          <button type="button" className="ad-modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="ad-modal-body">
          <div className="ad-filter-pills" style={{ marginBottom: 20 }}>
            {ASSISTED_STEPS.map((label, i) => (
              <span key={label} className={`ad-pill${i === step ? ' ad-pill-active' : ''}`} style={{ cursor: 'default' }}>
                {i + 1}. {label}
              </span>
            ))}
          </div>

          {error && <div className="ad-modal-error"><AlertTriangle size={15} /> {error}</div>}

          {step === 0 && (
            <div className="ad-form-grid">
              <div className="ad-form-group">
                <label>Full Name</label>
                <input value={form.full_name} onChange={e => set('full_name', e.target.value)} />
              </div>
              <div className="ad-form-group">
                <label>Email Address</label>
                <input type="email" value={form.email} onChange={e => set('email', e.target.value)} />
              </div>
              <div className="ad-form-group">
                <label>Password</label>
                <input type="password" value={form.password} onChange={e => set('password', e.target.value)} />
              </div>
              <div className="ad-form-group">
                <label>Confirm Password</label>
                <input type="password" value={form.confirm_password} onChange={e => set('confirm_password', e.target.value)} />
              </div>

              <div className="ad-form-group ad-form-full">
                <label>Company Name</label>
                <input value={form.company_name} onChange={e => set('company_name', e.target.value)} />
              </div>
              <div className="ad-form-group ad-form-full">
                <label>Company Address</label>
                <input value={form.company_address} onChange={e => set('company_address', e.target.value)} />
              </div>
              <div className="ad-form-group">
                <label>Phone Number</label>
                <input value={form.phone_number} onChange={e => set('phone_number', e.target.value.replace(/[^\d]/g, ''))} />
              </div>
              <div className="ad-form-group">
                <label>TIN</label>
                <input value={form.tin} onChange={e => set('tin', e.target.value.replace(/[^\d-]/g, ''))} />
              </div>
              <div className="ad-form-group ad-form-full">
                <label>Representative Name</label>
                <input value={form.representative_name} onChange={e => set('representative_name', e.target.value)} />
              </div>
              <div className="ad-form-group ad-form-full">
                <label>Business Type</label>
                <div className="ad-checks">
                  {CATEGORIES.map(t => (
                    <label key={t} className={types.includes(t) ? 'on' : ''}>
                      <input type="checkbox" checked={types.includes(t)} onChange={() => toggleType(t)} />
                      {t}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="ad-form-grid">
              <div className="ad-form-full">
                <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-dark)' }}>Required Documents</label>
                <div className="ad-muted ad-small" style={{ marginBottom: 10 }}>
                  Upload a clear scanned copy or photo of the document. Make sure the full document is readable.
                  PDF, JPG, or PNG · max 5 MB each.
                </div>
                <div className="ad-doc-grid">
                  {ASSISTED_REQUIRED_DOCS.map(d => (
                    <DocUploader key={d.key} doc={d} file={files[d.key]} onFile={onFile}
                      onRemove={() => removeFile(d.key)} />
                  ))}
                </div>
              </div>
              <div className="ad-form-group">
                <label>Mayor's Permit Expiry</label>
                <input type="date" value={form.mayors_permit_expiry} onChange={e => set('mayors_permit_expiry', e.target.value)} />
              </div>
              <div className="ad-form-group">
                <label>Tax Clearance Expiry</label>
                <input type="date" value={form.tax_clearance_expiry} onChange={e => set('tax_clearance_expiry', e.target.value)} />
              </div>
              <div className="ad-form-group">
                <label>Financial Statement Year</label>
                <input value={form.financial_statement_year}
                  onChange={e => set('financial_statement_year', e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
                  placeholder="e.g. 2026" />
              </div>

              <div className="ad-form-full">
                <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-dark)' }}>Optional Documents</label>
                <div className="ad-doc-grid">
                  {ASSISTED_OPTIONAL_DOCS.map(d => (
                    <DocUploader key={d.key} doc={d} file={files[d.key]} onFile={onFile}
                      onRemove={() => removeFile(d.key)} optional />
                  ))}
                </div>
              </div>
              <div className="ad-form-group ad-form-full">
                <label>Track Record Description</label>
                <textarea rows={2} value={form.track_record_description}
                  onChange={e => set('track_record_description', e.target.value)}
                  placeholder="Brief description of similar projects" />
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <p className="ad-small" style={{ lineHeight: 1.6 }}>
                Before submitting, confirm with the supplier (present in person) that all information and
                documents provided are true, accurate, and authentic. Any false statement or falsified
                document is grounds for disqualification.
              </p>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, fontWeight: 500, marginTop: 12 }}>
                <input type="checkbox" checked={form.declaration_accepted}
                  onChange={e => set('declaration_accepted', e.target.checked)} style={{ marginTop: 3 }} />
                <span>The supplier confirms the information and documents provided are true, accurate, and authentic to the best of their knowledge.</span>
              </label>
            </div>
          )}

          {step === 3 && (
            <div>
              <div className="ad-info-grid">
                <Info2 label="Company" value={form.company_name} />
                <Info2 label="Representative" value={form.representative_name} />
                <Info2 label="Email" value={form.email} />
                <Info2 label="Phone" value={form.phone_number} />
                <Info2 label="Required Docs Uploaded" value={`${requiredUploaded}/${ASSISTED_REQUIRED_DOCS.length}`} />
                <Info2 label="Optional Docs Uploaded" value={`${optionalUploaded}`} />
                <Info2 label="Status After Submission" value="Pending Verification" />
              </div>
              <p className="ad-muted ad-small" style={{ marginTop: 8 }}>
                The supplier account is created now and queued the same as any self-registration — review
                and approve it from this Suppliers list before they can bid.
              </p>
            </div>
          )}
        </div>

        <div className="ad-modal-footer">
          {step > 0
            ? <button type="button" className="ad-btn-cancel" onClick={back}>Back</button>
            : <button type="button" className="ad-btn-cancel" onClick={onClose}>Cancel</button>}
          {step < ASSISTED_STEPS.length - 1
            ? <button type="button" className="ad-btn-primary" onClick={next}>Continue</button>
            : <button type="button" className="ad-btn-primary" disabled={submitting} onClick={onSubmit}>
                {submitting ? 'Registering…' : 'Register Supplier'}
              </button>}
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
                <BusinessTypesInfo supplier={supplier} />
                <Info2 label="Registered" value={supplier.registered} />
                <Info2 label="Financial Year" value={supplier.financial_statement_year} />
              </div>

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
                    <XCircle size={14} /> Reject
                  </button>
                  <button className="ad-btn-revision" disabled={busy} onClick={handleRequestRevision}>
                    <AlertTriangle size={14} /> Request Revision
                  </button>
                  <button className="ad-btn-approve" disabled={busy} onClick={handleApprove}>
                    <Check size={14} /> Approve
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

// Shows every category the supplier registered for as chips (handles many).
function BusinessTypesInfo({ supplier }) {
  const types = supplierBusinessTypes(supplier)
  return (
    <div className="ad-info-item ad-info-full">
      <span className="ad-info-label">Business Types</span>
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
  const biddable = projects.filter(p => !['draft', 'pending_head', 'rejected'].includes(p.status))

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
      <div>
        <h2 className="ad-bids-title">Select a Project to Evaluate</h2>
        <p className="ad-bids-sub">Click a project below to review and evaluate submitted bids.</p>
      </div>

      <div className="ad-bids-toolbar">
        <div className="ad-search-inline">
          <Search size={14} />
          <input
            placeholder="Search by project name or code"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
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

      <div className="ad-filter-pills">
        {TABS.map(t => (
          <button key={t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
        ))}
      </div>

      {!loading && (
        <div className="ad-bids-count">
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
          ? <div className="ad-empty-msg">
              {biddable.length === 0
                ? 'No projects available for bidding yet.'
                : 'No projects match your search or filters.'}
            </div>
          : filtered.map(p => (
            <div className="ad-bid-card" key={p.id} onClick={() => navigate(`/admin/bids/${p.id}`)} role="button" tabIndex={0}>
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
        <span className={`badge badge-${row.decisionTone === 'gray' ? 'gray' : row.decisionTone === 'red' ? 'red' : 'green'}`}>
          {row.decision}{row.decisionAt ? ` · ${fmtDateTime(row.decisionAt)}` : ''}
        </span>
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
            <p className="ad-muted ad-small">{project.name} · {project.code}</p>
          </div>
          <button className="ad-modal-close" onClick={onClose}><X size={18} /></button>
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

// Full bid detail modal (admin evaluation) — opened by clicking a supplier's row.
// Shows every field, with images previewed inline so the admin doesn't have to
// download each one to check it.
function BidDetailModal({ bid, awarded, busyId, projectName, onQualify, onDisqualify, onMarkWinner, confirm, onConfirmWinner, onCancelConfirm, onClose }) {
  const files = collectBidFiles(bid)
  const images = files.filter(f => isImageFile(f.name))
  const docs = files.filter(f => !isImageFile(f.name))

  return (
    <div className="ad-modal-overlay" onClick={onClose}>
      <div className="ad-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-header">
          <div>
            <h3>{bid.supplier_name}</h3>
            <p className="ad-muted ad-small">{peso(bid.amount)} · Submitted {fmtDate(bid.submitted_at)}</p>
          </div>
          <button className="ad-modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="ad-modal-body">
          <div className="ad-modal-badges">
            <span className={`badge ${QUAL_BID_CLS[bid.status] || 'badge-gray'}`}>
              {bid.status === 'winner' ? '• Winning Bidder' : (QUAL_BID_LABEL[bid.status] || bid.status)}
            </span>
          </div>

          <div className="ad-info-grid">
            <Info2 label="Delivery Timeline" value={bid.delivery_timeline} />
            {bid.brand_name && <Info2 label="Brand Name" value={bid.brand_name} />}
            {bid.model_number && <Info2 label="Model Number" value={bid.model_number} />}
            {bid.additional_comments && <Info2 label="Additional Comments" value={bid.additional_comments} full />}
          </div>

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
                  <a key={i} className="ad-doc-row" href={f.url} target="_blank" rel="noreferrer">
                    <span className="ad-doc-check"><Check size={12} /></span>
                    <span className="ad-doc-name" title={f.name}>{f.name}</span>
                    <span className="ad-doc-tag-mini">{f.label}</span>
                    <span className="ad-doc-view"><ExternalLink size={12} /> View</span>
                  </a>
                ))}
              </div>
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
          {bid.status !== 'winner' && !awarded && (
            <div className="ad-modal-footer-actions">
              {bid.status !== 'qualified' && (
                <button className="ad-btn-approve" disabled={busyId === bid.id} onClick={() => onQualify(bid)}>
                  <Check size={14} /> Qualify
                </button>
              )}
              {bid.status !== 'disqualified' && (
                <button className="ad-btn-reject" disabled={busyId === bid.id} onClick={() => onDisqualify(bid)}>
                  <XCircle size={14} /> Disqualify
                </button>
              )}
              {bid.status === 'qualified' && (
                <button className="ad-btn-publish" disabled={busyId === bid.id} onClick={() => onMarkWinner(bid)}>
                  <Award size={14} /> Mark as Winner
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
  const current = evalStepIndex(status, bids)
  return (
    <div className="ad-stepper">
      {EVAL_STEPS.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : ''
        return (
          <div className={`ad-step ${state}`} key={label}>
            <div className="ad-step-dot">{i < current ? <Check size={15} /> : i + 1}</div>
            <div className="ad-step-label">{label}</div>
          </div>
        )
      })}
    </div>
  )
}

// ── Bid evaluation detail page (admin) — /admin/bids/:id ───────────────────────
function BidEvaluationPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [project, setProject] = useState(null)
  const [bids, setBids] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [confirm, setConfirm] = useState(null)   // { bid }
  const [toast, setToast] = useState(null)
  const [viewBid, setViewBid] = useState(null)   // bid shown in the detail modal
  const [showTimeline, setShowTimeline] = useState(false)

  const load = () => {
    setLoading(true)
    Promise.all([apiGetProject(id), apiListProjectBids(id)])
      .then(([proj, bidList]) => { setProject(proj); setBids(bidList) })
      .catch(() => setToast({ type: 'error', message: 'Could not load this procurement.' }))
      .finally(() => setLoading(false))
  }
  useEffect(load, [id])

  // Keep the open detail modal in sync with the bid's latest status after an action.
  useEffect(() => {
    if (!viewBid) return
    const updated = bids.find(b => b.id === viewBid.id)
    if (updated && updated !== viewBid) setViewBid(updated)
  }, [bids])

  const awarded = project?.status === 'awarded'

  const act = async (bid, fn, errMsg) => {
    setBusyId(bid.id)
    try { await fn(bid.id); load() }
    catch (e) { setToast({ type: 'error', message: e.message || errMsg }) }
    finally { setBusyId(null) }
  }

  const confirmWinner = async () => {
    const bid = confirm.bid
    setBusyId(bid.id); setConfirm(null)
    try {
      await apiSelectWinner(bid.id)
      await load()
      refreshProjects()  // the project is now Awarded — refresh the shared store
      setToast({ type: 'success', message: `${bid.supplier_name} selected as the winning bidder.` })
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
        <ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} /> Back to projects
      </button>

      {loading && !project ? (
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
        <div className="ad-card"><div className="ad-empty-row">Procurement not found.</div></div>
      ) : (
        <>
          <div className="ad-card" style={{ padding: '20px 24px' }}>
            <div className="ad-eval-head-row">
              <div>
                <h2 style={{ margin: 0 }}>{project.name}</h2>
                <p className="ad-muted ad-small" style={{ marginTop: 4 }}>
                  {project.code} · {project.category || '—'} · ABC {peso(project.budget)}
                </p>
              </div>
              <button className="ad-btn-timeline" onClick={() => setShowTimeline(true)}>
                <Clock size={14} /> View Timeline
              </button>
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
              {awarded && <span className="badge badge-awarded">• Awarded</span>}
            </div>
            <table className="ad-table">
              <thead>
                <tr><th>SUPPLIER</th><th>BID AMOUNT</th><th>SUBMITTED</th><th>QUALIFICATION STATUS</th><th>ACTIONS</th></tr>
              </thead>
              <tbody>
                {loading
                  ? <TableSkeleton rows={3} cols={5} />
                  : bids.length === 0
                  ? <tr><td colSpan={5} className="ad-empty-row">No bids submitted yet.</td></tr>
                  : bids.map(b => (
                    <tr key={b.id} className="ad-bid-row" onClick={() => setViewBid(b)}>
                      <td className="ad-bold ad-bid-supplier-cell">{b.supplier_name}</td>
                      <td>{peso(b.amount)}</td>
                      <td className="ad-muted">{fmtDate(b.submitted_at)}</td>
                      <td>
                        <span className={`badge ${QUAL_BID_CLS[b.status] || 'badge-gray'}`}>
                          {QUAL_BID_LABEL[b.status] || b.status}
                        </span>
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        {b.status === 'winner' ? (
                          <span className="badge badge-awarded">• Winning Bidder</span>
                        ) : awarded ? (
                          <span className="ad-muted ad-small">—</span>
                        ) : (
                          <button className="ad-btn-review" onClick={() => setViewBid(b)}>
                            <Eye size={12} /> Review
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        </>
      )}

      {viewBid && (
        <BidDetailModal
          bid={viewBid}
          awarded={awarded}
          busyId={busyId}
          projectName={project.name}
          onQualify={(b) => act(b, apiQualifyBid, 'Could not qualify.')}
          onDisqualify={(b) => act(b, apiDisqualifyBid, 'Could not disqualify.')}
          onMarkWinner={(b) => setConfirm({ bid: b })}
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

function AwardsPage() {
  const [awards, setAwards] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    apiListAwards()
      .then(setAwards)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = awards.filter(a => {
    const q = search.toLowerCase()
    return !q || a.supplier_name.toLowerCase().includes(q) || a.project_name.toLowerCase().includes(q)
  })

  const totalAmount = awards.reduce((sum, a) => sum + Number(a.amount || 0), 0)

  return (
    <div className="ad-content">
      <div className="ad-stats">
        <div className="ad-stat-card">
          <div className="ad-stat-label">TOTAL AWARDS</div>
          <div className="ad-stat-value ad-val-green">{awards.length}</div>
        </div>
        <div className="ad-stat-card">
          <div className="ad-stat-label">TOTAL AWARDED AMOUNT</div>
          <div className="ad-stat-value ad-val-blue">{peso(totalAmount)}</div>
        </div>
        <div className="ad-stat-card">
          <div className="ad-stat-label">DOCUMENTS AVAILABLE</div>
          <div className="ad-stat-value ad-val-purple">{awards.length * 3}</div>
        </div>
        <div className="ad-stat-card">
          <div className="ad-stat-label">LATEST AWARD DATE</div>
          <div className="ad-stat-value ad-val-yellow" style={{ fontSize: 18 }}>{fmtDate(awards[0]?.awarded_at)}</div>
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
            {loading ? (
              <TableSkeleton rows={3} cols={6} />
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="ad-empty-msg">No awards yet.</td></tr>
            ) : filtered.map(a => (
              <tr key={a.id}>
                <td className="ad-bold">{a.supplier_name}</td>
                <td>{a.project_name}</td>
                <td className="ad-bold">{peso(a.amount)}</td>
                <td className="ad-muted">{fmtDate(a.awarded_at)}</td>
                <td><span className={`badge ${a.status === 'won' ? 'badge-green' : 'badge-gray'}`}>• {a.status === 'won' ? 'WON' : 'CANCELLED'}</span></td>
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
          <button
            className="ad-btn-export-csv"
            onClick={() => exportReportCSV(activeReport, `${reportTab}-report-${new Date().toISOString().slice(0, 10)}.csv`)}
          >Export CSV</button>
          <button
            className="ad-btn-primary"
            onClick={() => exportReportPDF(activeReport, `${reportTab}-report-${new Date().toISOString().slice(0, 10)}.pdf`)}
          >Export PDF</button>
        </div>
      </div>

      {reportTab === 'procurement' && (
        <>
          <div className="ad-report-stats">
            {procurementStats.map(({ label, value, cls }) => (
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
                {Object.keys(typeCount).length === 0 ? (
                  <tr><td colSpan={2} className="ad-empty-msg">No data yet.</td></tr>
                ) : Object.entries(typeCount).map(([type, count]) => (
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
                {awards.length === 0 ? (
                  <tr><td colSpan={4} className="ad-empty-msg">No awards yet.</td></tr>
                ) : awards.map(a => (
                  <tr key={a.id}>
                    <td>{a.project_name}</td>
                    <td>{a.supplier_name}</td>
                    <td className="ad-bold">{peso(a.amount)}</td>
                    <td className="ad-muted">{fmtDate(a.awarded_at)}</td>
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
                <div className={`ad-stat-value ${cls}`} style={{ fontSize: 22 }}>{value}</div>
              </div>
            ))}
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>By Business Category</h2></div>
            <table className="ad-table">
              <thead><tr><th>CATEGORY</th><th>SUPPLIERS</th></tr></thead>
              <tbody>
                {Object.keys(categoryCount).length === 0 ? (
                  <tr><td colSpan={2} className="ad-empty-msg">No data yet.</td></tr>
                ) : Object.entries(categoryCount).map(([cat, count]) => (
                  <tr key={cat}><td>{cat}</td><td>{count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>Supplier Directory</h2></div>
            <table className="ad-table">
              <thead>
                <tr>
                  <th>COMPANY</th><th>QUALIFICATION STATUS</th><th>REGISTERED</th>
                  <th>CONTRACTS WON</th><th>AWARDED AMOUNT</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.length === 0 ? (
                  <tr><td colSpan={5} className="ad-empty-msg">No suppliers yet.</td></tr>
                ) : suppliers.map(s => (
                  <tr key={s.id}>
                    <td className="ad-bold">{s.company}</td>
                    <td>
                      <span className={`badge ${QUAL_CLS[s.qualification_status] || 'badge-gray'}`}>
                        {QUAL_LABEL[s.qualification_status] || (s.qualification_status || '').replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="ad-muted">{fmtDate(s.registered)}</td>
                    <td>{supplierAwardStats[s.id]?.count || 0}</td>
                    <td className="ad-bold">{peso(supplierAwardStats[s.id]?.amount || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const loc = useLocation()
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

  return (
    <div className="ad-layout">
      <Sidebar active={loc.pathname} open={navOpen} onClose={() => setNavOpen(false)} />
      {navOpen && <div className="ad-nav-backdrop" onClick={() => setNavOpen(false)} />}
      <div className="ad-main">
        <Header title={title} onMenu={() => setNavOpen(true)} />
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
    </div>
  )
}
