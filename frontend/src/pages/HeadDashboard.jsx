import { useState, useEffect } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Clock, CheckCircle2, XCircle,
  ChevronDown, LogOut,
  ClipboardCheck, AlertCircle, AlertTriangle, FolderOpen, Eye,
  ThumbsUp, ThumbsDown, FileText, Menu, X, Image as ImageIcon,
} from 'lucide-react'
import { apiLogout } from '../api'
import {
  useProjects, approveProject as storeApprove, rejectProject as storeReject,
  requestProjectRevision as storeRequestRevision,
  isReviewed, decisionOf, deadlineLabel, deliveryLabel,
} from '../store/projectsStore'
import { Skeleton, TableSkeleton, ListSkeleton } from '../components/Skeleton'
import AppSidebar from '../components/shell/AppSidebar'
import AppHeader, { storedUser } from '../components/shell/AppHeader'
import StatusBadge from '../components/ui/StatusBadge'
import EmptyState from '../components/ui/EmptyState'
import AnchorActivity from '../components/AnchorActivity'
import BlockchainTrail, { BlockchainBadge } from '../components/BlockchainTrail'
import '../style/HeadDashboard.css'

const NAV_SECTIONS = (pendingCount) => [
  { label: 'Overview', items: [
    { icon: LayoutDashboard, label: 'Dashboard', to: '/head' },
  ] },
  { label: 'Approvals', items: [
    { icon: Clock, label: 'Pending Approval', to: '/head/pending', badge: pendingCount },
    { icon: CheckCircle2, label: 'Reviewed Projects', to: '/head/approved' },
  ] },
]

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

