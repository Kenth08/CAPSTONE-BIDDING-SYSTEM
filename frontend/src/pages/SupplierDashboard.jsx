import { useState, useEffect, useRef } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, FileText, Clock, CheckCircle2,
  Building2, Bell, Search, ChevronDown, ChevronRight, LogOut, Settings,
  Eye, ArrowRight, Shield, User, X, Send, Trophy, Trash2,
  AlertTriangle, Upload, Lock
} from 'lucide-react'
import {
  clearSession, apiGetMySupplier, apiResubmitDocuments,
  apiListProjects, apiListMyBids, apiSubmitBid, apiWithdrawBid,
  apiListNotifications, apiMarkNotificationsRead,
} from '../api'
import '../style/SupplierDashboard.css'

// API → UI mapping (backend uses code/decimal/ISO; the UI shows ₱ + dates).
const fmtDate = (v) => v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
const fmtPeso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH')
const parseAmount = (s) => Number(String(s).replace(/[^\d.]/g, '')) || 0
const mapProject = (p) => ({
  id: p.code, pk: p.id, name: p.name, budget: fmtPeso(p.budget),
  deadline: fmtDate(p.deadline), category: p.category, description: p.description,
})
const mapBid = (b) => ({
  id: b.id, project: b.project_name, projectId: b.project_code,
  amount: fmtPeso(b.amount), submitted: fmtDate(b.submitted_at), status: b.status, notes: b.notes,
})

// File rules mirror the registration form.
const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png']
const MAX_MB = 5
function validateFile(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (!ALLOWED_EXT.includes(ext)) return `Unsupported type ".${ext}". Use PDF, JPG, or PNG.`
  if (file.size > MAX_MB * 1024 * 1024) return `File is too large (max ${MAX_MB} MB).`
  return null
}

const QUAL_STATUS = {
  waiting_admin_approval: { label: 'Pending Review', tone: 'pending', text: 'Your registration is awaiting admin verification. You can browse projects, but bidding unlocks once approved.' },
  needs_revision:         { label: 'Action Required', tone: 'revision', text: 'The admin needs you to fix the documents below, then resubmit for review.' },
  verified:               { label: 'Approved', tone: 'approved', text: 'Your account is verified. You can submit bids on open projects.' },
  rejected:               { label: 'Rejected', tone: 'rejected', text: 'Your registration was rejected. See the message below.' },
}

const NAV = [
  { icon: LayoutDashboard, label: 'Dashboard',  to: '/supplier' },
  { icon: FolderOpen,      label: 'Projects',   to: '/supplier/projects' },
  { icon: FileText,        label: 'My Bids',    to: '/supplier/bids' },
  { icon: Clock,           label: 'Status',     to: '/supplier/status' },
  { icon: Settings,        label: 'Profile',    to: '/supplier/profile' },
]

const BID_STATUS = {
  submitted:    'badge-yellow',
  under_review: 'badge-blue',
  shortlisted:  'badge-green',
  qualified:    'badge-green',
  winner:       'badge-purple',
  won:          'badge-purple',
  disqualified: 'badge-red',
  rejected:     'badge-red',
  lost:         'badge-red',
}

// ─── Bid submit modal ────────────────────────────────────────────────────────

