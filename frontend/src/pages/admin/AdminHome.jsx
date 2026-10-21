import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  AlertTriangle, ArrowRight, Award, ChevronRight, ClipboardCheck, FileWarning, FolderOpen, Gavel,
  Link2, Loader2, PiggyBank, RefreshCw, RotateCw, Send, ShieldCheck, UserCheck, Users, Wallet,
} from 'lucide-react'
import { apiAdminSummary } from '../../api'
import { runAnchor, isAnchorBusy, useAnchorActivity } from '../../blockchain/anchorStore'
import { storedUser } from '../../components/shell/AppHeader'
import KpiCard, { KpiRow } from '../../components/ui/KpiCard'
import Countdown from '../../components/ui/Countdown'
import ActivityFeed from '../../components/ui/ActivityFeed'
import { BarChart, Donut } from '../../components/ui/Charts'
import EmptyState from '../../components/ui/EmptyState'
import RelativeTime from '../../components/ui/RelativeTime'
import { toast } from '../../components/ui/Toaster'
import { ListSkeleton, Skeleton } from '../../components/Skeleton'
import { amount, greeting, peso, pesoCompact, todayLong } from '../../utils/format'

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
              <Link to={it.link} className="rf-attn-item">
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

function Pipeline({ stages, loading }) {
  const navigate = useNavigate()
  if (loading) return <div className="rf-pipeline">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} height={74} radius={8} />)}</div>
  const max = Math.max(1, ...stages.map((s) => s.count))
  return (
    <div className="rf-pipeline" role="list" aria-label="Projects by stage">
      {stages.map((s) => (
        <button key={s.key} type="button" role="listitem" className={`rf-pipe-stage${s.count === 0 ? ' is-empty' : ''}`}
          onClick={() => navigate(`/admin/projects?stage=${s.key}`)}
          aria-label={`${s.label}: ${s.count} project${s.count === 1 ? '' : 's'}. Show them`}>
          <span className="rf-pipe-count">{s.count}</span>
          <span className="rf-pipe-label">{s.label}</span>
          <span className="rf-pipe-bar" aria-hidden="true"><span style={{ width: `${(s.count / max) * 100}%` }} /></span>
        </button>
      ))}
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
    if (ok) { toast.success(`${a.entity_ref} · ${a.stage_label} recorded on-chain.`); onAnchored() }
    else toast.error(`${a.entity_ref} · ${a.stage_label} was not anchored. The record is saved — you can retry.`)
  }
  if (loading) return <div className="rf-card-body"><Skeleton width={132} height={132} radius={66} /></div>
  const { anchored = 0, pending = 0 } = chain || {}
  const items = (chain?.pending_items || []).slice(0, 5)
  if (anchored + pending === 0) {
    return <EmptyState compact icon={Link2} title="Nothing recorded yet" description="Each procurement step is hashed and listed here once it happens." />
  }
  return (
    <>
      <Donut title="Blockchain anchoring" centerLabel="STEPS"
        segments={[{ label: 'Anchored on Sepolia', value: anchored, tone: 'success' }, { label: 'Waiting for signature', value: pending, tone: 'warning' }]} />
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
                disabled={busy === a.id || isAnchorBusy(activity)}>
                {busy === a.id ? <><Loader2 size={13} className="ui-spin" /> Anchoring…</> : <><RotateCw size={13} /> Anchor now</>}
              </button>
            </li>
          ))}
          {pending > items.length && (
            <li className="rf-muted" style={{ fontSize: 'var(--fs-caption)' }}>
              {pending - items.length} more — open a procurement's blockchain trail to anchor older steps.
            </li>
          )}
        </ul>
      )}
    </>
  )
}

