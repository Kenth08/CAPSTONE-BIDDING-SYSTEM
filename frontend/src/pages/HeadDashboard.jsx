import { useState, useEffect } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Clock, CheckCircle2, XCircle,
  Search, ChevronDown, ChevronRight, LogOut,
  ClipboardCheck, AlertCircle, FolderOpen, Eye,
  ThumbsUp, ThumbsDown, FileText, Menu, X
} from 'lucide-react'
import { clearSession } from '../api'
import {
  useProjects, approveProject as storeApprove, rejectProject as storeReject,
  isReviewed, decisionOf,
} from '../store/projectsStore'
import { Skeleton, TableSkeleton, ListSkeleton } from '../components/Skeleton'
import NotificationBell from '../components/NotificationBell'
import '../style/HeadDashboard.css'

const NAV = [
  { icon: LayoutDashboard, label: 'Dashboard', to: '/head' },
  { icon: Clock, label: 'Pending Approval', to: '/head/pending' },
  { icon: CheckCircle2, label: 'Reviewed Projects', to: '/head/approved' },
]

function Sidebar({ active, open, onClose }) {
  const navigate = useNavigate()
  return (
    <aside className={`hd-sidebar${open ? ' open' : ''}`}>
      <div className="hd-sidebar-logo">
        <span className="hd-logo-icon"><ClipboardCheck size={16} /></span>
        <div>
          <div className="hd-logo-name">E-Procurement</div>
          <div className="hd-logo-sub">Head Workspace</div>
        </div>
      </div>
      <div className="hd-menu-section">
        <span className="hd-menu-label">MENU</span>
        <nav className="hd-sidebar-nav">
          {NAV.map(({ icon: Icon, label, to }) => (
            <Link key={to} to={to} className={`hd-nav-item${active === to ? ' active' : ''}`} onClick={onClose}>
              <Icon size={18} /><span>{label}</span>
              {active === to && <span className="hd-nav-dot" />}
            </Link>
          ))}
        </nav>
      </div>
      <div className="hd-sidebar-footer">
        <div className="hd-sidebar-user">
          <div className="hd-sidebar-avatar">H</div>
          <div className="hd-sidebar-user-info">
            <span className="hd-sidebar-user-name">School Head</span>
            <span className="hd-sidebar-user-email">head@district.edu.ph</span>
          </div>
          <button
            className="hd-sidebar-expand"
            onClick={() => { clearSession(); navigate('/login') }}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </aside>
  )
}

