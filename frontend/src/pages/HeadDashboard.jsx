import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Clock, CheckCircle2, XCircle,
  ChevronDown, LogOut,
  ClipboardCheck, AlertCircle, AlertTriangle, FolderOpen, Eye,
  ThumbsUp, ThumbsDown, FileText, Menu, X, Image as ImageIcon, ChevronRight, ShieldCheck, Link2, Loader2,
} from 'lucide-react'
import { apiLogout, apiHeadSummary } from '../api'
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
import KpiCard, { KpiRow } from '../components/ui/KpiCard'
import Thumbnail from '../components/ui/Thumbnail'
import Lightbox from '../components/ui/Lightbox'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import RelativeTime from '../components/ui/RelativeTime'
import Toaster, { toast } from '../components/ui/Toaster'
import { useNow } from '../components/ui/Countdown'
import { runAnchor, isAnchorBusy, useAnchorActivity } from '../blockchain/anchorStore'
import { daysSince, greeting, peso, todayLong } from '../utils/format'
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

function PendingCard({ project, onApprove, onReject, onRequestRevision, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
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
    <div className={`hd-pending-card${expanded ? ' is-open' : ''}`} id={project.code} style={{ scrollMarginTop: 80 }}>
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

// ── Head home: approval command center ───────────────────────────────────────

const WAIT_WARN_DAYS = 3

function DocChecklist({ documents = [] }) {
  return (
    <ul className="rf-checklist" aria-label="Required documents">
      {documents.map(d => {
        const state = d.review_status === 'needs_revision' ? 'flagged' : d.url ? 'ok' : 'missing'
        return (
          <li key={d.key} className={`is-${state}`}>
            {state === 'ok' ? <CheckCircle2 size={12} aria-hidden="true" />
              : state === 'flagged' ? <AlertTriangle size={12} aria-hidden="true" />
              : <XCircle size={12} aria-hidden="true" />}
            {d.label.replace(/ \(.*\)/, '')}
            <span className="sr-only">: {state === 'ok' ? 'uploaded' : state === 'flagged' ? 'flagged' : 'missing'}</span>
          </li>
        )
      })}
    </ul>
  )
}

function QueueItem({ project, meta, onDecide }) {
  const now = useNow()
  const [preview, setPreview] = useState(false)
  const waitingSince = meta?.waiting_since || null
  const days = daysSince(waitingSince, now)
  return (
    <li className="rf-queue-item">
      <Thumbnail src={project.referenceImage} size={64} category={project.category}
        alt={`Reference image for ${project.code} ${project.name}`} onOpen={() => setPreview(true)} />
      <div style={{ minWidth: 0 }}>
        <h4 className="rf-queue-title">{project.name}</h4>
        <div className="rf-queue-meta">
          <span className="rf-code">{project.code}</span>
          <span>{project.category || '—'}</span>
          <span>ABC <strong style={{ color: 'var(--text-strong)' }}>{project.budget}</strong></span>
          {meta?.created_by && <span>Created by {meta.created_by}</span>}
        </div>
        <DocChecklist documents={project.documents} />
      </div>
      <div className="rf-queue-side">
        {days != null && (
          <StatusBadge tone={days >= WAIT_WARN_DAYS ? 'warning' : 'neutral'} icon={Clock}
            title={`In your queue since ${new Date(waitingSince).toLocaleString('en-PH')}`}
            label={days === 0 ? 'Waiting since today' : `Waiting ${days} day${days === 1 ? '' : 's'}`} />
        )}
        <div className="rf-queue-actions">
          <button type="button" className="ui-btn ui-btn--danger-outline ui-btn--sm" onClick={() => onDecide('reject', project)}>
            <ThumbsDown size={13} /> Reject
          </button>
          <Link to={`/head/pending#${project.code}`} className="ui-btn ui-btn--secondary ui-btn--sm">
            <AlertTriangle size={13} /> Request revision
          </Link>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => onDecide('approve', project)}>
            <ThumbsUp size={13} /> Approve
          </button>
        </div>
      </div>
      {preview && (
        <Lightbox images={[{ url: project.referenceImage, caption: `${project.code} · ${project.name}` }]} index={0}
          title="Project reference image" onClose={() => setPreview(false)} />
      )}
    </li>
  )
}

function DecisionChain({ anchor, onAnchored }) {
  const activity = useAnchorActivity()
  const [busy, setBusy] = useState(false)
  if (!anchor) return <span className="rf-muted">Not recorded</span>
  if (anchor.anchored) {
    return (
      <a className="rf-receipt" href={anchor.explorer_url} target="_blank" rel="noopener noreferrer"
        title={`Transaction ${anchor.tx_hash} on Etherscan`}>
        <ShieldCheck size={13} aria-hidden="true" /> On-chain
      </a>
    )
  }
  const go = async () => {
    setBusy(true)
    const ok = await runAnchor(anchor, { label: `${anchor.entity_ref} · ${anchor.stage_label}` })
    setBusy(false)
    if (ok) { toast.success(`${anchor.entity_ref} decision recorded on-chain.`); onAnchored() }
  }
  return (
    <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={go} disabled={busy || isAnchorBusy(activity)}>
      {busy ? <Loader2 size={12} className="ui-spin" /> : <Link2 size={12} />} {busy ? 'Anchoring…' : 'Anchor now'}
    </button>
  )
}

const DECISION_BADGE = {
  approved: ['success', 'Approved'], rejected: ['danger', 'Rejected'], revision: ['warning', 'Revision requested'],
}

function HeadHome() {
  const { projects, loading } = useProjects()
  const [summary, setSummary] = useState(null)
  const [sumLoading, setSumLoading] = useState(true)
  const [sumError, setSumError] = useState('')
  const [decide, setDecide] = useState(null)     // { type: 'approve'|'reject', project }
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const u = storedUser()

  const loadSummary = useCallback(() => {
    setSumError('')
    return apiHeadSummary().then(setSummary)
      .catch(e => setSumError(e.message || 'Could not load your summary.'))
      .finally(() => setSumLoading(false))
  }, [])
  useEffect(() => { loadSummary() }, [loadSummary])

  const metaById = Object.fromEntries((summary?.queue || []).map(q => [q.id, q]))
  // Oldest first: the one that has waited longest is the most urgent.
  const pending = projects.filter(p => p.status === 'pending_head')
    .sort((a, b) => String(metaById[a.id]?.waiting_since || '').localeCompare(String(metaById[b.id]?.waiting_since || '')))
  const k = summary?.kpis || {}
  const oldest = daysSince(summary?.queue?.[0]?.waiting_since)

  const run = async () => {
    const { type, project } = decide
    setBusy(true)
    try {
      if (type === 'approve') {
        await storeApprove(project.id)
        toast.success(`${project.code} approved — sent to the Admin to publish for bidding.`)
      } else {
        await storeReject(project.id, reason)
        toast.success(`${project.code} was rejected and returned to the Admin.`)
      }
      setDecide(null); setReason('')
      loadSummary()
    } catch (e) {
      toast.error(e.message || 'Could not record your decision.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hd-content rf-home">
      <div className="rf-greeting">
        <div>
          <h2>{greeting()}, {u.full_name || u.username || 'Head'}</h2>
          <p>{todayLong()} · Approving Authority</p>
        </div>
      </div>

      {sumError && (
        <div className="ui-callout ui-callout--danger" role="alert">
          <AlertCircle size={18} className="ui-callout-icon" />
          <div>
            <div className="ui-callout-title">Some numbers could not load</div>
            <p>{sumError}</p>
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => { setSumLoading(true); loadSummary() }}>Try again</button>
          </div>
        </div>
      )}

      <KpiRow cols={4}>
        <KpiCard label="Waiting for my approval" icon={Clock} loading={sumLoading} to="/head/pending"
          tone={k.waiting ? (oldest >= WAIT_WARN_DAYS ? 'warning' : 'info') : 'success'} value={k.waiting ?? 0}
          context={k.waiting ? `Oldest waiting ${oldest === 0 ? 'since today' : `${oldest} day${oldest === 1 ? '' : 's'}`}` : 'All caught up'} />
        <KpiCard label="Approved this month" icon={CheckCircle2} tone="success" loading={sumLoading}
          value={k.approved_this_month ?? 0} to="/head/approved" context="Sent to the Admin to publish" />
        <KpiCard label="Returned for revision" icon={AlertTriangle} tone={k.returned_for_revision ? 'warning' : 'neutral'}
          loading={sumLoading} value={k.returned_for_revision ?? 0} to="/head/approved" context="Waiting on the Admin to fix" />
        <KpiCard label="Rejected" icon={XCircle} tone="neutral" loading={sumLoading}
          value={k.rejected ?? 0} to="/head/approved" context="All time" />
      </KpiRow>

      <section className="rf-card" aria-labelledby="queue-h">
        <div className="rf-card-head">
          <div>
            <h3 id="queue-h">Approval queue</h3>
            <p>Longest waiting first · check the five required documents before you decide</p>
          </div>
          <Link to="/head/pending" className="rf-card-link">Full review <ChevronRight size={13} /></Link>
        </div>
        {loading && pending.length === 0 ? (
          <div className="rf-card-body"><ListSkeleton rows={2} height={84} /></div>
        ) : pending.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="All caught up"
            description="No procurements are waiting for your approval. New submissions from the Admin appear here." />
        ) : (
          <ul className="rf-queue">
            {pending.map(p => (
              <QueueItem key={p.id} project={p} meta={metaById[p.id]} onDecide={(type, project) => setDecide({ type, project })} />
            ))}
          </ul>
        )}
      </section>

      <section className="rf-card" aria-labelledby="hist-h">
        <div className="rf-card-head">
          <div><h3 id="hist-h">My decision history</h3><p>Your latest decisions and whether each is recorded on-chain</p></div>
          <Link to="/head/approved" className="rf-card-link">All reviewed <ChevronRight size={13} /></Link>
        </div>
        {sumLoading ? (
          <div className="rf-card-body"><ListSkeleton rows={3} height={40} /></div>
        ) : !summary?.history?.length ? (
          <EmptyState compact icon={FolderOpen} title="No decisions yet" description="Procurements you approve, reject or return will be listed here." />
        ) : (
          <div className="rf-table-scroll">
            <table className="rf-table">
              <caption className="sr-only">Decision history</caption>
              <thead>
                <tr><th scope="col">Procurement</th><th scope="col" className="is-num">ABC</th><th scope="col">Decision</th><th scope="col">When</th><th scope="col">On-chain</th></tr>
              </thead>
              <tbody>
                {summary.history.map(h => {
                  const [tone, label] = DECISION_BADGE[h.decision] || ['neutral', h.decision]
                  return (
                    <tr key={h.id}>
                      <td>
                        <div className="rf-cell-title"><div><strong>{h.name}</strong><small><span className="rf-code">{h.code}</span></small></div></div>
                      </td>
                      <td className="is-num"><span className="rf-amount">{peso(h.budget)}</span></td>
                      <td><StatusBadge tone={tone} label={label} /></td>
                      <td><RelativeTime value={h.reviewed_at} /></td>
                      <td><DecisionChain anchor={h.anchor} onAnchored={loadSummary} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {decide && (
        <ConfirmDialog
          title={decide.type === 'approve' ? `Approve ${decide.project.code}?` : `Reject ${decide.project.code}?`}
          tone={decide.type === 'approve' ? 'primary' : 'danger'}
          confirmLabel={decide.type === 'approve' ? 'Approve procurement' : 'Reject procurement'}
          onChain busy={busy}
          points={decide.type === 'approve'
            ? [`${decide.project.name} (ABC ${decide.project.budget}) is approved.`, 'It goes back to the Admin, who publishes it for bidding.']
            : [`${decide.project.name} is marked Rejected and returned to the Admin.`, 'A rejected procurement cannot be edited — the Admin files a new one.']}
          onCancel={() => { setDecide(null); setReason('') }}
          onConfirm={run}
        >
          {decide.type === 'reject' && (
            <label className="rf-field">
              <span>Reason for rejection (optional)</span>
              <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)}
                placeholder="Explain why, so the Admin can correct it in a new filing" />
            </label>
          )}
        </ConfirmDialog>
      )}
    </div>
  )
}

function PendingPage() {
  const { projects, loading } = useProjects()
  const loc = useLocation()
  // Opened from the home queue's "Request revision": scroll to that card.
  useEffect(() => {
    if (!loc.hash || loading) return
    document.getElementById(decodeURIComponent(loc.hash.slice(1)))?.scrollIntoView({ block: 'start' })
  }, [loc.hash, loading])
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
              <PendingCard key={p.id} project={p} onApprove={onApprove} onReject={onReject} onRequestRevision={onRequestRevision}
                defaultExpanded={loc.hash === `#${p.code}`} />
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
      <Toaster />
    </div>
  )
}