export default function AdminHome() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const loc = useLocation()
  const u = storedUser()

  const load = useCallback(() => {
    setError('')
    return apiAdminSummary()
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

  return (
    <div className="ad-content rf-home">
      <div className="rf-greeting">
        <div>
          <h2>{greeting()}, {u.full_name || u.username || 'Administrator'}</h2>
          <p>{todayLong()} · BAC Secretariat workspace</p>
        </div>
        <div className="rf-greeting-actions">
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { setLoading(true); load() }}>
            <RefreshCw size={13} /> Refresh
          </button>
          <Link to="/admin/planning" className="ui-btn ui-btn--primary ui-btn--sm"><FolderOpen size={13} /> New procurement</Link>
        </div>
      </div>

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
      <KpiRow cols={6}>
        <KpiCard label="Open biddings" icon={Gavel} tone="info" loading={loading}
          value={k.open_biddings ?? 0} to="/admin/projects?stage=published"
          context={k.closing_this_week ? `${k.closing_this_week} closing this week` : 'None closing this week'} />
        <KpiCard label="Bids awaiting evaluation" icon={ClipboardCheck} loading={loading}
          tone={k.bids_awaiting_on_closed ? 'danger' : k.bids_awaiting_evaluation ? 'warning' : 'neutral'}
          value={k.bids_awaiting_evaluation ?? 0} to="/admin/bids"
          context={k.bids_awaiting_on_closed ? `${k.bids_awaiting_on_closed} on closed biddings` : 'Undecided bids'} />
        <KpiCard label="Suppliers to verify" icon={UserCheck} loading={loading}
          tone={k.suppliers_awaiting_verification ? 'warning' : 'neutral'}
          value={k.suppliers_awaiting_verification ?? 0} to="/admin/suppliers"
          context={k.category_requests ? `+${k.category_requests} category request${k.category_requests === 1 ? '' : 's'}` : 'Registrations waiting'} />
        <KpiCard label="Incomplete documents" icon={FileWarning} loading={loading}
          tone={k.suppliers_incomplete_documents ? 'danger' : 'neutral'}
          value={k.suppliers_incomplete_documents ?? 0} to="/admin/suppliers"
          context="Suppliers missing, expired or expiring ≤30 days" />
        <KpiCard label="Not yet on-chain" icon={Link2} loading={loading}
          tone={k.anchors_pending ? 'warning' : 'success'}
          value={k.anchors_pending ?? 0} to="/admin#chain"
          context={k.anchors_pending ? 'Steps waiting for a signature' : data?.chain?.anchored ? 'Every step is anchored' : 'Nothing recorded yet'} />
        <KpiCard label="ABC of open biddings" icon={Wallet} loading={loading}
          value={pesoCompact(k.open_abc)} title={peso(k.open_abc)} to="/admin/projects?stage=published"
          context={`Across ${k.open_biddings ?? 0} open bidding${k.open_biddings === 1 ? '' : 's'}`} />
      </KpiRow>

      <div className="rf-grid-2">
        <section className="rf-card" aria-labelledby="attn-h">
          <div className="rf-card-head">
            <div><h3 id="attn-h">Needs your attention</h3><p>Most urgent first — each item opens the screen where you act</p></div>
            {!loading && data?.attention?.length > 0 && <span className="ui-badge ui-badge--warning">{data.attention.length}</span>}
          </div>
          <AttentionList items={data?.attention || []} loading={loading}
            emptyText="No suppliers to verify, bids to evaluate or documents to issue right now." />
        </section>

        <section className="rf-card" aria-labelledby="closing-h">
          <div className="rf-card-head">
            <div><h3 id="closing-h">Closing soon</h3><p>Published biddings by deadline</p></div>
            <Link to="/admin/projects?stage=published" className="rf-card-link">All open <ChevronRight size={13} /></Link>
          </div>
          {loading ? <div className="rf-card-body"><ListSkeleton rows={3} height={44} /></div>
            : !data?.closing_soon?.length ? (
              <EmptyState compact icon={Gavel} title="No open biddings"
                description="Publish an approved procurement to open it for bidding."
                action={<Link to="/admin/projects" className="ui-btn ui-btn--secondary ui-btn--sm">Go to Projects</Link>} />
            ) : (
              <ul className="rf-list">
                {data.closing_soon.map((p) => (
                  <li key={p.id}>
                    <Link to={`/admin/bids/${p.id}`} className="rf-list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                      <span style={{ minWidth: 0 }}>
                        <span className="rf-list-title" style={{ display: 'block' }}>{p.name}</span>
                        <span className="rf-list-sub"><span className="rf-code">{p.code}</span>{p.bids} bid{p.bids === 1 ? '' : 's'}</span>
                      </span>
                      <span className="rf-list-side">
                        <span className="rf-amount">{peso(p.budget)}</span>
                        <Countdown deadline={p.deadline} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>

      <section className="rf-card" aria-labelledby="pipe-h">
        <div className="rf-card-head">
          <div><h3 id="pipe-h">Procurement pipeline</h3><p>How many procurements are at each stage — select a stage to see them</p></div>
        </div>
        <Pipeline stages={data?.pipeline || []} loading={loading} />
      </section>

      <div className="rf-grid-2-even">
        <section className="rf-card" aria-labelledby="sav-h">
          <div className="rf-card-head">
            <div><h3 id="sav-h">Savings against the ABC</h3><p>Approved budget vs awarded amount</p></div>
            <Link to="/admin/awards" className="rf-card-link">Awards <ChevronRight size={13} /></Link>
          </div>
          {loading ? <div className="rf-card-body"><ListSkeleton rows={3} height={40} /></div>
            : !savings?.rows?.length ? (
              <EmptyState compact icon={PiggyBank} title="No awards yet"
                description="Savings appear once a winning bid is selected." />
            ) : (
              <>
                <dl className="rf-stat-line">
                  <div><dt>Total ABC</dt><dd title={peso(savings.total_abc)}>{pesoCompact(savings.total_abc)}</dd></div>
                  <div><dt>Awarded</dt><dd title={peso(savings.total_awarded)}>{pesoCompact(savings.total_awarded)}</dd></div>
                  <div><dt>Saved</dt><dd className="is-good" title={peso(savings.total_saved)}>
                    {pesoCompact(savings.total_saved)}{savings.saved_pct != null && ` · ${savings.saved_pct}%`}
                  </dd></div>
                </dl>
                <ul className="rf-list">
                  {savings.rows.map((r) => (
                    <li key={r.code} className="rf-list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                      <span style={{ minWidth: 0 }}>
                        <span className="rf-list-title" style={{ display: 'block' }}>{r.name}</span>
                        <span className="rf-list-sub"><span className="rf-code">{r.code}</span>{r.supplier}</span>
                      </span>
                      <span className="rf-list-side">
                        <span className="rf-amount">{peso(r.amount)} <span className="rf-muted" style={{ fontWeight: 400 }}>of {peso(r.abc)}</span></span>
                        <span className={amount(r.saved) >= 0 ? 'rf-diff is-under' : 'rf-diff is-over'}>
                          {amount(r.saved) >= 0 ? 'Saved' : 'Over'} {peso(Math.abs(amount(r.saved)))}{r.saved_pct != null && ` (${Math.abs(r.saved_pct)}%)`}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
        </section>

        <section className="rf-card" aria-labelledby="cat-h">
          <div className="rf-card-head">
            <div><h3 id="cat-h">By category</h3><p>Number of procurements · total ABC</p></div>
          </div>
          {loading ? <div className="rf-card-body"><ListSkeleton rows={4} height={18} /></div>
            : cats.length === 0 ? <EmptyState compact icon={FolderOpen} title="No procurements yet" description="Categories appear as procurements are created." />
            : <BarChart title="Procurements per category" data={cats} />}
        </section>
      </div>

      <div className="rf-grid-2-even">
        <section className="rf-card" aria-labelledby="act-h">
          <div className="rf-card-head">
            <div><h3 id="act-h">Recent activity</h3><p>From the audit log — who did what, when</p></div>
          </div>
          {loading ? <div className="rf-card-body"><ListSkeleton rows={4} height={36} /></div>
            : <ActivityFeed items={data?.activity || []} />}
        </section>

        <section className="rf-card" id="chain" aria-labelledby="chain-h" style={{ scrollMarginTop: 80 }}>
          <div className="rf-card-head">
            <div><h3 id="chain-h">Blockchain health</h3><p>Lifecycle steps anchored on Ethereum Sepolia</p></div>
            <Link to="/public" className="rf-card-link">Public verifier <ArrowRight size={13} /></Link>
          </div>
          <ChainHealth chain={data?.chain} loading={loading} onAnchored={load} />
        </section>
      </div>
      </>}
    </div>
  )
}
