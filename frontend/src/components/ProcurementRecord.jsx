// The procurement record: one procurement from filing to final award, with the
// blockchain evidence for each step — the same component for the Admin, the
// Head and a Supplier. Everything it shows comes from
// GET /projects/{id}/record/, which the SERVER scopes to the caller
// (procurement/record.py); this component never decides what someone may see.
//
// The vocabulary is deliberate and consistent:
//   "Database record"       — an application record (audit-logged), not on-chain
//   "Confirmed on-chain"    — the server read the transaction and found this fingerprint
//   "Transaction reported"  — a tx hash was submitted, not yet checked
//   "Hash recorded, not yet on-chain" — nobody has signed it yet
import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle, ArrowLeft, Award as AwardIcon, CheckCircle2, Clock, Database, ExternalLink, FileSearch,
  FileText, Gavel, Link2, Loader2, Search, ShieldCheck, ShieldX, Trophy, XCircle,
} from 'lucide-react'

import { apiProjectRecord } from '../api'
import { ANCHOR_STATES, anchorChip, anchorState } from '../blockchain/anchorState'
import { legacyDocumentNote, payloadNotStored } from '../blockchain/recordView'
import { contractUrl, txUrl } from '../blockchain/contract'
import { verifyReceipt } from '../blockchain/receipt'
import BlockchainTrail from './BlockchainTrail'
import CopyHash from './ui/CopyHash'
import DataTable from './ui/DataTable'
import EmptyState from './ui/EmptyState'
import InfoTip from './ui/InfoTip'
import KpiCard, { KpiRow } from './ui/KpiCard'
import ProcurementStepper from './ui/ProcurementStepper'
import StatusBadge from './ui/StatusBadge'
import { Skeleton } from './Skeleton'
import { fmtDate, fmtDateTime, peso } from '../utils/format'
import { getCached, loadCached } from '../utils/sessionCache'
import PreviewButton from './ui/FilePreview'
import '../style/procurement-record.css'

const VIEWER_NOTE = {
  admin: 'You see the full record, including every bid and the exact data behind each fingerprint.',
  head: 'You see the award and every bid with its amount and outcome. Bid documents stay with the evaluator.',
  supplier: 'You see your own bid, its outcome and the published result. Other bidders’ details are private.',
}
const PUBLIC_STATUSES = new Set(['published', 'closed', 'awarded'])
// Which anchors each role may sign — mirrors the /anchor/ endpoint permissions:
// project anchors Admin or Head, award anchors Admin only, a bid's anchor its
// own supplier (the record only ever gives a supplier their own bid anchors).
const SIGNABLE = {
  admin: () => true,
  head: (a) => a.entity_type === 'PROJECT',
  supplier: (a) => a.entity_type === 'BID',
}
const DOC_STAGES = ['RESOLUTION_ISSUED', 'NOA_ISSUED', 'NTP_ISSUED']

/** Chip for one anchor: its chain state, or "altered"/"superseded" when the
 *  record check says so — tampering outranks everything else. With `href` it
 *  links to that record's details page. */
function AnchorChip({ anchor, href }) {
  if (!anchor) return null
  let chip
  if (legacyDocumentNote(anchor.verification)) {
    chip = <span className="pr-chip pr-chip-warn" title={anchor.verification.historical.explanation}><AlertTriangle size={11} /> Current file differs</span>
  } else if (payloadNotStored(anchor.verification)) {
    chip = <span className="pr-chip pr-chip-warn" title={anchor.verification.headline}><AlertTriangle size={11} /> Missing evidence</span>
  } else if (anchor.integrity?.status === 'mismatch') {
    chip = <span className="pr-chip pr-chip-bad" title={anchor.integrity.detail}><ShieldX size={11} /> Altered</span>
  } else {
    const shown = anchorChip(anchor)
    const st = shown.state
    const tone = { info: 'info', warning: 'warn', danger: 'bad' }[shown.tone]
    chip = (
      <span className={`pr-chip pr-chip-${tone}`} title={`${anchor.stage_label}: ${shown.title}`}>
        {st === 'verified' ? <ShieldCheck size={11} /> : st === 'mismatch' ? <AlertTriangle size={11} /> : <Link2 size={11} />}
        {' '}{shown.text}
        {anchor.integrity?.status === 'superseded' ? ' · superseded' : ''}
      </span>
    )
  }
  return href
    ? <Link className="pr-chip-link" to={href} aria-label={`${anchor.stage_label}: view blockchain record details`}>{chip}</Link>
    : chip
}