function BidModal({ project, onClose, onSubmit }) {
  const [form, setForm] = useState({ amount: '', notes: '' })
  const [error, setError] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    const raw = form.amount.replace(/[^0-9.]/g, '')
    if (!raw || isNaN(Number(raw))) { setError('Enter a valid bid amount (e.g. ₱850,000)'); return }
    onSubmit(project, form)
    onClose()
  }

  return (
    <div className="sd-modal-overlay" onClick={onClose}>
      <div className="sd-modal" onClick={e => e.stopPropagation()}>
        <div className="sd-modal-header">
          <div>
            <h3>Submit Bid</h3>
            <p className="sd-muted sd-small">{project.id} · {project.name}</p>
          </div>
          <button className="sd-modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="sd-modal-meta">
          <div><span>Budget</span><strong>{project.budget}</strong></div>
          <div><span>Deadline</span><strong>{project.deadline}</strong></div>
          <div><span>Category</span><strong>{project.category}</strong></div>
        </div>
        <form onSubmit={handleSubmit} className="sd-modal-form">
          <div className="sd-form-group">
            <label>Your Bid Amount</label>
            <input
              type="text"
              placeholder="e.g. ₱850,000"
              value={form.amount}
              onChange={e => { setForm({ ...form, amount: e.target.value }); setError('') }}
              required
            />
            {error && <span className="sd-field-error">{error}</span>}
          </div>
          <div className="sd-form-group">
            <label>Notes / Proposal Summary</label>
            <textarea
              placeholder="Briefly describe your approach, timeline, and qualifications…"
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              rows={4}
              required
            />
          </div>
          <div className="sd-modal-footer">
            <button type="button" className="sd-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="sd-btn-primary">
              <Send size={14} /> Submit Bid
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Bid detail modal ────────────────────────────────────────────────────────

function BidDetailModal({ bid, onClose, onWithdraw }) {
  return (
    <div className="sd-modal-overlay" onClick={onClose}>
      <div className="sd-modal" onClick={e => e.stopPropagation()}>
        <div className="sd-modal-header">
          <div>
            <h3>Bid Details</h3>
            <p className="sd-muted sd-small">{bid.project}</p>
          </div>
          <button className="sd-modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="sd-modal-meta">
          <div><span>Amount</span><strong>{bid.amount}</strong></div>
          <div><span>Submitted</span><strong>{bid.submitted}</strong></div>
          <div><span>Status</span><strong><span className={`badge ${BID_STATUS[bid.status] || 'badge-yellow'}`}>{bid.status.replace('_', ' ')}</span></strong></div>
        </div>
        <div className="sd-detail-notes">
          <span className="sd-detail-label">Proposal Notes</span>
          <p>{bid.notes || 'No notes provided.'}</p>
        </div>
        <div className="sd-modal-footer">
          {(bid.status === 'submitted' || bid.status === 'under_review') && (
            <button
              type="button"
              className="sd-btn-withdraw"
              onClick={() => { onWithdraw(); onClose() }}
            >
              <Trash2 size={14} /> Withdraw Bid
            </button>
          )}
          <button type="button" className="sd-btn-cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ─── Verification banner + revision panel ────────────────────────────────────

function SupplierToast({ type, message, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000)
    return () => clearTimeout(t)
  }, [onClose])
  return (
    <div className={`sd-toast sd-toast-${type}`} role="status">
      {type === 'error' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
      <span>{message}</span>
    </div>
  )
}

function VerificationBanner({ profile }) {
  if (!profile) return null
  const info = QUAL_STATUS[profile.qualification_status]
  if (!info || info.tone === 'approved') return null  // hide when verified
  return (
    <div className={`sd-verify-banner sd-verify-${info.tone}`}>
      <div className="sd-verify-icon">
        {info.tone === 'rejected' ? <X size={18} /> : info.tone === 'revision' ? <AlertTriangle size={18} /> : <Clock size={18} />}
      </div>
      <div className="sd-verify-text">
        <span className="sd-bold">{info.label}</span>
        <span className="sd-muted sd-small">{info.text}</span>
        {profile.admin_notes && <span className="sd-verify-note">“{profile.admin_notes}”</span>}
      </div>
    </div>
  )
}

// Lists the documents the admin flagged and lets the supplier re-upload + resubmit.
function RevisionPanel({ profile, onResubmitted, setToast }) {
  const flagged = (profile?.documents || []).filter(d => d.review_status === 'needs_revision')
  const [files, setFiles] = useState({})  // { key: File }
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const refs = useRef({})

  if (profile?.qualification_status !== 'needs_revision' || flagged.length === 0) return null

  const onFile = (key, file) => {
    if (!file) return
    const msg = validateFile(file)
    if (msg) { setToast({ type: 'error', message: `${key.replace(/_/g, ' ')}: ${msg}` }); return }
    setFiles(f => ({ ...f, [key]: file }))
  }

  const allReplaced = flagged.every(d => files[d.key])

  const doResubmit = async () => {
    setBusy(true)
    try {
      const fd = new FormData()
      Object.entries(files).forEach(([k, file]) => fd.append(k, file))
      await apiResubmitDocuments(fd)
      setToast({ type: 'success', message: 'Documents resubmitted. Your account is pending review again.' })
      setConfirm(false)
      onResubmitted()
    } catch (err) {
      setToast({ type: 'error', message: err.message })
      setConfirm(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sd-card sd-revision-card">
      <div className="sd-card-header">
        <div><h2>Documents Needing Revision</h2><p>Re-upload the flagged documents, then resubmit for review.</p></div>
      </div>
      <div className="sd-revision-list">
        {flagged.map(d => (
          <div className="sd-revision-row" key={d.key}>
            <div className="sd-revision-info">
              <span className="sd-bold">{d.label}</span>
              {d.review_note && <span className="sd-revision-note"><AlertTriangle size={12} /> {d.review_note}</span>}
            </div>
            <div className="sd-revision-action">
              {files[d.key] ? (
                <div className="sd-revision-file">
                  <FileText size={14} /><span className="sd-file-name" title={files[d.key].name}>{files[d.key].name}</span>
                  <button onClick={() => setFiles(f => { const n = { ...f }; delete n[d.key]; return n })}><X size={14} /></button>
                </div>
              ) : (
                <button className="sd-reupload-btn" onClick={() => refs.current[d.key]?.click()}>
                  <Upload size={14} /> Re-upload
                </button>
              )}
              <input ref={el => (refs.current[d.key] = el)} type="file" accept=".pdf,.jpg,.jpeg,.png" hidden
                onChange={e => onFile(d.key, e.target.files[0])} />
            </div>
          </div>
        ))}
      </div>
      <div className="sd-revision-footer">
        <button
          className="sd-btn-primary"
          disabled={!allReplaced || busy}
          onClick={() => setConfirm(true)}
        >
          <Send size={14} /> Resubmit for Review
        </button>
        {!allReplaced && <span className="sd-muted sd-small">Replace all flagged documents to enable resubmission.</span>}
      </div>

      {confirm && (
        <div className="sd-modal-overlay" onClick={() => !busy && setConfirm(false)}>
          <div className="sd-confirm" onClick={e => e.stopPropagation()}>
            <div className="sd-confirm-icon"><Send size={20} /></div>
            <h4>Resubmit documents?</h4>
            <p>Your account will go back to <b>Pending Review</b> until the admin checks your updated documents.</p>
            <div className="sd-confirm-actions">
              <button className="sd-btn-cancel" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
              <button className="sd-btn-primary" onClick={doResubmit} disabled={busy}>{busy ? 'Sending…' : 'Resubmit'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Sidebar / Header ────────────────────────────────────────────────────────

function SupplierSidebar({ active }) {
  const navigate = useNavigate()
  const isActive = (to) => to === '/supplier' ? active === '/supplier' : active.startsWith(to)
  return (
    <aside className="sd-sidebar">
      <div className="sd-sidebar-logo">
        <span className="sd-logo-icon"><Building2 size={16} /></span>
        <div>
          <div className="sd-logo-name">E-Procurement</div>
          <div className="sd-logo-sub">Supplier Workspace</div>
        </div>
      </div>
      <div className="sd-menu-section">
        <span className="sd-menu-label">MENU</span>
        <nav className="sd-sidebar-nav">
          {NAV.map(({ icon: Icon, label, to }) => (
            <Link key={to} to={to} className={`sd-nav-item${isActive(to) ? ' active' : ''}`}>
              <Icon size={18} /><span>{label}</span>
              {isActive(to) && <span className="sd-nav-dot" />}
            </Link>
          ))}
        </nav>
      </div>
      <div className="sd-sidebar-footer">
        <div className="sd-sidebar-user">
          <div className="sd-sidebar-avatar">S</div>
          <div className="sd-sidebar-user-info">
            <span className="sd-sidebar-user-name">Supplier User</span>
            <span className="sd-sidebar-user-email">supplier@buildright.com</span>
          </div>
          <button
            className="sd-sidebar-expand"
            onClick={() => { clearSession(); navigate('/login') }}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </aside>
  )
}

// Bell with unread count + dropdown list. Opening it marks everything read.
function NotificationsBell() {
  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  const load = () => { apiListNotifications().then(setItems).catch(() => {}) }
  useEffect(() => { load() }, [])
  const unread = items.filter(n => !n.is_read).length

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && unread > 0) {
      apiMarkNotificationsRead()
        .then(() => setItems(prev => prev.map(n => ({ ...n, is_read: true }))))
        .catch(() => {})
    }
  }

  return (
    <div className="sd-notif-wrap">
      <button className="sd-notif" onClick={toggle}>
        <Bell size={18} />
        {unread > 0 && <span className="sd-notif-badge">{unread}</span>}
      </button>
      {open && (
        <>
          <div className="sd-dropdown-backdrop" onClick={() => setOpen(false)} />
          <div className="sd-notif-dropdown">
            <div className="sd-notif-head">Notifications</div>
            {items.length === 0 ? (
              <div className="sd-notif-empty">No notifications yet.</div>
            ) : (
              items.map(n => (
                <div key={n.id} className="sd-notif-item">
                  <div className="sd-notif-msg">{n.message}</div>
                  <div className="sd-notif-time">{new Date(n.created_at).toLocaleString()}</div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}

function SupplierHeader({ title }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <header className="sd-header">
      <div className="sd-header-left">
        <div className="sd-workspace-label">SUPPLIER WORKSPACE</div>
        <h1 className="sd-page-title">{title}</h1>
      </div>
      <div className="sd-header-right">
        <div className="sd-search">
          <Search size={15} />
          <input placeholder="Search projects…" />
        </div>
        <NotificationsBell />
        <div className="sd-user-wrap">
          <div className="sd-user" onClick={() => setOpen(o => !o)}>
            <div className="sd-avatar">S</div>
            <div className="sd-user-info">
              <span>Supplier User</span>
              <span>BuildRight Corp</span>
            </div>
            <ChevronDown size={14} color="#64748b" />
          </div>
          {open && (
            <>
              <div className="sd-dropdown-backdrop" onClick={() => setOpen(false)} />
              <div className="sd-dropdown">
                <div className="sd-dropdown-header">
                  <div className="sd-avatar">S</div>
                  <div>
                    <div className="sd-dropdown-name">Supplier User</div>
                    <div className="sd-dropdown-email">supplier@buildright.com</div>
                  </div>
                </div>
                <div className="sd-dropdown-divider" />
                <button className="sd-dropdown-item" onClick={() => { setOpen(false); navigate('/supplier/profile') }}>
                  <User size={15} /> My Profile
                </button>
                <button className="sd-dropdown-item" onClick={() => { setOpen(false); navigate('/supplier/profile') }}>
                  <Settings size={15} /> Settings
                </button>
                <div className="sd-dropdown-divider" />
                <button className="sd-dropdown-item sd-dropdown-logout" onClick={() => { clearSession(); navigate('/login') }}>
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

// ─── Pages ───────────────────────────────────────────────────────────────────

function SupplierHome({ projects, bids, onBid, eligible, profile, onResubmitted, setToast }) {
  const [modal, setModal] = useState(null)
  const alreadyBid = new Set(bids.map(b => b.projectId))
  const available = projects.filter(p => !alreadyBid.has(p.id))
  const approvalLabel = QUAL_STATUS[profile?.qualification_status]?.label || 'Pending'

  return (
    <div className="sd-content">
      {modal && <BidModal project={modal} onClose={() => setModal(null)} onSubmit={(proj, form) => { onBid(proj, form); setModal(null) }} />}

      <VerificationBanner profile={profile} />
      <RevisionPanel profile={profile} onResubmitted={onResubmitted} setToast={setToast} />

      <div className="sd-stats">
        {[
          { label: 'Eligible Projects', value: String(projects.length),                                       icon: FolderOpen,   color: 'blue'   },
          { label: 'My Active Bids',  value: String(bids.length),                                             icon: FileText,     color: 'green'  },
          { label: 'Shortlisted',     value: String(bids.filter(b => b.status === 'shortlisted').length),     icon: CheckCircle2, color: 'purple' },
          { label: 'Approval Status', value: approvalLabel,                                                   icon: Shield,       color: eligible ? 'green' : 'yellow' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div className="sd-stat-card" key={label}>
            <div className="sd-stat-top">
              <span className="sd-stat-label">{label}</span>
              <div className={`sd-stat-icon sd-icon-${color}`}><Icon size={17} /></div>
            </div>
            <div className="sd-stat-value">{value}</div>
          </div>
        ))}
      </div>

      <div className="sd-grid">
        <div className="sd-card sd-card-wide">
          <div className="sd-card-header">
            <div><h2>Available Projects</h2><p>Open projects you can bid on</p></div>
            <Link to="/supplier/projects" className="sd-view-all">View all →</Link>
          </div>
          {available.length === 0 ? (
            <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--text-gray)', fontSize: 14 }}>
              {projects.length === 0
                ? 'No open procurements match your registered categories yet.'
                : 'You have already submitted bids on all eligible procurements.'}
            </div>
          ) : (
            <div className="sd-projects-list">
              {available.map(p => (
                <div className="sd-project-row" key={p.id}>
                  <div className="sd-proj-icon"><FolderOpen size={16} /></div>
                  <div className="sd-proj-info">
                    <span className="sd-bold">{p.name}</span>
                    <span className="sd-muted">{p.id} · {p.category}</span>
                  </div>
                  <div className="sd-proj-right">
                    <span className="sd-proj-budget">{p.budget}</span>
                    <span className="sd-muted sd-small">Due {p.deadline}</span>
                  </div>
                  {eligible
                    ? <button className="sd-bid-btn" onClick={() => setModal(p)}>Bid <ArrowRight size={13} /></button>
                    : <button className="sd-bid-btn sd-bid-locked" disabled title="Approval required before bidding"><Lock size={12} /> Locked</button>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="sd-card">
          <div className="sd-card-header">
            <div><h2>My Bids</h2><p>Your submitted bids</p></div>
          </div>
          {bids.length === 0 ? (
            <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--text-gray)', fontSize: 14 }}>
              No bids submitted yet.
            </div>
          ) : (
            <div className="sd-bids-list">
              {bids.map((b, i) => (
                <div className="sd-bid-row" key={i}>
                  <div className="sd-bid-info">
                    <span className="sd-bold">{b.project}</span>
                    <span className="sd-muted sd-small">Submitted {b.submitted}</span>
                  </div>
                  <div className="sd-bid-right">
                    <span className="sd-proj-budget">{b.amount}</span>
                    <span className={`badge ${BID_STATUS[b.status] || 'badge-yellow'}`}>{b.status.replace('_', ' ')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="sd-card sd-status-card">
        <div className="sd-card-header">
          <div><h2>Account Status</h2><p>Your registration and approval details</p></div>
        </div>
        <div className="sd-status-body">
          <div className="sd-status-item">
            <CheckCircle2 size={18} className="sd-check" />
            <div><span className="sd-bold">Account Registered</span><span className="sd-muted">{profile?.registered || '—'}</span></div>
          </div>
          <div className="sd-status-divider" />
          <div className="sd-status-item">
            {eligible ? <CheckCircle2 size={18} className="sd-check" /> : <Clock size={18} className="sd-clock" />}
            <div><span className="sd-bold">Admin Verification</span><span className="sd-muted">{approvalLabel}</span></div>
          </div>
          <div className="sd-status-divider" />
          <div className="sd-status-item">
            {eligible ? <CheckCircle2 size={18} className="sd-check" /> : <Lock size={18} className="sd-clock" />}
            <div><span className="sd-bold">Eligible to Bid</span><span className="sd-muted">{eligible ? 'Active on all open projects' : 'Locked until approved'}</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SupplierProjects({ projects, bids, onBid, eligible }) {
  const [modal, setModal] = useState(null)
  const alreadyBid = new Set(bids.map(b => b.projectId))

  return (
    <div className="sd-content">
      {modal && <BidModal project={modal} onClose={() => setModal(null)} onSubmit={(proj, form) => { onBid(proj, form); setModal(null) }} />}
      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>Open Procurements</h2><p>Procurements open for bidding that match your registered categories</p></div>
        </div>
        {projects.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--text-gray)', fontSize: 14 }}>
            No open procurements match your categories right now. Check back later.
          </div>
        ) : (
          <table className="sd-table">
            <thead>
              <tr><th>ID</th><th>Project</th><th>Budget</th><th>Category</th><th>Deadline</th><th></th></tr>
            </thead>
            <tbody>
              {projects.map(p => (
                <tr key={p.id}>
                  <td className="sd-mono">{p.id}</td>
                  <td>
                    <div className="sd-bold">{p.name}</div>
                    <div className="sd-muted sd-small" style={{ maxWidth: 220 }}>{p.description}</div>
                  </td>
                  <td>{p.budget}</td>
                  <td><span className="badge badge-blue">{p.category}</span></td>
                  <td className="sd-muted">{p.deadline}</td>
                  <td>
                    {alreadyBid.has(p.id)
                      ? <span className="badge badge-green">Bid Submitted</span>
                      : eligible
                      ? <button className="sd-bid-btn-table" onClick={() => setModal(p)}>Submit Bid</button>
                      : <span className="badge badge-yellow"><Lock size={11} /> Locked</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function SupplierBids({ bids, onWithdraw }) {
  const [detail, setDetail] = useState(null)

  return (
    <div className="sd-content">
      {detail !== null && (
        <BidDetailModal
          bid={bids[detail]}
          onClose={() => setDetail(null)}
          onWithdraw={() => { onWithdraw(bids[detail].id); setDetail(null) }}
        />
      )}
      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>My Bids</h2><p>Track all your submitted bids and their evaluation status</p></div>
        </div>
        {bids.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--text-gray)', fontSize: 14 }}>
            No bids submitted yet. Browse projects to submit your first bid.
          </div>
        ) : (
          <table className="sd-table">
            <thead>
              <tr><th>Project</th><th>Amount</th><th>Notes</th><th>Submitted</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {bids.map((b, i) => (
                <tr key={i}>
                  <td className="sd-bold">{b.project}</td>
                  <td>{b.amount}</td>
                  <td className="sd-muted" style={{ maxWidth: 200, fontSize: 13 }}>{b.notes}</td>
                  <td className="sd-muted">{b.submitted}</td>
                  <td><span className={`badge ${BID_STATUS[b.status] || 'badge-yellow'}`}>{b.status.replace('_', ' ')}</span></td>
                  <td>
                    <button className="sd-btn-view" onClick={() => setDetail(i)}>
                      <Eye size={13} /> View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function SupplierStatusPage({ bids, profile, eligible }) {
  const qs = profile?.qualification_status
  const verifyDate =
    qs === 'verified' ? (profile?.reviewed_at ? new Date(profile.reviewed_at).toLocaleDateString() : 'Approved')
    : qs === 'needs_revision' ? 'Revision requested'
    : qs === 'rejected' ? 'Rejected'
    : 'Pending review'
  const steps = [
    {
      label: 'Account Registered',
      date: profile?.registered || '—',
      done: true,
      desc: 'Your supplier account was created and submitted for review.',
    },
    {
      label: 'Admin Verification',
      date: verifyDate,
      done: qs === 'verified',
      desc: 'Admin reviews your company details and uploaded documents.',
    },
    {
      label: 'Eligible to Bid',
      date: eligible ? 'Active' : 'Locked until approved',
      done: !!eligible,
      desc: 'Once approved, you can submit bids on all published projects.',
    },
    {
      label: 'Bids Submitted',
      date: bids.length > 0 ? `${bids.length} bid${bids.length > 1 ? 's' : ''} total` : 'No bids yet',
      done: bids.length > 0,
      desc: 'Your submitted bids are listed below.',
    },
    {
      label: 'Bid Shortlisted',
      date: bids.some(b => b.status === 'shortlisted') ? 'Active' : 'Pending evaluation',
      done: bids.some(b => b.status === 'shortlisted'),
      desc: 'At least one of your bids has been shortlisted for final evaluation.',
    },
    {
      label: 'Contract Awarded',
      date: bids.some(b => b.status === 'winner') ? 'Awarded!' : 'Awaiting decision',
      done: bids.some(b => b.status === 'winner'),
      desc: 'The procurement office has selected a winner for the project.',
    },
  ]

  return (
    <div className="sd-content">
      <div className="sd-stats">
        {[
          { label: 'Bids Submitted',  value: String(bids.length),                                             icon: FileText,     color: 'blue'   },
          { label: 'Under Review',    value: String(bids.filter(b => b.status === 'under_review').length),    icon: Clock,        color: 'yellow' },
          { label: 'Shortlisted',     value: String(bids.filter(b => b.status === 'shortlisted').length),     icon: CheckCircle2, color: 'green'  },
          { label: 'Won',             value: String(bids.filter(b => b.status === 'winner').length),          icon: Trophy,       color: 'purple' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div className="sd-stat-card" key={label}>
            <div className="sd-stat-top">
              <span className="sd-stat-label">{label}</span>
              <div className={`sd-stat-icon sd-icon-${color}`}><Icon size={17} /></div>
            </div>
            <div className="sd-stat-value">{value}</div>
          </div>
        ))}
      </div>

      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>Account & Bid Timeline</h2><p>Your progress through the procurement process</p></div>
        </div>
        <div className="sd-timeline">
          {steps.map((step, i) => (
            <div className={`sd-timeline-step ${step.done ? 'done' : 'pending'}`} key={i}>
              <div className="sd-tl-left">
                <div className="sd-tl-dot">{step.done ? <CheckCircle2 size={16} /> : <Clock size={16} />}</div>
                {i < steps.length - 1 && <div className="sd-tl-line" />}
              </div>
              <div className="sd-tl-body">
                <div className="sd-tl-title">{step.label}</div>
                <div className="sd-tl-date">{step.date}</div>
                <div className="sd-tl-desc">{step.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function SupplierProfile() {
  const [editing, setEditing] = useState(false)
  const [profile, setProfile] = useState({
    name:     'Supplier User',
    company:  'BuildRight Corp',
    email:    'supplier@buildright.com',
    phone:    '+63 912 345 6789',
    address:  '123 Builder St., Makati City',
    category: 'Infrastructure',
    tin:      '123-456-789-000',
  })
  const [form, setForm] = useState(profile)
  const [saved, setSaved] = useState(false)

  const handleSave = (e) => {
    e.preventDefault()
    setProfile(form)
    setEditing(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const fields = [
    { key: 'name',     label: 'Full Name' },
    { key: 'company',  label: 'Company Name' },
    { key: 'email',    label: 'Email Address', type: 'email' },
    { key: 'phone',    label: 'Phone Number' },
    { key: 'address',  label: 'Business Address' },
    { key: 'category', label: 'Category' },
    { key: 'tin',      label: 'TIN Number' },
  ]

  return (
    <div className="sd-content">
      {saved && (
        <div className="sd-toast">
          <CheckCircle2 size={15} /> Profile updated successfully.
        </div>
      )}

      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>My Profile</h2><p>Your company and account information</p></div>
          {!editing && (
            <button className="sd-btn-primary" onClick={() => { setForm(profile); setEditing(true) }}>
              Edit Profile
            </button>
          )}
        </div>

        {editing ? (
          <form onSubmit={handleSave} className="sd-profile-form">
            {fields.map(({ key, label, type = 'text' }) => (
              <div className="sd-form-group" key={key}>
                <label>{label}</label>
                <input
                  type={type}
                  value={form[key]}
                  onChange={e => setForm({ ...form, [key]: e.target.value })}
                  required
                />
              </div>
            ))}
            <div className="sd-profile-actions">
              <button type="button" className="sd-btn-cancel" onClick={() => setEditing(false)}>Cancel</button>
              <button type="submit" className="sd-btn-primary">Save Changes</button>
            </div>
          </form>
        ) : (
          <div className="sd-profile-grid">
            {fields.map(({ key, label }) => (
              <div className="sd-profile-field" key={key}>
                <span className="sd-profile-label">{label}</span>
                <span className="sd-profile-value">{profile[key]}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="sd-card sd-status-card">
        <div className="sd-card-header">
          <div><h2>Account Status</h2><p>Verification and eligibility</p></div>
        </div>
        <div className="sd-status-body">
          <div className="sd-status-item">
            <CheckCircle2 size={18} className="sd-check" />
            <div><span className="sd-bold">Account Registered</span><span className="sd-muted">Jun 1, 2026</span></div>
          </div>
          <div className="sd-status-divider" />
          <div className="sd-status-item">
            <CheckCircle2 size={18} className="sd-check" />
            <div><span className="sd-bold">Admin Approved</span><span className="sd-muted">Jun 3, 2026</span></div>
          </div>
          <div className="sd-status-divider" />
          <div className="sd-status-item">
            <CheckCircle2 size={18} className="sd-check" />
            <div><span className="sd-bold">Eligible to Bid</span><span className="sd-muted">Active on all open projects</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

// Module-level cache so the supplier's profile shows instantly on revisit
// instead of flashing empty while it refetches.
let myProfileCache = null

export default function SupplierDashboard() {
  const loc = useLocation()
  const [profile, setProfile] = useState(myProfileCache)
  const [projects, setProjects] = useState([])   // eligible (published + category match)
  const [bids, setBids] = useState([])
  const [toast, setToast] = useState(null)

  const loadProfile = () => {
    apiGetMySupplier()
      .then(p => { myProfileCache = p; setProfile(p) })
      // Keep showing cached profile if a background refresh fails.
      .catch(() => { if (!myProfileCache) setProfile(null) })
  }
  // Backend returns only the projects this supplier is eligible for.
  const loadProjects = () => { apiListProjects().then(d => setProjects(d.map(mapProject))).catch(() => {}) }
  const loadBids = () => { apiListMyBids().then(d => setBids(d.map(mapBid))).catch(() => {}) }
  useEffect(() => { loadProfile(); loadProjects(); loadBids() }, [])

  // Verification is the real bidding gate (the admin approve action sets this).
  const eligible = profile?.qualification_status === 'verified'

  const submitBid = async (project, form) => {
    try {
      await apiSubmitBid(project.pk, parseAmount(form.amount), form.notes || '')
      loadBids()
      setToast({ type: 'success', message: 'Bid submitted successfully.' })
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not submit your bid.' })
    }
  }

  const withdrawBid = async (bidId) => {
    try {
      await apiWithdrawBid(bidId)
      loadBids()
      setToast({ type: 'success', message: 'Bid withdrawn.' })
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not withdraw the bid.' })
    }
  }

  const TITLES = {
    '/supplier':         'Dashboard',
    '/supplier/projects':'Projects',
    '/supplier/bids':    'My Bids',
    '/supplier/status':  'Status',
    '/supplier/profile': 'Profile',
  }
  const title = Object.entries(TITLES).find(([path]) => loc.pathname === path)?.[1] || 'Dashboard'

  return (
    <div className="sd-layout">
      <SupplierSidebar active={loc.pathname} />
      <div className="sd-main">
        <SupplierHeader title={title} />
        {toast && <SupplierToast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
        <div className="sd-body">
          <Routes>
            <Route index element={<SupplierHome projects={projects} bids={bids} onBid={submitBid} eligible={eligible} profile={profile} onResubmitted={loadProfile} setToast={setToast} />} />
            <Route path="projects" element={<SupplierProjects projects={projects} bids={bids} onBid={submitBid} eligible={eligible} />} />
            <Route path="bids"     element={<SupplierBids bids={bids} onWithdraw={withdrawBid} />} />
            <Route path="status"   element={<SupplierStatusPage bids={bids} profile={profile} eligible={eligible} />} />
            <Route path="profile"  element={<SupplierProfile />} />
            <Route path="*"        element={<SupplierHome projects={projects} bids={bids} onBid={submitBid} eligible={eligible} profile={profile} onResubmitted={loadProfile} setToast={setToast} />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
