// The BAC Committee member's dashboard (/bac). Members evaluate every bid on
// their own, the Chairperson records post-qualification, and everyone votes on
// the resolution with a written reason. Nothing here is decided by one person:
// the server applies the majority (backend/procurement/bac.py).
import { useEffect, useState } from 'react'
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle, ArrowLeft, ClipboardCheck, FileText, Gavel, Landmark, LayoutDashboard, LogOut, ScrollText, Vote,
} from 'lucide-react'
import {
  apiBacEvaluateBid, apiBacPostQualify, apiBacProject, apiBacProjects, apiBacResolutions, apiBacUpcomingProjects, apiBacVote, apiDemoCloseBidding,
  apiBidRequestRevision, apiListProjectBids, apiLogout,
} from '../api'
import AppSidebar from '../components/shell/AppSidebar'
import AppHeader, { storedUser } from '../components/shell/AppHeader'
import PageHeader from '../components/ui/PageHeader'
import EmptyState from '../components/ui/EmptyState'
import StatusBadge from '../components/ui/StatusBadge'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import Toaster, { toast } from '../components/ui/Toaster'
import { ListSkeleton } from '../components/Skeleton'
import {
  RankingTable, ResolutionFacts, ResolutionStatus, VoteCounts, VoteList,
} from '../components/bac/BacParts'
import BacRecordsPage from './bac/BacRecordsPage'
import { useBacStatus } from '../utils/workspace'
import { fmtDate, peso } from '../utils/format'
import KpiCard, { KpiRow } from '../components/ui/KpiCard'
import { DashGrid, DashHeader, Panel, TabbedPanel } from '../components/ui/Dashboard'
import PreviewButton from '../components/ui/FilePreview'
import { BarList, DonutChart, ProgressBar, SERIES, STATUS } from '../components/charts/Charts'
import '../style/AdminDashboard.css'
import '../style/bac.css'

const NAV = [
  { label: 'Overview', items: [{ icon: LayoutDashboard, label: 'Dashboard', to: '/bac' }] },
  { label: 'Committee', items: [
    { icon: ClipboardCheck, label: 'Evaluation', to: '/bac/evaluation' },
    { icon: Vote, label: 'Resolutions & Voting', to: '/bac/resolutions' },
    { icon: ScrollText, label: 'BAC Records', to: '/bac/records' },
  ] },
]

function WorkflowOff({ status }) {
  if (status.loading || status.workflow_enabled) return null
  return (
    <div className="bac-note bac-note--warning" role="status"><Landmark size={16} />
      <div><strong>The BAC Committee workflow is not switched on yet</strong>
        <p>You can look around, but evaluations and votes are refused until it is.</p></div>
    </div>
  )
}

function NoSeat({ status }) {
  if (status.loading || status.membership) return null
  return (
    <div className="bac-note bac-note--danger" role="status"><Landmark size={16} />
      <div><strong>You don&apos;t hold a seat on the committee</strong>
        <p>The Admin records each designation the Head makes. Until yours is recorded you can read the records but not evaluate or vote.</p></div>
    </div>
  )
}

// Why this member can't evaluate right now, or '' when they can. Mirrors
// the server's checks in EvaluateBidView (workflow on, active seat, then
// bac.evaluation_lock_reason), so the reason shown is the one the server gives.
function evaluationBlock({ workflowEnabled, seat, lockReason }) {
  if (!workflowEnabled) return 'The BAC Committee workflow is not switched on (BAC_WORKFLOW_ENABLED), so evaluations are refused.'
  if (!seat) return "You don't hold a seat on the committee. Ask the Admin to record your designation under BAC Committee."
  return lockReason || ''
}