function SourceChips({ event, anchorsById, anchorHref }) {
  if (event.source === 'database') {
    return <span className="pr-chip pr-chip-db"><Database size={11} /> Database record</span>
  }
  return event.anchor_ids.map((id) => <AnchorChip key={id} anchor={anchorsById[id]} href={anchorHref?.(id)} />)
}

function ResultCard({ record }) {
  const r = record.result
  if (!r) {
    return (
      <EmptyState compact icon={Clock} title="No result yet"
        description={record.project.status === 'published'
          ? 'Bidding is still open.' : 'This procurement has not reached the award stage.'} />
    )
  }
  if (r.state === 'closed') {
    return <EmptyState compact icon={Clock} title="Bidding closed" description={r.detail} />
  }
  return (
    <div className="pr-result">
      <div className="pr-result-main">
        <span className="pr-result-icon" aria-hidden="true"><Trophy size={20} /></span>
        <div>
          <div className="pr-result-label">Awarded to</div>
          <div className="pr-result-winner">{r.winner}</div>
          {r.you_won === true && <StatusBadge tone="success" label="Your bid won" />}
          {r.you_won === false && <StatusBadge tone="neutral" label="Your bid was not selected" />}
        </div>
      </div>
      <dl className="pr-result-facts">
        <div><dt>Contract amount</dt><dd>{r.amount ? peso(r.amount) : <span className="pr-muted">Not disclosed to you</span>}</dd></div>
        <div><dt>Awarded</dt><dd>{fmtDate(r.awarded_at)}</dd></div>
        <div><dt>Expected delivery</dt><dd>{r.expected_delivery_date ? fmtDate(r.expected_delivery_date) : '—'}</dd></div>
      </dl>
    </div>
  )
}

/** A bidder re-checks, in their own browser, that their bid is inside the
 *  evaluation commitment that was anchored at award (blockchain/receipt.js). */
