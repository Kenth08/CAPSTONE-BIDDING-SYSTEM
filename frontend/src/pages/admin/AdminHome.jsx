import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  AlertTriangle, Award, CheckCircle2, ChevronRight, ClipboardCheck, Clock, FileWarning, FolderOpen, Gavel,
  Link2, Loader2, Lock, PiggyBank, RefreshCw, RotateCw, Send, ShieldCheck, UserCheck, Users,
} from 'lucide-react'
import { apiAdminSummary, apiAnchorNextPending } from '../../api'
import { signingBlocked } from '../../blockchain/anchor'
import { runAnchor, isAnchorBusy, useAnchorActivity } from '../../blockchain/anchorStore'
import { storedUser } from '../../components/shell/AppHeader'
import KpiCard, { KpiRow } from '../../components/ui/KpiCard'
import Countdown from '../../components/ui/Countdown'
import ActivityFeed from '../../components/ui/ActivityFeed'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { BarList, ColumnChart, DonutChart, SERIES, STATUS, monthLabel } from '../../components/charts/Charts'
import EmptyState from '../../components/ui/EmptyState'
import { DashGrid, DashHeader, Panel, StageStrip, TabbedPanel, useShowMore } from '../../components/ui/Dashboard'
import RelativeTime from '../../components/ui/RelativeTime'
import { toast } from '../../components/ui/Toaster'
import { ListSkeleton, Skeleton } from '../../components/Skeleton'
import { amount, peso, pesoCompact } from '../../utils/format'
import { getCached, loadCached } from '../../utils/sessionCache'
import { canPrepare, linkForRole, useBacStatus, ws } from '../../utils/workspace'

const ATTN_ICON = {
  evaluate: Gavel, revision: FileWarning, verify: UserCheck, category: Users,
  publish: Send, award_docs: Award, anchor: Link2,
}
const ATTN_LIMIT = 6