// ── Home ──────────────────────────────────────────────────────────────────────
function BacHome({ status }) {
  const [projects, setProjects] = useState(null)
  const [resolutions, setResolutions] = useState(null)
  useEffect(() => {
    apiBacProjects().then(setProjects).catch(() => setProjects([]))
    apiBacResolutions({ status: 'voting,adopted,not_adopted,returned' }).then(setResolutions).catch(() => setResolutions([]))
  }, [])
  const voting = resolutions && resolutions.filter(r => r.status === 'voting')
  const u = storedUser()
  const seat = status.membership
  const toEvaluate = (projects || []).filter(p => p.status !== 'awarded' && p.my_evaluations < p.bid_count)
  const myVotes = (voting || []).filter(r => seat && !r.votes.some(v => v.member === seat.id))
  const open = (projects || []).filter(p => p.status !== 'awarded')
  const bidsLeft = toEvaluate.reduce((n, p) => n + (p.bid_count - p.my_evaluations), 0)
  const adopted = (resolutions || []).filter(r => r.status === 'adopted').length
  return (
    <div className="bac-page ad-content rf-home">
      <DashHeader name={u.full_name || u.username || 'BAC Member'}
        context={seat ? `${seat.position_label}, BAC Committee` : undefined} />
      <WorkflowOff status={status} />
      <NoSeat status={status} />

      <KpiRow cols={4}>
        <KpiCard label="Bids to evaluate" icon={ClipboardCheck} loading={projects === null} to="/bac/evaluation"
          tone={bidsLeft ? 'warning' : 'neutral'} value={bidsLeft}
          context={toEvaluate.length ? `On ${toEvaluate.length} procurement${toEvaluate.length === 1 ? '' : 's'}` : 'You are up to date'} />
        <KpiCard label="Votes waiting" icon={Vote} loading={resolutions === null} to="/bac/resolutions"
          tone={myVotes.length ? 'warning' : 'neutral'} value={myVotes.length}
          context={voting?.length ? `${voting.length} resolution${voting.length === 1 ? '' : 's'} open for voting` : 'Nothing open for voting'} />
        <KpiCard label="In evaluation" icon={Gavel} loading={projects === null} to="/bac/evaluation"
          value={open.length} context="Procurements before award" />
        <KpiCard label="Resolutions adopted" icon={FileText} loading={resolutions === null} to="/bac/records"
          value={adopted} context={`${resolutions?.length || 0} put to a vote`} />
      </KpiRow>

      <DashGrid
        main={<>
          <Panel id="eval" title="Waiting for your evaluation" count={toEvaluate.length} countTone="warning"
            link={{ to: '/bac/evaluation', label: 'All procurements' }}>
            {projects === null ? <div className="rf-card-body"><ListSkeleton rows={2} /></div>
              : !toEvaluate.length ? <EmptyState compact icon={ClipboardCheck} title="Nothing to evaluate" description="Procurements appear here once bidding closes." />
                : <div className="bac-list">{toEvaluate.map(p => (
                  <Link key={p.id} to={`/bac/evaluation/${p.id}`} className="bac-list-row">
                    <span><strong>{p.code} · {p.name}</strong>
                      <span className="sub">You evaluated {p.my_evaluations} of {p.bid_count} bid{p.bid_count === 1 ? '' : 's'}</span></span>
                    <StatusBadge tone="warning" label="To do" />
                  </Link>))}</div>}
          </Panel>
          <Panel id="vote" title="Open for your vote" count={myVotes.length} countTone="info"
            link={{ to: '/bac/resolutions', label: 'Resolutions' }}>
            {voting === null ? <div className="rf-card-body"><ListSkeleton rows={2} /></div>
              : !myVotes.length ? <EmptyState compact icon={Vote} title="No votes waiting" description="Resolutions appear here when Staff open voting." />
                : <div className="bac-list">{myVotes.map(r => (
                  <Link key={r.id} to="/bac/resolutions" className="bac-list-row">
                    <span><strong>{r.number}</strong><span className="sub">{r.project_code} · recommends {r.recommended_company}</span></span>
                    <StatusBadge tone="info" label="Vote" />
                  </Link>))}</div>}
          </Panel>
        </>}
        side={<BacCharts projects={projects} resolutions={resolutions} />} />
    </div>
  )
}