function PendingCard({ project, onApprove, onReject, onRequestRevision }) {
  const [expanded, setExpanded] = useState(false)
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Per-document flags — tick the box next to a problem document, add a note,
  // then "Request Revision" instead of an outright reject.
  const [flags, setFlags] = useState({})   // { key: { checked, note } }

  const toggleFlag = (key) =>
    setFlags(f => ({ ...f, [key]: { checked: !f[key]?.checked, note: f[key]?.note || '' } }))
  const setFlagNote = (key, val) =>
    setFlags(f => ({ ...f, [key]: { checked: f[key]?.checked ?? true, note: val } }))
  const flaggedDocs = () => {
    const out = {}
    Object.entries(flags).forEach(([k, v]) => { if (v.checked) out[k] = v.note || '' })
    return out
  }

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

  const handleRequestRevision = async () => {
    const docs = flaggedDocs()
    if (Object.keys(docs).length === 0) {
      setErr('Tick at least one document below to flag it for revision.')
      return
    }
    setBusy(true); setErr('')
    // On success the card disappears (project leaves the pending list).
    try { await onRequestRevision(project.id, docs) }
    catch (e) { setErr(e.message || 'Could not request revision.'); setBusy(false) }
  }

  const flaggedCount = Object.keys(flaggedDocs()).length

  return (
    <div className={`hd-pending-card${expanded ? ' is-open' : ''}`}>
      <div className="hd-pending-card-top">
        <div className="hd-proj-icon" aria-hidden="true"><FolderOpen size={16} /></div>
        <div className="hd-pending-info">
          <div className="hd-pending-title">{project.name}</div>
          <div className="hd-pending-sub">
            <span className="hd-id">{project.code}</span>
            <span>{project.type}</span>
            <span className="hd-dot-sep" aria-hidden="true" />
            <span>Submitted {project.submittedAt}</span>
          </div>
        </div>
        <div className="hd-pending-meta">
          <span className="hd-pending-budget">{project.budget}</span>
          <span className="hd-muted hd-small">{deadlineLabel(project)}</span>
        </div>
        <div className="hd-pending-actions">
          <BlockchainBadge anchors={project.anchors} onClick={() => setExpanded(true)} />
          <button className="hd-btn-expand" onClick={() => setExpanded(e => !e)} aria-expanded={expanded}>
            <Eye size={13} /> {expanded ? 'Hide review' : 'Review'}
          </button>
          {!expanded && (
            <>
              <button className="hd-btn-reject-sm" onClick={() => setShowRejectForm(true)} disabled={busy}>
                <ThumbsDown size={13} /> Reject
              </button>
              <button className="hd-btn-approve" onClick={handleApprove} disabled={busy}>
                <ThumbsUp size={13} /> {busy ? 'Working…' : 'Approve'}
              </button>
            </>
          )}
        </div>
      </div>

      {err && <div className="hd-inline-error" role="alert"><AlertCircle size={14} /> {err}</div>}

      {expanded && (
        <div className="hd-pending-desc">
          <div className="hd-review-grid">
            <section className="hd-summary" aria-label="Project summary">
              <div className="hd-summary-head">Summary</div>
              <div className="hd-summary-abc">
                <span className="hd-label">Approved Budget (ABC)</span>
                <strong>{project.budget}</strong>
              </div>
              <dl className="hd-summary-list">
                <div><dt>Category</dt><dd>{project.category || '—'}</dd></div>
                <div><dt>Procurement Type</dt><dd>{project.type}</dd></div>
                <div><dt>Delivery Location</dt><dd>{project.deliveryLocation || '—'}</dd></div>
                <div><dt>Bidding Period</dt><dd>{deadlineLabel(project)}</dd></div>
                <div><dt>Expected Delivery</dt><dd>{deliveryLabel(project)}</dd></div>
                <div><dt>Submitted</dt><dd>{project.submittedAt}</dd></div>
              </dl>
            </section>

            <div className="hd-review-main">
              <section>
                <div className="hd-section-title">Description</div>
                <p className="hd-desc-text">{project.description}</p>
              </section>

              {project.referenceImage && (
                <div className="hd-refimg-section">
                  <span className="hd-refimg-label"><ImageIcon size={13} /> Project Reference Image</span>
                  <a href={project.referenceImage} target="_blank" rel="noopener noreferrer" title="Open full size">
                    <img src={project.referenceImage} alt="Project reference" className="hd-refimg-thumb" />
                  </a>
                </div>
              )}

              {project.documents?.length > 0 && (
                <section className="hd-doc-review">
                  <div className="hd-section-title">
                    Procurement Documents
                    <span className="hd-section-count">{project.documents.length}</span>
                  </div>
                  <p className="hd-muted hd-small" style={{ margin: '2px 0 10px' }}>
                    Tick a document with a problem, add a note, then click Request Revision below — this does not reject
                    the whole project, the Admin just fixes that one file.
                  </p>
                  <div className="hd-doc-review-list">
                    {project.documents.map(d => {
                      const checked = !!flags[d.key]?.checked
                      return (
                        <div className={`hd-doc-review-row${checked ? ' flagged' : ''}`} key={d.key}>
                          <label className="hd-doc-review-main">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!d.url}
                              onChange={() => toggleFlag(d.key)}
                              aria-label={`Flag ${d.label} for revision`}
                            />
                            <FileText size={14} aria-hidden="true" />
                            <span className="hd-doc-review-label">{d.label}</span>
                            {checked && <StatusBadge tone="warning" label="Flagged" />}
                            {d.url
                              ? <a href={d.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="hd-doc-link" style={{ marginLeft: 'auto' }}>View</a>
                              : <span className="hd-muted" style={{ marginLeft: 'auto', fontSize: 12 }}>Not provided</span>}
                          </label>
                          {checked && (
                            <input
                              className="hd-doc-review-note"
                              placeholder="What's wrong with this document?"
                              aria-label={`Note for ${d.label}`}
                              value={flags[d.key]?.note || ''}
                              onChange={e => setFlagNote(d.key, e.target.value)}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )}

              {/* What has already been written to the blockchain for this
                  procurement — the Head can see the Admin's submission was anchored
                  before deciding, and anchor anything still pending. */}
              <BlockchainTrail anchors={project.anchors} entityRef={project.code} />
            </div>
          </div>

          {/* Decision bar stays in view while scrolling a long review. */}
          <div className="hd-decision-bar">
            <span className="hd-decision-hint">
              {flaggedCount > 0
                ? `${flaggedCount} document${flaggedCount > 1 ? 's' : ''} flagged — send back for revision, or decide on the whole project.`
                : 'Decide on this project, or flag documents above to request a revision.'}
            </span>
            <div className="hd-decision-actions">
              {project.documents?.length > 0 && (
                <button
                  type="button"
                  className="hd-btn-revision"
                  disabled={busy || flaggedCount === 0}
                  onClick={handleRequestRevision}
                >
                  <AlertTriangle size={14} /> {busy ? 'Working…' : 'Request Revision'}
                </button>
              )}
              <button className="hd-btn-reject-sm" onClick={() => setShowRejectForm(true)} disabled={busy}>
                <ThumbsDown size={14} /> Reject
              </button>
              <button className="hd-btn-approve" onClick={handleApprove} disabled={busy}>
                <ThumbsUp size={14} /> {busy ? 'Working…' : 'Approve'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showRejectForm && (
        <div className="hd-modal-overlay" onClick={() => !busy && setShowRejectForm(false)}>
          <form
            className="hd-modal"
            onSubmit={handleReject}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === 'Escape' && !busy) setShowRejectForm(false) }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`reject-title-${project.id}`}
          >
            <div className="hd-modal-icon" aria-hidden="true"><XCircle size={22} /></div>
            <h3 id={`reject-title-${project.id}`}>Reject this project?</h3>
            <p className="hd-modal-text">
              <strong>{project.name}</strong> ({project.code}) will be marked Rejected and returned to the Admin.
            </p>
            <label className="hd-label" htmlFor={`reject-reason-${project.id}`}>Reason for rejection (optional)</label>
            <textarea
              id={`reject-reason-${project.id}`}
              placeholder="Explain why this project is being rejected…"
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              rows={4}
              autoFocus
            />
            {err && <div className="hd-inline-error" role="alert" style={{ margin: '10px 0 0' }}><AlertCircle size={14} /> {err}</div>}
            <div className="hd-reject-form-actions">
              <button type="button" className="hd-btn-cancel" onClick={() => setShowRejectForm(false)} disabled={busy}>Cancel</button>
              <button type="submit" className="hd-btn-reject-confirm" disabled={busy}>
                {busy ? 'Working…' : 'Confirm Rejection'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function HeadHome() {
  const { projects, loading } = useProjects()
  const [toast, setToast] = useState(null)
  const pending = projects.filter(p => p.status === 'pending_head')
  const approved = projects.filter(isReviewed)
  const approvedCount = approved.filter(p => decisionOf(p) === 'approved').length
  const rejectedCount = approved.filter(p => decisionOf(p) === 'rejected').length
  const publishedCount = projects.filter(p => p.status === 'published').length
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
  const onRequestRevision = async (id, documents) => {
    const proj = projects.find(p => p.id === id)
    await storeRequestRevision(id, documents)
    setToast({ type: 'success', message: `Revision requested on "${proj?.name}" — sent back to Admin to fix.` })
  }
  return (
    <div className="hd-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div className="hd-stats">
        {[
          { label: 'Pending Approval', value: pending.length, icon: Clock, color: 'yellow', sub: 'Waiting for your decision' },
          { label: 'Approved', value: approvedCount, icon: CheckCircle2, color: 'green', sub: `of ${approved.length} reviewed by you` },
          { label: 'Rejected', value: rejectedCount, icon: XCircle, color: 'red', sub: `of ${approved.length} reviewed by you` },
          { label: 'Published', value: publishedCount, icon: ClipboardCheck, color: 'blue', sub: 'Open for supplier bidding' },
        ].map(({ label, value, icon: Icon, color, sub }) => (
          <div className={`hd-stat-card hd-stat-${color}`} key={label}>
            <div className="hd-stat-top">
              <span className="hd-stat-label">{label}</span>
              <div className={`hd-stat-icon hd-icon-${color}`} aria-hidden="true"><Icon size={17} /></div>
            </div>
            <div className="hd-stat-value">{loading && projects.length === 0 ? <Skeleton width={40} height={26} /> : value}</div>
            <div className="hd-stat-sub">{sub}</div>
          </div>
        ))}
      </div>

      <div className={`hd-card hd-queue${pending.length > 0 ? ' has-items' : ''}`}>
        <div className="hd-card-header">
          <div className="hd-queue-head">
            <span className="hd-queue-icon" aria-hidden="true"><AlertCircle size={18} /></span>
            <div>
              <h2>Awaiting your approval</h2>
              <p>
                {pending.length > 0
                  ? `You have ${pending.length} project${pending.length > 1 ? 's' : ''} waiting for your approval`
                  : 'Projects submitted by Admin for your review — approve or reject below'}
              </p>
            </div>
          </div>
          <Link to="/head/pending" className="hd-view-all">View all →</Link>
        </div>
        {loading && pending.length === 0 ? (
          <div style={{ padding: '16px 20px' }}><ListSkeleton rows={2} height={70} /></div>
        ) : pending.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="All caught up!" description="No projects pending your approval — all caught up!" />
        ) : (
          <div className="hd-pending-list">
            {pending.map(p => (
              <PendingCard key={p.id} project={p} onApprove={onApprove} onReject={onReject} onRequestRevision={onRequestRevision} />
            ))}
          </div>
        )}
      </div>

      <div className="hd-card">
        <div className="hd-card-header">
          <div><h2>Recently Reviewed</h2><p>Projects you've approved or rejected</p></div>
          <Link to="/head/approved" className="hd-view-all">View all →</Link>
        </div>
        {loading && approved.length === 0 ? (
          <div className="hd-table-wrap"><table className="hd-table"><tbody><TableSkeleton rows={3} cols={6} /></tbody></table></div>
        ) : approved.length === 0 ? (
          <EmptyState compact icon={FolderOpen} title="No reviewed projects yet" description="Projects you approve or reject will be listed here." />
        ) : (
          <div className="hd-table-wrap">
            <table className="hd-table">
              <thead>
                <tr><th>ID</th><th>Project Name</th><th className="hd-num">Budget</th><th>Category</th><th>Reviewed On</th><th>Decision</th></tr>
              </thead>
              <tbody>
                {approved.slice(0, 4).map(p => (
                  <tr key={p.id}>
                    <td><span className="hd-id">{p.code}</span></td>
                    <td className="hd-bold">{p.name}</td>
                    <td className="hd-num">{p.budget}</td>
                    <td><span className="ui-badge ui-badge--neutral">{p.type}</span></td>
                    <td className="hd-muted hd-nowrap">{p.reviewedAt}</td>
                    <td><StatusBadge domain="decision" status={decisionOf(p)} /></td>
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
  const onRequestRevision = async (id, documents) => {
    const proj = projects.find(p => p.id === id)
    await storeRequestRevision(id, documents)
    setToast({ type: 'success', message: `Revision requested on "${proj?.name}" — sent back to Admin to fix.` })
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
          <StatusBadge tone={pending.length > 0 ? 'warning' : 'success'} label={pending.length > 0 ? `${pending.length} pending` : 'All clear'} />
        </div>
        {loading && pending.length === 0 ? (
          <div style={{ padding: '16px 20px' }}><ListSkeleton rows={2} height={70} /></div>
        ) : pending.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="All caught up!" description="No projects are waiting for your approval right now." />
        ) : (
          <div className="hd-pending-list">
            {pending.map(p => (
              <PendingCard key={p.id} project={p} onApprove={onApprove} onReject={onReject} onRequestRevision={onRequestRevision} />
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
          <StatusBadge tone="success" label={`${approvedCount} approved`} />
        </div>

        <div className="hd-filter-pills" role="tablist" aria-label="Filter reviewed projects">
          {REVIEW_TABS.map(t => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`hd-pill${tab === t ? ' hd-pill-active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t} <span className="hd-pill-count">{tabCount(t)}</span>
            </button>
          ))}
        </div>

        {loading && reviewed.length === 0 ? (
          <div className="hd-table-wrap"><table className="hd-table"><tbody><TableSkeleton rows={4} cols={7} /></tbody></table></div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={FolderOpen}
            title={reviewed.length === 0 ? 'No reviewed projects yet' : `No ${tab.toLowerCase()} projects`}
            description={reviewed.length === 0 ? 'Projects you approve or reject will appear here.' : 'Try another filter.'} />
        ) : (
          <div className="hd-table-wrap">
            <table className="hd-table">
              <thead>
                <tr><th>ID</th><th>Project Name</th><th>Category</th><th className="hd-num">Budget</th><th>Bidding Period</th><th>Reviewed On</th><th>Decision</th></tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id}>
                    <td><span className="hd-id">{p.code}</span></td>
                    <td className="hd-bold">{p.name}</td>
                    <td><span className="ui-badge ui-badge--neutral">{p.type}</span></td>
                    <td className="hd-num">{p.budget}</td>
                    <td className="hd-muted">{deadlineLabel(p)}</td>
                    <td className="hd-muted hd-nowrap">{p.reviewedAt}</td>
                    <td><StatusBadge domain="decision" status={decisionOf(p)} /></td>
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
  const navigate = useNavigate()
  const { projects } = useProjects()   // shared store — no extra request
  const pendingCount = projects.filter(p => p.status === 'pending_head').length
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => { setNavOpen(false) }, [loc.pathname])

  const PAGE_TITLES = {
    '/head': 'Dashboard',
    '/head/pending': 'Pending Approval',
    '/head/approved': 'Reviewed Projects',
  }
  const title = PAGE_TITLES[loc.pathname] || 'Dashboard'

  const u = storedUser()
  const user = {
    name: u.full_name || u.username || 'School Head',
    email: u.email || '',
    role: 'Department Head',
  }

  return (
    <div className="hd-layout">
      <AppSidebar
        workspace="Head Workspace"
        logoIcon={ClipboardCheck}
        sections={NAV_SECTIONS(pendingCount)}
        isActive={(to) => loc.pathname === to}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />
      {navOpen && <div className="hd-nav-backdrop" onClick={() => setNavOpen(false)} />}
      <div className="hd-main">
        <AppHeader
          title={title}
          breadcrumbs={[{ label: 'Head', to: '/head' }, { label: title }]}
          onMenu={() => setNavOpen(true)}
          user={user}
          menu={[{ icon: LogOut, label: 'Log out', danger: true, onClick: () => { apiLogout(); navigate('/login') } }]}
        />
        <div className="hd-body">
          <Routes>
            <Route index element={<HeadHome />} />
            <Route path="pending" element={<PendingPage />} />
            <Route path="approved" element={<ApprovedPage />} />
            <Route path="*" element={<HeadHome />} />
          </Routes>
        </div>
      </div>
      {/* Reports the blockchain anchoring of the Head's approve/reject/revision
          decisions. Mounted at the layout root so it survives route changes
          while a MetaMask prompt is open. */}
      <AnchorActivity />
    </div>
  )
}