function ReceiptCheck({ receipt }) {
  const [state, setState] = useState(null)   // null | 'checking' | result
  if (!receipt) {
    return (
      <p className="pr-muted pr-small">
        No evaluation commitment yet. It is written when a winner is selected.
      </p>
    )
  }
  const run = async () => {
    setState('checking')
    try { setState(await verifyReceipt(receipt)) } catch { setState({ error: true }) }
  }
  const ok = state && state !== 'checking' && !state.error && state.leafOk && state.included && state.commitmentOk
  const chain = anchorState(receipt.anchor)
  return (
    <div className="pr-receipt">
      <p className="pr-small">
        At award, every bid was folded into one salted fingerprint on Sepolia. Your browser can
        recompute it from your own bid details.
      </p>
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={run} disabled={state === 'checking'}>
        {state === 'checking' ? <Loader2 size={13} className="ui-spin" /> : <FileSearch size={13} />}
        {' '}Check my bid is in the commitment
      </button>
      {state && state !== 'checking' && (
        state.error ? <div className="pr-verdict pr-verdict-bad"><XCircle size={15} /> This browser could not compute the hashes.</div> : (
          <div className={`pr-verdict ${ok ? 'pr-verdict-info' : 'pr-verdict-bad'}`}>
            {ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
            <div>
              <strong>{ok ? 'Your bid is inside the anchored commitment.' : 'The receipt does not check out.'}</strong>
              <ul className="pr-checks">
                <li>{state.leafOk ? '✓' : '✗'} Your bid details hash to your leaf</li>
                <li>{state.included ? '✓' : '✗'} Your leaf is one of the {receipt.payload?.bid_count} committed bids</li>
                <li>{state.commitmentOk ? '✓' : '✗'} The commitment hashes to the anchored fingerprint</li>
                <li>{chain === 'verified' ? '✓' : '…'} That fingerprint is {ANCHOR_STATES[chain].text.toLowerCase()}</li>
              </ul>
              <div className="pr-hashline">Fingerprint <CopyHash value={state.commitment} head={12} tail={6} label="commitment hash" /></div>
              {receipt.anchor?.tx_hash && (
                <a className="pr-link" href={txUrl(receipt.anchor.tx_hash)} target="_blank" rel="noopener noreferrer">
                  View the transaction on Sepolia Etherscan <ExternalLink size={11} />
                </a>
              )}
            </div>
          </div>
        )
      )}
    </div>
  )
}

export function ProcurementRecordView({ record, onDeepCheck, deepBusy, anchorHref }) {
  const { project, blockchain, viewer } = record
  const anchors = blockchain.anchors || []
  const anchorsById = Object.fromEntries(anchors.map((a) => [a.id, a]))
  const counts = blockchain.counts || {}
  // A v1/v2 file a revision may have replaced, and a record with no payload to compare,
  // are shown apart: neither is evidence that anything was altered.
  const tampered = Math.max((counts.altered || 0) - (counts.document_differs || 0) - (counts.payload_missing || 0), 0)
  const canCheck = viewer === 'admin' || viewer === 'head'

  // The stepper reads the project's anchors and the award documents' issue
  // dates; derive the latter from the anchors so it works for every viewer.
  const docs = DOC_STAGES.map((stage) => {
    const fromRecord = (record.award_documents || []).find((d) => d.stage === stage)
    const issued = anchors.filter((a) => a.stage === stage).at(-1)
    return { stage, issued_at: fromRecord?.issued_at || issued?.created_at || null }
  })

  const bidColumns = [
    { key: 'supplier', header: viewer === 'supplier' ? 'Bid' : 'Supplier', sortValue: (b) => b.supplier_name,
      render: (b) => <div className="rf-cell-title"><div><strong>{b.supplier_name}</strong>
        <small>{[b.brand_name, b.model_number].filter(Boolean).join(' ') || `Submitted ${fmtDate(b.submitted_at)}`}</small></div></div> },
    { key: 'amount', header: 'Bid amount', align: 'right', sortValue: (b) => Number(b.amount),
      render: (b) => <span className="rf-amount">{peso(b.amount)}</span> },
    { key: 'status', header: 'Outcome', sortValue: (b) => b.status,
      render: (b) => b.is_winner ? <StatusBadge tone="success" icon={AwardIcon} label="Winning bid" /> : <StatusBadge domain="bid" status={b.status} /> },
    { key: 'submitted', header: 'Submitted', hideBelow: 'md', sortValue: (b) => b.submitted_at, render: (b) => fmtDateTime(b.submitted_at) },
    { key: 'reviewed', header: 'Evaluated', hideBelow: 'md', render: (b) => (b.reviewed_at ? fmtDateTime(b.reviewed_at) : '—') },
    { key: 'committed', header: 'On-chain', render: (b) => (b.committed
      ? <span className="pr-chip pr-chip-info" title="This bid is one of the salted leaves in the EVALUATION_COMPLETED fingerprint">In evaluation commitment</span>
      : <span className="pr-chip pr-chip-db"><Database size={11} /> Database record</span>) },
  ]

  return (
    <div className="pr">
      {tampered > 0 && (
        <div className="pr-alert" role="alert">
          <ShieldX size={18} />
          <div>
            <strong>{tampered} step{tampered === 1 ? ' no longer matches' : 's no longer match'} the fingerprint recorded on-chain.</strong>
            <p>The data now stored for the marked step{tampered === 1 ? '' : 's'} was changed after it was recorded. The blockchain entry cannot change, so the change happened afterwards.</p>
          </div>
        </div>
      )}

      <section className="rf-card" aria-labelledby="pr-title">
        <div className="rf-card-body pr-head">
          <div style={{ minWidth: 0 }}>
            <div className="pr-title-row">
              <h2 id="pr-title" className="pr-title">{project.name}</h2>
              <InfoTip label="What you can see" text={VIEWER_NOTE[viewer]} />
              <StatusBadge domain="project" status={project.status} />
            </div>
            <div className="pr-meta">
              <span className="rf-code">{project.code}</span>
              <span>{project.category || '—'}</span>
              <span>ABC <strong>{peso(project.budget)}</strong></span>
              {project.deadline && <span>Deadline {fmtDate(project.deadline)}</span>}
              {record.bid_count != null && <span>{record.bid_count} bid{record.bid_count === 1 ? '' : 's'} received</span>}
            </div>
          </div>
          <div className="pr-head-actions">
            {canCheck && onDeepCheck && (
              <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={onDeepCheck}
                disabled={deepBusy || blockchain.deep_checked}
                title="Re-read every anchored document from storage and re-hash it">
                {deepBusy ? <Loader2 size={13} className="ui-spin" /> : <FileSearch size={13} />}
                {' '}{blockchain.deep_checked ? 'Documents re-checked' : 'Re-check documents'}
              </button>
            )}
            {PUBLIC_STATUSES.has(project.status) && (
              <Link className="ui-btn ui-btn--ghost ui-btn--sm" to={`/public/procurement/${encodeURIComponent(project.code)}`}>
                <Search size={13} /> Public view
              </Link>
            )}
          </div>
        </div>
        <div style={{ padding: '0 20px 16px' }}>
          <ProcurementStepper project={{ ...project, anchors }} award={{ documents: docs }} />
        </div>
      </section>

      <KpiRow cols={4}>
        <KpiCard label="Confirmed on-chain" icon={ShieldCheck} tone={counts.verified ? 'info' : 'neutral'}
          value={`${counts.verified || 0}/${counts.total || 0}`} context="Read back from Sepolia" />
        <KpiCard label="Transaction reported" icon={Link2} tone="info" value={counts.reported || 0}
          context="Not yet checked" />
        <KpiCard label="Awaiting signature" icon={Clock} tone={counts.pending ? 'warning' : 'neutral'} value={counts.pending || 0}
          context="Not yet on-chain" />
        <KpiCard label="Altered" icon={ShieldX} tone={tampered ? 'danger' : 'neutral'} value={tampered}
          context={counts.document_differs ? `${counts.document_differs} current file${counts.document_differs === 1 ? '' : 's'} differ — see each step`
            : counts.superseded ? `${counts.superseded} re-issued — not tampering` : 'Records still match'} />
      </KpiRow>

      <div className="pr-grid">
        <section className="rf-card" aria-labelledby="pr-result-h">
          <div className="rf-card-head"><div><h3 id="pr-result-h">Final result</h3></div></div>
          <div className="rf-card-body"><ResultCard record={record} /></div>
        </section>

        <section className="rf-card" aria-labelledby="pr-docs-h">
          <div className="rf-card-head"><div><h3 id="pr-docs-h">Award documents</h3></div></div>
          <div className="rf-card-body">
            {(record.award_documents || []).length === 0 ? (
              <p className="pr-muted pr-small">
                {record.result?.state === 'awarded'
                  ? 'Available to the winning supplier, the Admin and the Head. The Notice of Award is on the public page.'
                  : 'Issued after the award.'}
              </p>
            ) : (
              <ul className="pr-docs">
                {record.award_documents.map((d) => (
                  <li key={d.key}>
                    <div className="pr-doc-top">
                      <span className="pr-doc-name"><FileText size={13} /> {d.label}</span>
                      {d.url
                        ? <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                            <PreviewButton url={d.url} name={d.label} className="pr-link" />
                            <a className="pr-link" href={d.url}>{d.issued_at ? `Issued ${fmtDate(d.issued_at)}` : 'Download'}</a>
                          </span>
                        : <span className="pr-muted pr-small">Not issued yet</span>}
                    </div>
                    <div className="pr-doc-chips">
                      {d.anchor_ids.map((id, i) => (
                        <span key={id} className="pr-doc-issue">
                          <span className="pr-muted pr-small">{i === d.anchor_ids.length - 1 ? 'Current' : `Issue ${i + 1}`}</span>
                          <AnchorChip anchor={anchorsById[id]} href={anchorHref?.(id)} />
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      <section className="rf-card" aria-labelledby="pr-tl-h">
        <div className="rf-card-head"><div><h3 id="pr-tl-h">Procurement history</h3></div></div>
        <div className="rf-card-body">
          <ol className="pr-timeline">
            {record.timeline.map((e) => (
              <li key={e.key} className={`pr-tl-row pr-tone-${e.tone}`}>
                <span className="pr-tl-dot" aria-hidden="true" />
                <div className="pr-tl-main">
                  <div className="pr-tl-top">
                    <span className="pr-tl-label">{e.label}</span>
                    <span className="pr-tl-chips"><SourceChips event={e} anchorsById={anchorsById} anchorHref={anchorHref} /></span>
                  </div>
                  <div className="pr-tl-when">{e.at ? (String(e.at).length > 10 ? fmtDateTime(e.at) : fmtDate(e.at)) : '—'}</div>
                  {e.detail && <div className="pr-tl-detail">{e.detail}</div>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="pr-bids-h" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="rf-greeting"><div>
          <h3 id="pr-bids-h" style={{ margin: 0, fontSize: 'var(--fs-section-title)', color: 'var(--text-strong)' }}>
            {viewer === 'supplier' ? 'Your bid' : 'Bids & evaluation'}
          </h3>
          <p>
            Database records, fixed together in one on-chain fingerprint at award.{' '}
            <InfoTip label="How bids are recorded" text="The fingerprint is salted. No amounts or names leave this system." />
          </p>
        </div></div>
        <DataTable
          caption={`Bids for ${project.code}`}
          columns={bidColumns}
          rows={record.bids}
          initialSort={{ key: 'amount', dir: 'asc' }}
          empty={{ icon: Gavel, title: 'No bids were received', description: 'Bids appear here once submitted.' }}
        />
      </section>

      {viewer === 'supplier' && (
        <section className="rf-card" aria-labelledby="pr-rc-h">
          <div className="rf-card-head"><div><h3 id="pr-rc-h">Is my bid in the record?</h3></div></div>
          <div className="rf-card-body">
            {(record.receipts || []).map((r) => <ReceiptCheck key={r.bid_id} receipt={r.receipt} />)}
          </div>
        </section>
      )}

      <section className="rf-card" aria-labelledby="pr-chain-h">
        <div className="rf-card-head"><div><h3 id="pr-chain-h">Blockchain evidence</h3>
          <p>{blockchain.network} · chain ID {blockchain.chain_id}{' · '}
            {blockchain.contract_address
              ? <a className="pr-link" href={contractUrl() || `https://sepolia.etherscan.io/address/${blockchain.contract_address}`} target="_blank" rel="noopener noreferrer">
                  ledger {blockchain.contract_address.slice(0, 8)}…{blockchain.contract_address.slice(-6)} <ExternalLink size={11} />
                </a>
              : 'no ledger contract configured on this server'}
          </p></div></div>
        <BlockchainTrail anchors={anchors} entityRef={project.code} projectId={canCheck ? project.id : null}
          title="Anchored steps" canSignAnchor={SIGNABLE[viewer]} />
      </section>
    </div>
  )
}

const recordCacheKey = (id) => `record:${id}`

/** Starts loading a record when someone points at its link, so it's ready sooner. */
export function prefetchRecord(id) {
  loadCached(recordCacheKey(id), () => apiProjectRecord(id)).catch(() => {})
}

/** Route page: /admin/record/:id, /head/record/:id, /supplier/record/:id. */
export default function ProcurementRecordPage({ backTo, backLabel = 'Back', className = '' }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const recordBase = pathname.replace(/\/$/, '')
  const anchorHref = useCallback((aid) => `${recordBase}/anchor/${aid}`, [recordBase])
  // A revisit shows the last answer at once, and the effect below refreshes it.
  const [record, setRecord] = useState(() => getCached(recordCacheKey(id)) ?? null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(() => getCached(recordCacheKey(id)) === undefined)
  const [deepBusy, setDeepBusy] = useState(false)

  useEffect(() => {
    let current = true
    const known = getCached(recordCacheKey(id))
    setRecord(known ?? null)
    setLoading(known === undefined)
    setError('')
    loadCached(recordCacheKey(id), () => apiProjectRecord(id))
      .then((value) => { if (current) setRecord(value) })
      .catch((e) => { if (current) setError(e.message || 'Could not load this procurement record.') })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [id])

  // A deep check isn't kept: it answers "right now", on request.
  const deepCheck = async () => {
    setDeepBusy(true)
    setError('')
    try {
      setRecord(await apiProjectRecord(id, { deep: true }))
    } catch (e) {
      setError(e.message || 'Could not load this procurement record.')
    } finally {
      setDeepBusy(false)
    }
  }

  return (
    <div className={`pr-page rf-home ${className}`}>
      {backTo && (
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm pr-back" onClick={() => navigate(backTo)}>
          <ArrowLeft size={14} /> {backLabel}
        </button>
      )}
      {loading && !record ? (
        <div className="rf-card"><div className="rf-card-body">
          <Skeleton width="40%" height={20} /><Skeleton width="60%" style={{ marginTop: 10 }} />
          <Skeleton width="100%" height={80} style={{ marginTop: 20 }} />
        </div></div>
      ) : error && !record ? (
        <div className="rf-card"><EmptyState icon={Search} title="Procurement record not available"
          description={/not found/i.test(error) ? 'It does not exist, or you are not a participant in it.' : error} /></div>
      ) : record ? (
        <ProcurementRecordView record={record} onDeepCheck={deepCheck} deepBusy={deepBusy} anchorHref={anchorHref} />
      ) : null}
    </div>
  )
}