// Two pictures of the committee's work: progress on the procurements still
// open (mine and the committee's), and how its resolutions ended.
function BacCharts({ projects, resolutions }) {
  if (projects === null || resolutions === null) {
    return <Panel title="Committee progress"><div className="rf-card-body"><ListSkeleton rows={3} /></div></Panel>
  }
  const open = projects.filter(p => p.status !== 'awarded')
  const myDone = open.reduce((n, p) => n + Math.min(p.my_evaluations, p.bid_count), 0)
  const myTotal = open.reduce((n, p) => n + p.bid_count, 0)
  const outcome = (r) => r.status === 'adopted'
    ? (r.head_decision === 'approved' ? 'approved' : r.head_decision === 'pending' ? 'with_head' : 'returned') : r.status
  const count = (k) => resolutions.filter(r => outcome(r) === k).length
  return (
    <TabbedPanel title="Committee progress" tabs={[
      {
        key: 'eval', label: 'Evaluations', render: () => (
          <div className="ch-card-body">
            <ProgressBar label="My evaluations" value={myDone} total={myTotal} color={SERIES[0]} />
            {open.length > 0
              ? <BarList ariaLabel="Committee evaluations per procurement" color={SERIES[2]}
                data={open.map(p => ({
                  label: p.code, sub: p.name, value: p.evaluations_done, max: p.evaluations_expected || 1,
                  display: `${p.evaluations_done} of ${p.evaluations_expected}`,
                }))} />
              : <p className="bac-hint">No procurement is waiting for evaluation.</p>}
          </div>
        ),
      },
      {
        key: 'res', label: 'Resolutions', render: () => (
          <div className="ch-card-body">
            {resolutions.length === 0 ? <p className="bac-hint">No resolution has been put to a vote yet.</p> : (
              <DonutChart ariaLabel="Resolutions by outcome" centerLabel="resolutions" size={128}
                data={[
                  { label: 'Award approved by the Head', value: count('approved'), color: STATUS.success },
                  { label: 'Adopted, with the Head', value: count('with_head'), color: STATUS.info },
                  { label: 'Voting', value: count('voting'), color: STATUS.warning },
                  { label: 'Not adopted or returned', value: count('not_adopted') + count('returned'), color: STATUS.danger },
                ]} />
            )}
          </div>
        ),
      },
    ]} />
  )
}

// ── Evaluation ────────────────────────────────────────────────────────────────
function EvaluationList({ status }) {
  const [rows, setRows] = useState(null)
  const [upcoming, setUpcoming] = useState([])
  // DEMO ONLY, temporary: the procurement whose bidding is about to be closed early.
  const [closing, setClosing] = useState(null)
  const [closeBusy, setCloseBusy] = useState(false)
  const load = () => {
    apiBacProjects().then(setRows).catch(e => { toast.error(e.message); setRows([]) })
    apiBacUpcomingProjects().then(setUpcoming).catch(() => setUpcoming([]))
  }
  useEffect(load, [])
  const closeBidding = async () => {
    setCloseBusy(true)
    try {
      await apiDemoCloseBidding(closing.id)
      toast.success(`Bidding on ${closing.code} is closed. It is ready for evaluation.`)
      setClosing(null)
      load()
    } catch (err) {
      toast.error(err.message || 'Could not close bidding.')
    } finally {
      setCloseBusy(false)
    }
  }
  return (
    <div className="bac-page ad-content">
      <PageHeader title="Evaluation" description="Procurements whose bidding has closed. Open one to evaluate its bids." />
      <WorkflowOff status={status} />
      <NoSeat status={status} />
      <section className="bac-card" aria-label="Procurements">
        {rows === null ? <div className="bac-card-body"><ListSkeleton rows={4} /></div>
          : !rows.length ? <EmptyState icon={ClipboardCheck} title="No procurements to evaluate"
            description="A procurement appears here when its bidding deadline passes." />
            : <div className="bac-list">{rows.map(p => (
              <Link key={p.id} to={`/bac/evaluation/${p.id}`} className="bac-list-row">
                <span><strong>{p.code} · {p.name}</strong>
                  <span className="sub">{p.bid_count} bid(s) · you evaluated {p.my_evaluations} · {p.evaluations_done} of {p.evaluations_expected} evaluations in</span></span>
                <StatusBadge tone={p.status === 'awarded' ? 'success' : p.my_evaluations < p.bid_count ? 'warning' : 'info'}
                  label={p.status === 'awarded' ? 'Awarded' : p.my_evaluations < p.bid_count ? 'To do' : 'Evaluated'} />
              </Link>))}</div>}
      </section>
      {upcoming.length > 0 && (
        <section className="bac-card" aria-labelledby="upcoming-h">
          <div className="bac-card-head"><div><h3 id="upcoming-h">Bidding still open</h3>
            <p>Bids stay sealed until the deadline. Evaluation opens the day after it.</p></div></div>
          <div className="bac-list">{upcoming.map(p => (
            <div key={p.id} className="bac-list-row">
              <span><strong>{p.code} · {p.name}</strong>
                <span className="sub">Bidding closes {p.deadline ? fmtDate(p.deadline) : 'when published'}</span></span>
              <span className="bac-actions">
                <StatusBadge tone="neutral" label={p.evaluation_opens ? `Opens ${fmtDate(p.evaluation_opens)}` : 'Not scheduled'} />
                {/* DEMO ONLY, temporary: remove with DemoCloseBiddingView. */}
                <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => setClosing(p)}>
                  Close bidding now (demo)
                </button>
              </span>
            </div>))}</div>
        </section>
      )}
      {closing && (
        <ConfirmDialog title={`Close bidding on ${closing.code} now?`} tone="warning" confirmLabel="Close bidding" busy={closeBusy}
          points={['Demo only: the bidding ends before its deadline and no more bids are accepted.',
            'The bids are unsealed for the committee, and evaluation opens right away.',
            "This is recorded in the audit log and can't be undone."]}
          onCancel={() => setClosing(null)} onConfirm={closeBidding} />
      )}
    </div>
  )
}