function Header({ title, onMenu }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <header className="hd-header">
      <div className="hd-header-left">
        <button className="hd-menu-btn" onClick={onMenu} aria-label="Open menu"><Menu size={20} /></button>
        <div>
          <div className="hd-workspace-label">HEAD WORKSPACE</div>
          <h1 className="hd-page-title">{title}</h1>
        </div>
      </div>
      <div className="hd-header-right">
        <div className="hd-search"><Search size={15} /><input placeholder="Search…" /></div>
        <NotificationBell />
        <div className="hd-user-wrap">
          <div className="hd-user" onClick={() => setOpen(o => !o)}>
            <div className="hd-avatar">H</div>
            <div className="hd-user-info">
              <span className="hd-user-name">School Head</span>
              <span className="hd-user-role">Department Head</span>
            </div>
            <ChevronDown size={14} color="#64748b" />
          </div>
          {open && (
            <>
              <div className="hd-dropdown-backdrop" onClick={() => setOpen(false)} />
              <div className="hd-dropdown">
                <div className="hd-dropdown-header">
                  <div className="hd-avatar">H</div>
                  <div>
                    <div className="hd-dropdown-name">School Head</div>
                    <div className="hd-dropdown-email">head@district.edu.ph</div>
                  </div>
                </div>
                <div className="hd-dropdown-divider" />
                <button className="hd-dropdown-item hd-dropdown-logout" onClick={() => { clearSession(); navigate('/login') }}>
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

// Brief confirmation banner shown after the Head approves/rejects a project
// (auto-dismisses). Mirrors the toast used on the Admin dashboard.
function Toast({ type, message, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000)
    return () => clearTimeout(t)
  }, [onClose])
  return (
    <div className={`hd-toast hd-toast-${type}`} role="status">
      {type === 'success' ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
      <span>{message}</span>
      <button onClick={onClose} aria-label="Dismiss"><X size={15} /></button>
    </div>
  )
}

function PendingCard({ project, onApprove, onReject }) {
  const [expanded, setExpanded] = useState(false)
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const handleApprove = async () => {
    setBusy(true); setErr('')
    // On success the card disappears (project leaves the pending list).
    try { await onApprove(project.id) } catch (e) { setErr(e.message || 'Could not approve.'); setBusy(false) }
  }

  const handleReject = async (e) => {
    e.preventDefault()
    setBusy(true); setErr('')
    try { await onReject(project.id, rejectReason); setShowRejectForm(false) }
    catch (e2) { setErr(e2.message || 'Could not reject.'); setBusy(false) }
  }

  return (
    <div className="hd-pending-card">
      <div className="hd-pending-card-top">
        <div className="hd-proj-icon"><FolderOpen size={16} /></div>
        <div className="hd-pending-info">
          <div className="hd-bold">{project.name}</div>
          <div className="hd-muted" style={{ fontSize: 12 }}>{project.code} · {project.type} · Submitted {project.submittedAt}</div>
        </div>
        <div className="hd-pending-meta">
          <span className="hd-bold" style={{ fontSize: 16 }}>{project.budget}</span>
          <span className="hd-muted" style={{ fontSize: 12 }}>Due {project.deadline}</span>
        </div>
        <div className="hd-pending-actions">
          <button className="hd-btn-expand" onClick={() => setExpanded(e => !e)}>
            <Eye size={13} /> {expanded ? 'Hide' : 'Details'}
          </button>
          <button className="hd-btn-approve" onClick={handleApprove} disabled={busy}>
            <ThumbsUp size={13} /> {busy ? 'Working…' : 'Approve'}
          </button>
          <button className="hd-btn-reject-sm" onClick={() => setShowRejectForm(s => !s)} disabled={busy}>
            <ThumbsDown size={13} /> Reject
          </button>
        </div>
      </div>

      {err && <div className="hd-muted" style={{ color: '#ef4444', fontSize: 12, padding: '0 16px 10px' }}>{err}</div>}

      {expanded && (
        <div className="hd-pending-desc">
          <p className="hd-muted" style={{ fontSize: 13, lineHeight: 1.6 }}>{project.description}</p>
          <div className="hd-pending-desc-meta">
            <div><span className="hd-label">Category</span><span>{project.category || '—'}</span></div>
            <div><span className="hd-label">Procurement Type</span><span>{project.type}</span></div>
            <div><span className="hd-label">Approved Budget (ABC)</span><strong>{project.budget}</strong></div>
            <div><span className="hd-label">Delivery Location</span><span>{project.deliveryLocation || '—'}</span></div>
            <div><span className="hd-label">Bid Submission Deadline</span><span>{project.deadline}</span></div>
            <div><span className="hd-label">Expected Delivery</span><span>{project.expectedDelivery || '—'}</span></div>
            <div><span className="hd-label">Submitted</span><span>{project.submittedAt}</span></div>
          </div>

          {project.documents?.length > 0 && (
            <div className="hd-doc-review">
              <span className="hd-label">Procurement Documents</span>
              <div className="hd-doc-links">
                {project.documents.map(d => (
                  d.url ? (
                    <a key={d.key} href={d.url} target="_blank" rel="noopener noreferrer" className="hd-doc-link">
                      <FileText size={13} /> {d.label}
                    </a>
                  ) : (
                    <span key={d.key} className="hd-doc-link hd-doc-missing">
                      <FileText size={13} /> {d.label} — not provided
                    </span>
                  )
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {showRejectForm && (
        <form className="hd-reject-form" onSubmit={handleReject}>
          <label className="hd-label">Reason for rejection (optional)</label>
          <textarea
            placeholder="Explain why this project is being rejected…"
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            rows={3}
          />
          <div className="hd-reject-form-actions">
            <button type="button" className="hd-btn-cancel" onClick={() => setShowRejectForm(false)}>Cancel</button>
            <button type="submit" className="hd-btn-reject-confirm" disabled={busy}>
              {busy ? 'Working…' : 'Confirm Rejection'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

function HeadHome() {
  const { projects, loading } = useProjects()
  const [toast, setToast] = useState(null)
  const pending = projects.filter(p => p.status === 'pending_head')
  const approved = projects.filter(isReviewed)
  // Capture the project name BEFORE awaiting — once approved/rejected it leaves
  // the pending list. Errors still bubble up so PendingCard shows them inline.
  const onApprove = async (id) => {
    const proj = projects.find(p => p.id === id)
    await storeApprove(id)
    setToast({ type: 'success', message: `"${proj?.name}" approved — sent back to Admin to be published for bidding.` })
  }
  const onReject = async (id, reason) => {
    const proj = projects.find(p => p.id === id)
    await storeReject(id, reason)
    setToast({ type: 'success', message: `"${proj?.name}" was rejected.` })
  }
  return (
    <div className="hd-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div className="hd-stats">
        {[
          { label: 'Pending Your Review', value: String(pending.length), icon: Clock, color: 'yellow' },
          { label: 'Approved by You', value: String(approved.filter(p => decisionOf(p) === 'approved').length), icon: CheckCircle2, color: 'green' },
          { label: 'Rejected', value: String(approved.filter(p => decisionOf(p) === 'rejected').length), icon: XCircle, color: 'red' },
          { label: 'Total Reviewed', value: String(approved.length), icon: ClipboardCheck, color: 'blue' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div className={`hd-stat-card hd-stat-${color}`} key={label}>
            <div className="hd-stat-top">
              <span className="hd-stat-label">{label}</span>
              <div className={`hd-stat-icon hd-icon-${color}`}><Icon size={17} /></div>
            </div>
            <div className="hd-stat-value">{value}</div>
          </div>
        ))}
      </div>

      {pending.length > 0 && (
        <div className="hd-alert-card">
          <div className="hd-alert-header">
            <AlertCircle size={18} className="hd-alert-icon" />
            <div>
              <div className="hd-alert-title">Action Required</div>
              <div className="hd-alert-sub">You have {pending.length} project{pending.length > 1 ? 's' : ''} waiting for your approval</div>
            </div>
            <Link to="/head/pending" className="hd-btn-review">Review Now</Link>
          </div>
        </div>
      )}

      <div className="hd-card">
        <div className="hd-card-header">
          <div>
            <h2>Pending Approval</h2>
            <p>Projects submitted by Admin for your review — approve or reject below</p>
          </div>
          <Link to="/head/pending" className="hd-view-all">View all →</Link>
        </div>
        {loading && pending.length === 0 ? (
          <div style={{ padding: '8px 4px' }}><ListSkeleton rows={2} height={70} /></div>
        ) : pending.length === 0 ? (
          <div className="hd-empty">
            <CheckCircle2 size={32} className="hd-empty-icon" />
            <p>No projects pending your approval — all caught up!</p>
          </div>
        ) : (
          <div className="hd-pending-list">
            {pending.map(p => (
              <PendingCard key={p.id} project={p} onApprove={onApprove} onReject={onReject} />
            ))}
          </div>
        )}
      </div>

      <div className="hd-card">
        <div className="hd-card-header">
          <div><h2>Recently Reviewed</h2><p>Projects you've approved or rejected</p></div>
          <Link to="/head/approved" className="hd-view-all">View all →</Link>
        </div>
        <div className="hd-table-wrap">
          <table className="hd-table">
            <thead>
              <tr><th>ID</th><th>Project Name</th><th>Budget</th><th>Category</th><th>Reviewed On</th><th>Decision</th></tr>
            </thead>
            <tbody>
              {approved.slice(0, 4).map(p => (
                <tr key={p.id}>
                  <td className="hd-id">{p.code}</td>
                  <td className="hd-bold">{p.name}</td>
                  <td>{p.budget}</td>
                  <td><span className="badge badge-gray">{p.type}</span></td>
                  <td className="hd-muted">{p.reviewedAt}</td>
                  <td>
                    <span className={`badge ${decisionOf(p) === 'approved' ? 'badge-green' : 'badge-red'}`}>
                      {decisionOf(p) === 'approved' ? 'Approved' : 'Rejected'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function PendingPage() {
  const { projects, loading } = useProjects()
  const [toast, setToast] = useState(null)
  const pending = projects.filter(p => p.status === 'pending_head')
  // Capture the project name BEFORE awaiting — once approved/rejected it leaves
  // the pending list. Errors still bubble up so PendingCard shows them inline.
  const onApprove = async (id) => {
    const proj = projects.find(p => p.id === id)
    await storeApprove(id)
    setToast({ type: 'success', message: `"${proj?.name}" approved — sent back to Admin to be published for bidding.` })
  }
  const onReject = async (id, reason) => {
    const proj = projects.find(p => p.id === id)
    await storeReject(id, reason)
    setToast({ type: 'success', message: `"${proj?.name}" was rejected.` })
  }
  return (
    <div className="hd-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div className="hd-card">
        <div className="hd-card-header">
          <div>
            <h2>Pending Approval</h2>
            <p>Review each project carefully. Approved projects will go back to Admin to be published for supplier bidding.</p>
          </div>
          <span className={`badge ${pending.length > 0 ? 'badge-yellow' : 'badge-green'}`}>
            {pending.length > 0 ? `${pending.length} pending` : 'All clear'}
          </span>
        </div>
        {loading && pending.length === 0 ? (
          <div style={{ padding: '8px 4px' }}><ListSkeleton rows={2} height={70} /></div>
        ) : pending.length === 0 ? (
          <div className="hd-empty">
            <CheckCircle2 size={40} className="hd-empty-icon" />
            <h3>All caught up!</h3>
            <p>No projects are waiting for your approval right now.</p>
          </div>
        ) : (
          <div className="hd-pending-list" style={{ padding: '16px 24px' }}>
            {pending.map(p => (
              <PendingCard key={p.id} project={p} onApprove={onApprove} onReject={onReject} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const REVIEW_TABS = ['All', 'Approved', 'Rejected']

function ApprovedPage() {
  const { projects, loading } = useProjects()
  const [tab, setTab] = useState('All')
  const reviewed = projects.filter(isReviewed)
  const approvedCount = reviewed.filter(p => decisionOf(p) === 'approved').length
  const rejectedCount = reviewed.filter(p => decisionOf(p) === 'rejected').length

  // Apply the active filter tab.
  const filtered = reviewed.filter(p =>
    tab === 'Approved' ? decisionOf(p) === 'approved' :
    tab === 'Rejected' ? decisionOf(p) === 'rejected' : true
  )

  const tabCount = (t) => t === 'Approved' ? approvedCount : t === 'Rejected' ? rejectedCount : reviewed.length

  return (
    <div className="hd-content">
      <div className="hd-card">
        <div className="hd-card-header">
          <div>
            <h2>Reviewed Projects</h2>
            <p>All projects you have approved or rejected</p>
          </div>
          <span className="badge badge-green">{approvedCount} approved</span>
        </div>

        <div className="hd-filter-pills">
          {REVIEW_TABS.map(t => (
            <button
              key={t}
              className={`hd-pill${tab === t ? ' hd-pill-active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t} <span className="hd-pill-count">{tabCount(t)}</span>
            </button>
          ))}
        </div>

        {loading && reviewed.length === 0 ? (
          <div className="hd-empty"><p>Loading projects…</p></div>
        ) : filtered.length === 0 ? (
          <div className="hd-empty">
            <FolderOpen size={36} className="hd-empty-icon" />
            <p>{reviewed.length === 0 ? 'No reviewed projects yet.' : `No ${tab.toLowerCase()} projects.`}</p>
          </div>
        ) : (
          <div className="hd-table-wrap">
            <table className="hd-table">
              <thead>
                <tr><th>ID</th><th>Project Name</th><th>Category</th><th>Budget</th><th>Deadline</th><th>Reviewed On</th><th>Decision</th></tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id}>
                    <td className="hd-id">{p.code}</td>
                    <td className="hd-bold">{p.name}</td>
                    <td><span className="badge badge-gray">{p.type}</span></td>
                    <td>{p.budget}</td>
                    <td className="hd-muted">{p.deadline}</td>
                    <td className="hd-muted">{p.reviewedAt}</td>
                    <td>
                      <span className={`badge ${decisionOf(p) === 'approved' ? 'badge-green' : 'badge-red'}`}>
                        {decisionOf(p) === 'approved' ? 'Approved' : 'Rejected'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default function HeadDashboard() {
  const loc = useLocation()
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => { setNavOpen(false) }, [loc.pathname])

  const PAGE_TITLES = {
    '/head': 'Dashboard',
    '/head/pending': 'Pending Approval',
    '/head/approved': 'Reviewed Projects',
  }

  return (
    <div className="hd-layout">
      <Sidebar active={loc.pathname} open={navOpen} onClose={() => setNavOpen(false)} />
      {navOpen && <div className="hd-nav-backdrop" onClick={() => setNavOpen(false)} />}
      <div className="hd-main">
        <Header title={PAGE_TITLES[loc.pathname] || 'Dashboard'} onMenu={() => setNavOpen(true)} />
        <div className="hd-body">
          <Routes>
            <Route index element={<HeadHome />} />
            <Route path="pending" element={<PendingPage />} />
            <Route path="approved" element={<ApprovedPage />} />
            <Route path="*" element={<HeadHome />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