export function AttentionList({ items, loading, limit = ATTN_LIMIT, emptyTitle = 'Nothing needs your attention', emptyText }) {
  const [all, setAll] = useState(false)
  if (loading) return <div className="rf-card-body"><ListSkeleton rows={3} height={44} /></div>
  if (!items.length) {
    return <EmptyState compact icon={ShieldCheck} title={emptyTitle} description={emptyText} />
  }
  const shown = all ? items : items.slice(0, limit)
  return (
    <>
      <ul className="rf-attn">
        {shown.map((it, i) => {
          const Icon = it.icon || ATTN_ICON[it.kind] || AlertTriangle
          return (
            <li key={`${it.kind}-${i}`}>
              <Link to={linkForRole(it.link)} className="rf-attn-item">
                <span className={`rf-attn-icon rf-tone-${it.tone}`} aria-hidden="true"><Icon size={16} /></span>
                <span style={{ minWidth: 0 }}>
                  <span className="rf-attn-title">{it.title}</span>
                  <span className="rf-attn-detail" style={{ display: 'block' }}>{it.detail}</span>
                </span>
                <span className="rf-attn-side">
                  {it.since && <RelativeTime value={it.since} />}
                  <ChevronRight size={16} aria-hidden="true" />
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      {items.length > limit && (
        <div className="rf-attn-more">
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
            {all ? 'Show fewer' : `Show all ${items.length}`}
          </button>
        </div>
      )}
    </>
  )
}

// Six months of activity: procurements created and awards made.
function Trend({ trend, loading }) {
  if (loading) return <div className="rf-card-body"><Skeleton height={180} radius={8} /></div>
  return (
    <div className="ch-card-body">
      <ColumnChart ariaLabel="Procurements created and awarded per month"
        series={[{ key: 'created', label: 'Created' }, { key: 'awarded', label: 'Awarded' }]}
        data={(trend || []).map((m) => ({ label: monthLabel(m.month), values: { created: m.created, awarded: m.awarded } }))} />
    </div>
  )
}

// How far "Anchor all" has got. Each step waits about 20 seconds before the next.
function AnchorAllProgress({ remaining, total, finished }) {
  const done = Math.min(Math.max(total - remaining, 0), total)
  const percent = total ? Math.round((done / total) * 100) : 0
  const minutes = Math.ceil((remaining * 20) / 60)
  return (
    <div className={`rf-anchor-progress${finished ? ' is-finished' : ''}`}>
      <div className="rf-anchor-progress-track" role="progressbar" aria-label="Anchor all progress"
        aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={`${done} of ${total} steps done`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <p>
        {finished
          ? <strong className="rf-anchor-progress-done"><CheckCircle2 size={13} aria-hidden="true" /> All {total} steps sent</strong>
          : <><strong>{done} of {total} done</strong>{remaining > 0 && <> · about {minutes} min left. Keep this tab open.</>}</>}
      </p>
    </div>
  )
}

// Replaces the waiting list once nothing is left to sign. "Sent" and "confirmed"
// stay separate: a sent transaction is only a report until the server has read it.
function ChainStatus({ unchecked, verified }) {
  const checking = unchecked > 0
  const Icon = checking ? Clock : CheckCircle2
  return (
    <div className="rf-chain-status" role="status">
      <span className={`rf-attn-icon rf-tone-${checking ? 'info' : 'success'}`} aria-hidden="true"><Icon size={16} /></span>
      <div>
        <strong>
          {checking
            ? `Nothing to sign. ${unchecked} step${unchecked === 1 ? '' : 's'} not checked yet`
            : `All ${verified} steps confirmed on Sepolia`}
        </strong>
        <p>
          {checking
            ? <>Open a procurement&apos;s record and press Check on-chain to confirm them. <Link to={ws('/projects')} className="rf-card-link">Go to Projects</Link></>
            : 'The server has read each transaction back from the ledger.'}
        </p>
      </div>
    </div>
  )
}

function ChainHealth({ chain, loading, onAnchored }) {
  const activity = useAnchorActivity()
  const [busy, setBusy] = useState(null)
  const anchorNow = async (a) => {
    setBusy(a.id)
    const ok = await runAnchor(a, { label: `${a.entity_ref} · ${a.stage_label}` })
    setBusy(null)
    if (ok) { toast.success(`${a.entity_ref} · ${a.stage_label}: transaction submitted. It is confirmed once the server has checked it.`); onAnchored() }
    else toast.error(`${a.entity_ref} · ${a.stage_label} was not anchored. The record is saved — you can retry.`)
  }

  const [confirmAll, setConfirmAll] = useState(false)
  const [allProgress, setAllProgress] = useState(null) // { sent, remaining, total } while running

  // Sends one step at a time and stops at the first problem. Each step is
  // independent, so leaving the page just stops the run; press again to continue.
  const anchorAll = async () => {
    setConfirmAll(false)
    setAllProgress({ sent: 0, remaining: waiting, total: waiting })
    let sent = 0
    let skipped = 0
    let problem = ''
    try {
      for (;;) {
        const res = await apiAnchorNextPending()
        skipped = res.skipped ?? skipped
        if (!res.anchor) break
        if (res.send_state === 'uncertain') {
          problem = `${res.anchor.entity_ref} · ${res.anchor.stage_label}: no clear answer from the network, so it won't be sent again until it has been checked. Stopped here.`
          break
        }
        if (res.send_state === 'sent') sent += 1
        setAllProgress({ sent, remaining: res.remaining, total: Math.max(waiting, res.remaining) })
        if (res.remaining === 0) break
        // Let this transaction be mined and reach every node before the next one
        // reads its nonce. Sepolia blocks take about 12s, and a shorter wait once
        // ended a run with an RPC error right after a block (anchor 17, 2026-11-07).
        await new Promise((resolve) => setTimeout(resolve, 20000))
      }
    } catch (err) {
      problem = err.message || 'Anchoring stopped. Your records are saved. Try again in a moment.'
    }
    // Let the bar reach 100% and say so, rather than vanishing on the last step.
    if (!problem && sent > 0) {
      setAllProgress((p) => ({ ...p, remaining: 0, finished: true }))
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    setAllProgress(null)
    if (sent > 0) toast.success(`${sent} step${sent === 1 ? '' : 's'} sent to Sepolia. Each is confirmed once the server has checked it.`)
    if (skipped > 0) toast.error(`${skipped} step${skipped === 1 ? ' is' : 's are'} already recorded on the blockchain, so ${skipped === 1 ? 'it was' : 'they were'} not sent again.`)
    if (problem) toast.error(problem)
    if (sent === 0 && skipped === 0 && !problem) toast.success('Nothing is waiting to be anchored.')
    onAnchored()
  }

  if (loading) return <div className="rf-card-body"><Skeleton width={132} height={132} radius={66} /></div>
  const { anchored = 0, pending = 0, verified = 0, unchecked = 0, mismatch = 0, incomplete = 0 } = chain || {}
  const items = (chain?.pending_items || []).slice(0, 5)
  const blockedNote = items.map(signingBlocked).find(Boolean) || ''
  const waiting = Math.max(pending - mismatch, 0)
  // Only where the server signs: with MetaMask this would be one popup per step.
  const canAnchorAll = waiting > 1 && items.some((a) => a.server_signing && !signingBlocked(a))
  const running = allProgress !== null
  if (anchored + pending === 0) {
    return <EmptyState compact icon={Link2} title="Nothing recorded yet" description="Procurement steps are listed here as they happen." />
  }
  return (
    <>
      <DonutChart ariaLabel="Blockchain anchoring" centerLabel="STEPS"
        data={[
          { label: 'Confirmed on Sepolia by the server', value: verified, color: STATUS.info, tone: 'info' },
          { label: 'Transaction reported, not yet checked', value: unchecked, color: STATUS.neutral, tone: 'neutral' },
          { label: 'Reported tx does not match', value: mismatch, color: STATUS.danger, tone: 'danger' },
          // `pending` includes mismatches (they need signing again) — count them once.
          { label: 'Waiting for signature', value: Math.max(pending - mismatch, 0), color: STATUS.warning, tone: 'warning' },
        ].filter((s) => s.value > 0 || s.tone === 'info' || s.tone === 'warning')} />
      {incomplete > 0 && (
        <p className="rf-muted" role="note" style={{ fontSize: 'var(--fs-caption)' }}>
          {incomplete} recorded step{incomplete === 1 ? '' : 's'} with incomplete five-document evidence.
        </p>
      )}
      {(canAnchorAll || running) && (
        <div className="rf-anchor-all">
          {!allProgress?.finished && (
            <button type="button" className="ui-btn ui-btn--primary" onClick={() => setConfirmAll(true)}
              disabled={running || busy !== null || isAnchorBusy(activity)} aria-busy={running}>
              {running
                ? <><Loader2 size={14} className="ui-spin" aria-hidden="true" /> Anchoring…</>
                : <><Link2 size={14} aria-hidden="true" /> Anchor all {waiting} steps</>}
            </button>
          )}
          {running && <AnchorAllProgress {...allProgress} />}
        </div>
      )}
      {pending === 0 && !running && <ChainStatus unchecked={unchecked} verified={verified} />}
      {confirmAll && (
        <ConfirmDialog
          title={`Anchor all ${waiting} steps?`}
          points={[
            'The server signs and sends them one at a time, oldest first. No MetaMask needed.',
            'Blockchain entries are permanent and can\'t be removed afterwards.',
            'It stops at the first problem. Your records stay saved, and you can press it again to continue.',
          ]}
          onChain
          confirmLabel="Anchor all"
          onConfirm={anchorAll}
          onCancel={() => setConfirmAll(false)}
        />
      )}
      {items.length > 0 && (
        <ul className="rf-anchor-list">
          {items.map((a) => (
            <li key={a.id} className="rf-anchor-row">
              <div style={{ minWidth: 0 }}>
                <div className="rf-anchor-stage">{a.stage_label}</div>
                <div className="rf-anchor-meta">
                  <span className="rf-code">{a.entity_ref}</span>
                  <span>{a.entity_type === 'PROJECT' ? 'Project' : a.entity_type === 'BID' ? 'Bid' : 'Award'}</span>
                  <span aria-hidden="true">·</span>
                  <RelativeTime value={a.created_at} />
                </div>
              </div>
              <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => anchorNow(a)}
                disabled={!!signingBlocked(a) || busy === a.id || running || isAnchorBusy(activity)}
                title={signingBlocked(a) || undefined}>
                {busy === a.id ? <><Loader2 size={13} className="ui-spin" /> Anchoring…</>
                  : signingBlocked(a) ? <><Lock size={13} /> Signing disabled</>
                  : <><RotateCw size={13} /> Anchor now</>}
              </button>
            </li>
          ))}
          {blockedNote && (
            <li className="rf-muted" role="note" style={{ fontSize: 'var(--fs-caption)' }}>{blockedNote}</li>
          )}
          {pending > items.length && (
            <li className="rf-muted" style={{ fontSize: 'var(--fs-caption)' }}>
              {pending - items.length} more{canAnchorAll ? ' — included in Anchor all.' : " — open a procurement's blockchain trail to anchor older steps."}
            </li>
          )}
        </ul>
      )}
    </>
  )
}

const SUMMARY_CACHE = 'admin:summary'

export default function AdminHome() {
  const bac = useBacStatus()
  // A revisit shows the last summary at once; the effect below refreshes it.
  const [data, setData] = useState(() => getCached(SUMMARY_CACHE) ?? null)
  const [loading, setLoading] = useState(() => getCached(SUMMARY_CACHE) === undefined)
  const [error, setError] = useState('')
  const loc = useLocation()
  const u = storedUser()

  const load = useCallback((options) => {
    setError('')
    return loadCached(SUMMARY_CACHE, () => apiAdminSummary(options))
      .then(setData)
      .catch((e) => setError(e instanceof TypeError ? 'Cannot reach the server. Check your connection and try again.' : e.message || 'Could not load the dashboard.'))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  // /admin#chain (from the attention list) scrolls to Blockchain health.
  useEffect(() => {
    if (loc.hash === '#chain' && !loading) document.getElementById('chain')?.scrollIntoView({ block: 'start' })
  }, [loc.hash, loading])

  const k = data?.kpis || {}
  const savings = data?.savings
  const cats = (data?.categories || []).map((c) => ({
    label: c.category, value: c.count, display: `${c.count} · ${pesoCompact(c.abc)}`,
  }))
  const role = ws('').startsWith('/staff') ? 'staff' : 'admin'
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  // "Incomplete documents" used to be its own card; it is the same suppliers list.
  const supplierContext = [
    k.suppliers_incomplete_documents ? `${k.suppliers_incomplete_documents} with incomplete docs` : '',
    k.category_requests ? plural(k.category_requests, 'category request') : '',
  ].filter(Boolean).join(' · ') || 'Registrations waiting'

  const attention = (
    <Panel id="attn" title="Needs your attention" count={loading ? 0 : data?.attention?.length} countTone="warning">
      <AttentionList items={data?.attention || []} loading={loading}
        emptyText="No suppliers to verify, bids to evaluate or documents to issue right now." />
    </Panel>
  )

  const pipeline = (
    <Panel id="pipe" title="Procurement pipeline" link={{ to: ws('/projects'), label: 'All projects' }}>
      {loading ? <div className="rf-card-body"><ListSkeleton rows={2} height={48} /></div>
        : <StageStrip stages={(data?.pipeline || []).map((s) => ({ ...s, to: `${ws('')}/projects?stage=${s.key}` }))} />}
    </Panel>
  )

  const analytics = (
    <TabbedPanel title="Analytics" link={{ to: ws('/reports'), label: 'Reports' }} tabs={[
      { key: 'trend', label: 'Last six months', render: () => <Trend trend={data?.trend} loading={loading} /> },
      {
        key: 'savings', label: 'Savings against ABC', render: () => (loading ? <div className="rf-card-body"><ListSkeleton rows={3} height={40} /></div>
          : !savings?.rows?.length ? (
            <EmptyState compact icon={PiggyBank} title="No awards yet" description="Savings appear once a winning bid is selected." />
          ) : (
            <>
              <dl className="rf-stat-line">
                <div><dt>Total ABC</dt><dd title={peso(savings.total_abc)}>{pesoCompact(savings.total_abc)}</dd></div>
                <div><dt>Awarded</dt><dd title={peso(savings.total_awarded)}>{pesoCompact(savings.total_awarded)}</dd></div>
                <div><dt>Saved</dt><dd className="is-good" title={peso(savings.total_saved)}>
                  {pesoCompact(savings.total_saved)}{savings.saved_pct != null && ` · ${savings.saved_pct}%`}
                </dd></div>
              </dl>
              {/* Each bar is the awarded amount; the track behind it is that procurement's ABC. */}
              <div className="ch-card-body">
                <BarList ariaLabel="Awarded amount against each ABC" color={SERIES[0]}
                  data={savings.rows.slice(0, SAVINGS_ROWS).map((r) => ({
                    label: r.name, sub: `${r.code} · ${r.supplier}`,
                    value: amount(r.amount), max: amount(r.abc) || 1,
                    display: `${pesoCompact(r.amount)} of ${pesoCompact(r.abc)}${r.saved_pct != null ? ` · ${amount(r.saved) >= 0 ? 'saved' : 'over'} ${Math.abs(r.saved_pct)}%` : ''}`,
                  }))} />
              </div>
              {savings.rows.length > SAVINGS_ROWS && (
                <p className="dash-note">
                  Showing {SAVINGS_ROWS} of {savings.rows.length} awards; the totals above cover all of them.{' '}
                  <Link to={ws('/awards')} className="rf-card-link">All awards</Link>
                </p>
              )}
            </>
          )),
      },
      {
        key: 'cat', label: 'By category', render: () => (loading ? <div className="rf-card-body"><ListSkeleton rows={4} height={18} /></div>
          : cats.length === 0 ? <EmptyState compact icon={FolderOpen} title="No procurements yet" description="Categories appear as procurements are created." />
          : <div className="ch-card-body"><BarList ariaLabel="Procurements per category, with total ABC" color={SERIES[0]} data={cats} /></div>),
      },
    ]} />
  )

  const closing = (
    <Panel id="closing" title="Closing soon" link={{ to: ws('/projects?stage=published'), label: 'All open' }}>
      {loading ? <div className="rf-card-body"><ListSkeleton rows={3} height={44} /></div>
        : !data?.closing_soon?.length ? (
          <EmptyState compact icon={Gavel} title="No open biddings"
            description="Published procurements appear here until their deadline." />
        ) : (
          <ul className="rf-list">
            {data.closing_soon.map((p) => (
              <li key={p.id}>
                <Link to={`${ws('')}/bids/${p.id}`} className="rf-list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                  <span style={{ minWidth: 0 }}>
                    <span className="rf-list-title" style={{ display: 'block' }} title={p.name}>{p.name}</span>
                    <span className="rf-list-sub"><span className="rf-code">{p.code}</span>{p.bids} bid{p.bids === 1 ? '' : 's'}</span>
                  </span>
                  <span className="rf-list-side">
                    <span className="rf-amount" title={peso(p.budget)}>{pesoCompact(p.budget)}</span>
                    <Countdown deadline={p.deadline} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </Panel>
  )

  const chain = (
    <Panel id="chain" title="Blockchain health" link={{ to: '/public', label: 'Public verifier' }} style={{ scrollMarginTop: 80 }}>
      <div className="dash-chain">
        <ChainHealth chain={data?.chain} loading={loading} onAnchored={load} />
      </div>
    </Panel>
  )

  const activity = (
    <Panel id="act" title="Recent activity">
      {loading ? <div className="rf-card-body"><ListSkeleton rows={4} height={36} /></div>
        : <RecentActivity items={data?.activity || []} />}
    </Panel>
  )

  return (
    <div className="ad-content rf-home">
      <DashHeader name={u.full_name || u.username || (role === 'staff' ? 'Procurement Staff' : 'Administrator')}
        actions={<>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { setLoading(true); load({ fresh: true }) }}
            disabled={loading}>
            <RefreshCw size={13} className={loading ? 'ui-spin' : undefined} aria-hidden="true" /> Refresh
          </button>
          {canPrepare(role, bac.workflow_enabled) && (
            <Link to={ws('/planning')} className="ui-btn ui-btn--primary ui-btn--sm"><FolderOpen size={13} aria-hidden="true" /> New procurement</Link>
          )}
        </>} />

      {error && (
        <div className="ui-callout ui-callout--danger" role="alert">
          <AlertTriangle size={18} className="ui-callout-icon" />
          <div>
            <div className="ui-callout-title">The dashboard could not load</div>
            <p>{error}</p>
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => { setLoading(true); load() }}>Try again</button>
          </div>
        </div>
      )}

      {/* No numbers at all rather than misleading zeros when the summary failed. */}
      {(data || !error) && <>
        <KpiRow cols={4}>
          <KpiCard label="Bids to evaluate" icon={ClipboardCheck} loading={loading}
            tone={k.bids_awaiting_on_closed ? 'danger' : k.bids_awaiting_evaluation ? 'warning' : 'neutral'}
            value={k.bids_awaiting_evaluation ?? 0} to={ws('/bids')}
            context={k.bids_awaiting_on_closed ? `${k.bids_awaiting_on_closed} on closed biddings` : 'Undecided bids'} />
          <KpiCard label="Suppliers to verify" icon={UserCheck} loading={loading}
            title="Suppliers with documents missing, expired or expiring within 30 days count as incomplete"
            tone={k.suppliers_incomplete_documents ? 'danger' : k.suppliers_awaiting_verification ? 'warning' : 'neutral'}
            value={k.suppliers_awaiting_verification ?? 0} to={ws('/suppliers')}
            context={supplierContext} />
          <KpiCard label="Open biddings" icon={Gavel} tone="info" loading={loading}
            value={k.open_biddings ?? 0} to={ws('/projects?stage=published')} title={`Open budgets (ABC): ${peso(k.open_abc)}`}
            context={`${pesoCompact(k.open_abc)} ABC · ${k.closing_this_week || 'none'} closing this week`} />
          <KpiCard label="Not yet on-chain" icon={Link2} loading={loading}
            tone={k.anchors_pending ? 'warning' : 'neutral'}
            value={k.anchors_pending ?? 0} to={ws('#chain')}
            context={k.anchors_pending ? 'Waiting for a signature' : data?.chain?.anchored ? 'All steps reported' : 'Nothing recorded yet'} />
        </KpiRow>

        <DashGrid
          main={<>{attention}{pipeline}{analytics}</>}
          side={<>{closing}{chain}{activity}</>} />
      </>}
    </div>
  )
}

const SAVINGS_ROWS = 6
const ACTIVITY_ROWS = 6

// The newest few audit-log entries, with the rest one click away.
function RecentActivity({ items }) {
  const [shown, more] = useShowMore(items, ACTIVITY_ROWS)
  return <><ActivityFeed items={shown} />{more}</>
}