const CHECKS = [
  ['eligibility_ok', 'Eligibility', 'Legal, technical and financial eligibility documents are complete and valid'],
  ['technical_ok', 'Technical', 'The offer meets the technical specifications and delivery terms'],
  ['financial_ok', 'Financial', 'The bid is within the ABC and the computation is correct'],
]

function EvaluationForm({ bid, mine, locked, lockedReason, onSaved }) {
  const [form, setForm] = useState(() => ({
    eligibility_ok: mine?.eligibility_ok ?? true, technical_ok: mine?.technical_ok ?? true,
    financial_ok: mine?.financial_ok ?? true, remarks: mine?.remarks || '',
  }))
  const [busy, setBusy] = useState(false)
  const failing = !form.eligibility_ok || !form.technical_ok || !form.financial_ok
  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await apiBacEvaluateBid(bid.id, form)
      toast.success(`Evaluation of ${bid.company} saved. Bid status: ${res.bid_status.replace('_', ' ')}.`)
      onSaved()
    } catch (err) {
      toast.error(err.message || 'Could not save the evaluation.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={save} className="bac-card-body" style={{ borderTop: '1px solid var(--border)' }}>
      <fieldset className="bac-checks" disabled={locked || busy}>
        <legend className="sr-only">Your evaluation of {bid.company}</legend>
        {CHECKS.map(([key, label, hint]) => (
          <label key={key} className={`bac-check${form[key] ? '' : ' is-fail'}`} title={hint}>
            <input type="checkbox" checked={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.checked }))} />
            {label} {form[key] ? 'passed' : 'failed'}
          </label>
        ))}
      </fieldset>
      <div className="bac-field">
        <label htmlFor={`rm-${bid.id}`}>Remarks{failing ? ' (required: why it fails)' : ' (optional)'}</label>
        <textarea id={`rm-${bid.id}`} value={form.remarks} disabled={locked || busy} required={failing}
          onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} />
      </div>
      <div className="bac-actions">
        {locked && lockedReason && <span className="bac-hint" id={`lock-${bid.id}`}>{lockedReason}</span>}
        <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || locked}
          aria-describedby={locked && lockedReason ? `lock-${bid.id}` : undefined}>
          <ClipboardCheck size={13} /> {busy ? 'Saving…' : mine ? 'Update my evaluation' : 'Submit my evaluation'}
        </button>
      </div>
    </form>
  )
}

function PostQualForm({ candidate, onSaved }) {
  const [result, setResult] = useState('passed')
  const [remarks, setRemarks] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      await apiBacPostQualify(candidate.bid_id, { result, remarks })
      toast.success(`Post-qualification of ${candidate.company} recorded.`)
      onSaved()
    } catch (err) {
      toast.error(err.message || 'Could not record the finding.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="bac-card-body" onSubmit={e => { e.preventDefault(); setConfirm(true) }}>
      <p style={{ margin: 0 }}>As Chairperson, record the committee&apos;s post-qualification finding on <strong>{candidate.company}</strong> ({peso(candidate.amount)}), the lowest bid still in the running.</p>
      <div className="bac-form">
        <div className="bac-field">
          <label htmlFor="pq-result">Finding</label>
          <select id="pq-result" value={result} onChange={e => setResult(e.target.value)}>
            <option value="passed">Passed post-qualification</option>
            <option value="failed">Failed post-qualification</option>
          </select>
        </div>
        <div className="bac-field full">
          <label htmlFor="pq-remarks">What the committee verified and found</label>
          <textarea id="pq-remarks" value={remarks} onChange={e => setRemarks(e.target.value)} required
            placeholder="e.g. Verified PhilGEPS registration, tax clearance and bank reference; site visit on 12 Nov." />
        </div>
      </div>
      <div className="bac-actions"><button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy}>Record finding</button></div>
      {confirm && (
        <ConfirmDialog title={`Record that ${candidate.company} ${result === 'passed' ? 'passed' : 'failed'}?`}
          tone={result === 'passed' ? 'primary' : 'danger'} confirmLabel="Record finding" busy={busy}
          points={['A finding is recorded once and can\'t be changed.',
            result === 'passed' ? 'Staff can then draft the resolution recommending this bid.'
              : 'The bid is disqualified and the next bid in the ranking is post-qualified next.']}
          onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); submit() }} />
      )}
    </form>
  )
}

// Ask the bidder to re-upload one or more documents. The bid stays in the
// running; it can't be recommended or awarded until the files are fixed.
// Open while the members evaluate: from the deadline until voting opens.
function RevisionRequest({ bid, documents, onSent }) {
  const [open, setOpen] = useState(false)
  const [flags, setFlags] = useState({})   // key -> note
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const available = documents.filter(d => d.url || d.count)
  if (!available.length) return null
  const toggle = (key) => setFlags(f => {
    const next = { ...f }
    if (key in next) delete next[key]; else next[key] = ''
    return next
  })
  const keys = Object.keys(flags)
  const send = async () => {
    setBusy(true)
    try {
      await apiBidRequestRevision(bid.id, { documents: flags })
      toast.success(`Revision request sent to ${bid.company}.`)
      setFlags({})
      setOpen(false)
      onSent()
    } catch (err) {
      toast.error(err.message || 'Could not send the request.')
    } finally {
      setBusy(false)
    }
  }
  if (!open) {
    return (
      <div className="bac-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setOpen(true)}>
          <AlertTriangle size={13} aria-hidden="true" /> Ask the bidder to fix a document
        </button>
      </div>
    )
  }
  return (
    <form className="bac-field" onSubmit={e => { e.preventDefault(); setConfirm(true) }}>
      <fieldset className="bac-checks" disabled={busy} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>Documents that need fixing</legend>
        {available.map(d => (
          <div key={d.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label className={`bac-check${d.key in flags ? ' is-fail' : ''}`}>
              <input type="checkbox" checked={d.key in flags} onChange={() => toggle(d.key)} /> {d.label}
            </label>
            {d.key in flags && (
              <input aria-label={`What needs fixing in ${d.label}`} value={flags[d.key]}
                onChange={e => setFlags(f => ({ ...f, [d.key]: e.target.value }))}
                placeholder="What needs fixing? (e.g. unsigned, illegible scan, wrong file)" />
            )}
          </div>
        ))}
      </fieldset>
      <div className="bac-actions">
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => { setOpen(false); setFlags({}) }}>Cancel</button>
        <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !keys.length}>
          {busy ? 'Sending…' : 'Send request'}
        </button>
      </div>
      {confirm && (
        <ConfirmDialog title={`Ask ${bid.company} to fix ${keys.length} document(s)?`} tone="warning" confirmLabel="Send request" busy={busy}
          points={['The bidder is notified and re-uploads the flagged file(s). The bid is not disqualified.',
            "A resolution can't recommend this bid, and it can't be awarded, until the files are fixed.",
            'The other members are notified when the bidder resubmits, so you can update your evaluations.']}
          onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); send() }} />
      )}
    </form>
  )
}

const REVIEW_LABEL = { needs_revision: ['warning', 'Flagged for revision'], resubmitted: ['info', 'Resubmitted'] }

function EvaluationProject({ status }) {
  const { id } = useParams()
  const [data, setData] = useState(null)
  const [bidFiles, setBidFiles] = useState({})
  const [error, setError] = useState('')
  const load = () => apiBacProject(id).then(setData).catch(e => setError(e.message || 'Could not load.'))
  const loadFiles = () => apiListProjectBids(id)
    .then(list => setBidFiles(Object.fromEntries(list.map(b => [b.id, b])))).catch(() => {})
  useEffect(() => {
    load()
    loadFiles()
  }, [id])  // eslint-disable-line

  if (error) return <div className="bac-page ad-content"><p className="bac-error" role="alert">{error}</p></div>
  if (!data) return <div className="bac-page ad-content"><ListSkeleton rows={4} /></div>

  const seat = data.membership
  const block = evaluationBlock({ workflowEnabled: data.workflow_enabled, seat, lockReason: data.lock_reason })
  const locked = !!block
  const candidate = data.ranking.rows.find(r => r.bid_id === data.ranking.candidate_id)
  const needsPostQual = candidate && !candidate.post_qualification && !data.lock_reason
  return (
    <div className="bac-page ad-content">
      <Link to="/bac/evaluation" className="ui-btn ui-btn--ghost ui-btn--sm" style={{ alignSelf: 'flex-start' }}>
        <ArrowLeft size={14} /> Back to evaluation
      </Link>
      <PageHeader title={`${data.project.code} · ${data.project.name}`}
        description={`ABC ${peso(data.project.budget)} · ${data.project.bid_count} bid(s) · bidding closed ${fmtDate(data.project.deadline)}`} />
      <WorkflowOff status={status} />
      {block
        ? <div className="bac-note bac-note--warning" role="status"><AlertTriangle size={16} /><div><strong>You can&apos;t evaluate this procurement right now</strong><p>{block}</p></div></div>
        : <div className="bac-note bac-note--success" role="status"><ClipboardCheck size={16} /><div><strong>Evaluation is open</strong><p>Check each bid below and press <b>Submit my evaluation</b>. Three passes qualify a bid.</p></div></div>}

      {data.bids.map(bid => {
        const files = bidFiles[bid.id]
        return (
          <section key={bid.id} className="bac-card" aria-labelledby={`b-${bid.id}`}>
            <div className="bac-card-head">
              <div>
                <h3 id={`b-${bid.id}`}>{bid.company} · {peso(bid.amount)}</h3>
                <p>{[bid.brand_name, bid.model_number, bid.warranty_period && `warranty ${bid.warranty_period}`, bid.delivery_timeline && `delivery ${bid.delivery_timeline}`].filter(Boolean).join(' · ') || 'No product details given'}</p>
              </div>
              <StatusBadge domain="bid" status={bid.status} />
            </div>
            <div className="bac-card-body">
              {files?.documents?.length > 0 && (
                <div className="bac-actions" style={{ justifyContent: 'flex-start' }}>
                  {files.documents.filter(d => d.url).map(d => (
                    <span key={d.key} className="bac-actions" style={{ gap: 4 }}>
                      <a href={d.url} className="ui-btn ui-btn--secondary ui-btn--sm"><FileText size={13} /> {d.label}</a>
                      <PreviewButton url={d.url} name={d.label} />
                      {REVIEW_LABEL[d.review_status] && (
                        <StatusBadge tone={REVIEW_LABEL[d.review_status][0]} label={REVIEW_LABEL[d.review_status][1]} />
                      )}
                    </span>
                  ))}
                </div>
              )}
              {files?.documents?.some(d => d.review_status === 'needs_revision') && (
                <div className="bac-hint">
                  Waiting for the bidder to fix: {files.documents.filter(d => d.review_status === 'needs_revision')
                    .map(d => d.review_note ? `${d.label} (${d.review_note})` : d.label).join('; ')}
                </div>
              )}
              {seat && !locked && files?.documents && (
                <RevisionRequest bid={bid} documents={files.documents} onSent={loadFiles} />
              )}
              <div className="bac-hint">
                {bid.tally.passed} passed and {bid.tally.failed} failed of {bid.tally.count} evaluation(s) so far. Three passes qualify the bid.
              </div>
              {bid.evaluations.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--fs-small)' }}>
                  {bid.evaluations.map(e => (
                    <li key={e.member_id}>
                      {e.name} ({e.position}): {'passed' in e ? (e.passed ? 'passed' : `failed${e.remarks ? `: ${e.remarks}` : ''}`) : 'evaluated (shown after you submit yours)'}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <EvaluationForm key={`${bid.id}-${bid.my_evaluation?.updated_at || 'new'}`} bid={bid} mine={bid.my_evaluation} locked={locked} lockedReason={block} onSaved={load} />
          </section>
        )
      })}

      <section className="bac-card" aria-labelledby="rank-h">
        <div className="bac-card-head"><div><h3 id="rank-h">Ranking</h3>
          <p>Computed by the system: bids passed by a majority, lowest amount first. Nobody can reorder it.</p></div></div>
        <div className="bac-card-body"><RankingTable ranking={data.ranking} /></div>
        {needsPostQual && seat?.position === 'chair' && data.workflow_enabled && <PostQualForm candidate={candidate} onSaved={load} />}
        {needsPostQual && seat?.position !== 'chair' && (
          <div className="bac-card-body bac-hint">The Chairperson records the post-qualification of {candidate.company}.</div>
        )}
      </section>
    </div>
  )
}

// ── Voting ────────────────────────────────────────────────────────────────────
function VoteForm({ resolution, onVoted }) {
  const [choice, setChoice] = useState('approve')
  const [comment, setComment] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const send = async () => {
    setBusy(true)
    try {
      const res = await apiBacVote(resolution.id, { choice, comment })
      toast.success(res.status === 'adopted' ? `Vote recorded. ${res.number} is adopted and sent to the Head.` : 'Vote recorded.')
      onVoted()
    } catch (err) {
      toast.error(err.message || 'Could not record your vote.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="bac-card-body" style={{ borderTop: '1px solid var(--border)' }} onSubmit={e => { e.preventDefault(); setConfirm(true) }}>
      <fieldset className="bac-checks">
        <legend className="bac-field" style={{ marginBottom: 6 }}><span style={{ fontWeight: 600 }}>Your vote</span></legend>
        {[['approve', 'Approve'], ['disapprove', 'Disapprove'], ['abstain', 'Abstain']].map(([v, l]) => (
          <label key={v} className={`bac-check${choice === v && v === 'disapprove' ? ' is-fail' : ''}`}>
            <input type="radio" name={`vote-${resolution.id}`} value={v} checked={choice === v} onChange={() => setChoice(v)} /> {l}
          </label>
        ))}
      </fieldset>
      <div className="bac-field">
        <label htmlFor={`c-${resolution.id}`}>Reason for your vote</label>
        <textarea id={`c-${resolution.id}`} value={comment} onChange={e => setComment(e.target.value)} required minLength={10}
          placeholder="e.g. Lowest responsive bid; passed post-qualification; complete documents." />
        <span className="bac-hint">Kept permanently in the BAC Records with your name and position. It can&apos;t be changed later.</span>
      </div>
      <div className="bac-actions"><button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy}>Cast vote</button></div>
      {confirm && (
        <ConfirmDialog title={`Cast your vote: ${choice}?`} confirmLabel="Cast vote" busy={busy}
          tone={choice === 'disapprove' ? 'danger' : 'primary'}
          points={['Your vote and reason are recorded once and can\'t be edited or deleted.',
            'Three approvals adopt the resolution; its PDF is then frozen and sent to the Head.']}
          onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); send() }} />
      )}
    </form>
  )
}

function ResolutionsPage({ status }) {
  const [rows, setRows] = useState(null)
  const load = () => apiBacResolutions({ status: 'voting,adopted,not_adopted,returned' })
    .then(setRows).catch(e => { toast.error(e.message); setRows([]) })
  useEffect(() => { load() }, [])
  const seat = status.membership
  const votedBy = (r) => seat && r.votes.some(v => v.member === seat.id)
  const voting = (rows || []).filter(r => r.status === 'voting')
  const recent = (rows || []).filter(r => r.status !== 'voting').slice(0, 5)
  return (
    <div className="bac-page ad-content">
      <PageHeader title="Resolutions & Voting" description="Vote on resolutions Staff have opened. Each vote needs your reason." />
      <WorkflowOff status={status} />
      <NoSeat status={status} />
      {rows === null ? <ListSkeleton rows={3} />
        : !voting.length ? <div className="bac-card"><EmptyState icon={Gavel} title="Nothing open for voting"
          description="A resolution appears here when Staff open voting on it." /></div>
          : voting.map(r => (
            <section key={r.id} className="bac-card" aria-labelledby={`v-${r.id}`}>
              <div className="bac-card-head"><div><h3 id={`v-${r.id}`}>{r.number}</h3><p>{r.project_code} · {r.project_name}</p></div>
                <ResolutionStatus resolution={r} /></div>
              <div className="bac-card-body">
                <ResolutionFacts resolution={r} />
                <VoteCounts counts={r.counts} majority={status.majority} />
                <VoteList votes={r.votes} user={storedUser()} onChanged={load} />
              </div>
              {seat && status.workflow_enabled && !votedBy(r) && <VoteForm resolution={r} onVoted={load} />}
              {votedBy(r) && <div className="bac-card-body bac-hint">You have voted on this resolution.</div>}
            </section>
          ))}
      {recent.length > 0 && (
        <section className="bac-card" aria-labelledby="recent-h">
          <div className="bac-card-head"><div><h3 id="recent-h">Recently decided</h3></div>
            <Link to="/bac/records" className="rf-card-link">All BAC Records</Link></div>
          <div className="bac-list">{recent.map(r => (
            <div key={r.id} className="bac-list-row" style={{ cursor: 'default' }}>
              <span><strong>{r.number}</strong><span className="sub">{r.project_code} · {r.recommended_company}</span></span>
              <ResolutionStatus resolution={r} />
            </div>))}</div>
        </section>
      )}
    </div>
  )
}

// ── Shell ─────────────────────────────────────────────────────────────────────
export default function BacDashboard() {
  const loc = useLocation()
  const navigate = useNavigate()
  const [navOpen, setNavOpen] = useState(false)
  const status = useBacStatus()
  useEffect(() => { setNavOpen(false) }, [loc.pathname])
  const TITLES = { '/bac': 'Dashboard', '/bac/evaluation': 'Evaluation', '/bac/resolutions': 'Resolutions & Voting', '/bac/records': 'BAC Records' }
  const title = TITLES[loc.pathname.replace(/\/$/, '')] || (loc.pathname.startsWith('/bac/evaluation/') ? 'Bid Evaluation' : 'Dashboard')
  const u = storedUser()
  const user = { name: u.full_name || u.username || 'BAC Member', email: u.email || '',
    role: status.membership ? `BAC ${status.membership.position_label}` : 'BAC Committee' }
  const isActive = (to) => to === '/bac' ? loc.pathname === '/bac' : loc.pathname === to || loc.pathname.startsWith(`${to}/`)
  return (
    <div className="ad-layout">
      <AppSidebar workspace="BAC Committee" logoIcon={Landmark} sections={NAV} isActive={isActive}
        open={navOpen} onClose={() => setNavOpen(false)} />
      {navOpen && <div className="ad-nav-backdrop" onClick={() => setNavOpen(false)} />}
      <div className="ad-main">
        <AppHeader title={title} breadcrumbs={[{ label: 'BAC Committee', to: '/bac' }, { label: title }]}
          onMenu={() => setNavOpen(true)} user={user}
          menu={[{ icon: LogOut, label: 'Log out', danger: true, onClick: () => { apiLogout(); navigate('/login') } }]} />
        <div className="ad-body">
          <Routes>
            <Route index element={<BacHome status={status} />} />
            <Route path="evaluation" element={<EvaluationList status={status} />} />
            <Route path="evaluation/:id" element={<EvaluationProject status={status} />} />
            <Route path="resolutions" element={<ResolutionsPage status={status} />} />
            <Route path="records" element={<BacRecordsPage className="ad-content" />} />
            <Route path="*" element={<BacHome status={status} />} />
          </Routes>
        </div>
      </div>
      <Toaster />
    </div>
  )
}
