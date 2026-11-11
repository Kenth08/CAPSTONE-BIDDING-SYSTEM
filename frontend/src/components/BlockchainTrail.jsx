import { useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Clock, ExternalLink, Info, Link2, Loader2, Lock, RotateCw, Search, ShieldCheck,
} from 'lucide-react'
import CopyHash from './ui/CopyHash'
import InfoTip from './ui/InfoTip'

import { apiVerifyProjectChain } from '../api'
import { ANCHOR_STATES, anchorChip, anchorState, canSign, hasIncompleteEvidence } from '../blockchain/anchorState'
import { signingBlocked } from '../blockchain/signingState'
import { isAnchorBusy, runAnchor, useAnchorActivity } from '../blockchain/anchorStore'
import { txUrl } from '../blockchain/contract'
import './Blockchain.css'

const shortTx = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '')
const fmtWhen = (v) =>
  v ? new Date(v).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—'

/**
 * Compact "on the blockchain" badge. Counts only steps the SERVER has confirmed
 * on-chain (receipt + matching AnchorRecorded event) — a stored tx hash alone
 * is a "reported" transaction, not proof. Never green: see anchorState.js.
 */
export function BlockchainBadge({ anchors = [], onClick }) {
  const list = anchors || []
  const total = list.length
  const states = list.map(anchorState)
  const verified = states.filter((s) => s === 'verified').length
  const mismatched = states.includes('mismatch')
  const incomplete = list.filter(hasIncompleteEvidence).length

  const cls = total === 0 ? 'bc-badge-pending'
    : mismatched ? 'bc-badge-bad'
    : incomplete ? 'bc-badge-partial'
    : verified === total ? 'bc-badge-anchored'
    : 'bc-badge-partial'
  const label =
    total === 0 ? 'Not anchored'
    : mismatched ? `Check needed · ${verified}/${total} confirmed`
    : incomplete ? `${verified}/${total} confirmed · ${incomplete} with incomplete evidence`
    : verified === total ? `Confirmed on-chain · ${verified}/${total}`
    : `${verified}/${total} confirmed on-chain`
  const Icon = mismatched ? AlertTriangle : verified > 0 && verified === total ? ShieldCheck : Link2

  const content = (
    <span className={`bc-badge ${cls}`} title="Steps whose Sepolia transaction the server has read back and confirmed">
      <Icon size={12} /> {label}
    </span>
  )
  if (!onClick) return content
  return (
    <button type="button" onClick={onClick} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>
      {content}
    </button>
  )
}

// Award documents can be issued again (generated draft → signed copy); each
// issue appends a new anchor. The earlier ones are genuine but no longer
// current, mirroring blockchain.superseding_anchor on the server.
const REISSUABLE_STAGES = new Set(['RESOLUTION_ISSUED', 'NOA_ISSUED', 'NTP_ISSUED'])

/** Ids of anchors that a later anchor for the same award document replaced. */
export function supersededAnchorIds(anchors = []) {
  const latest = {}
  for (const a of anchors) {
    if (a.entity_type !== 'AWARD' || !REISSUABLE_STAGES.has(a.stage)) continue
    const key = `${a.entity_id}:${a.stage}`
    if (!latest[key] || a.id > latest[key]) latest[key] = a.id
  }
  return new Set(anchors
    .filter((a) => a.entity_type === 'AWARD' && REISSUABLE_STAGES.has(a.stage)
      && latest[`${a.entity_id}:${a.stage}`] !== a.id)
    .map((a) => a.id))
}

const ROW_CLS = { verified: 'is-anchored', reported: 'is-reported', mismatch: 'is-bad', pending: 'is-pending' }
const CHIP_CLS = { verified: 'bc-badge-anchored', reported: 'bc-badge-reported', mismatch: 'bc-badge-bad', pending: 'bc-badge-pending' }

/**
 * The full anchor trail for one record: every lifecycle step, its hash, and the
 * transaction that witnesses it on Sepolia. Un-anchored steps offer a retry that
 * re-signs the SAME hash — so retrying never alters what was recorded, it only
 * finishes publishing it.
 *
 * `projectId` (Admin/Head only) adds "Check on-chain": the server reads every
 * reported transaction back from Sepolia and confirms it really records its
 * step. The refreshed anchors are shown in place.
 *
 * `canSignAnchor(anchor)` limits "Anchor now" to anchors the viewer's role may
 * actually attach (the /anchor/ endpoints enforce it; this just avoids
 * offering a button the server would refuse). Defaults to every anchor.
 */
export default function BlockchainTrail({
  anchors = [], title = 'Blockchain Audit Trail', entityRef = '', projectId = null, onChecked,
  canSignAnchor = () => true,
}) {
  const activity = useAnchorActivity()
  const [retrying, setRetrying] = useState(null)
  const [checking, setChecking] = useState(false)
  const [checkNote, setCheckNote] = useState('')
  const [checked, setChecked] = useState(null)   // anchors returned by the last check, by id

  const list = (anchors || []).map((a) => checked?.[a.id] || a)
  const states = Object.fromEntries(list.map((a) => [a.id, anchorState(a)]))
  const verified = list.filter((a) => states[a.id] === 'verified').length
  const reported = list.filter((a) => states[a.id] === 'reported').length
  const superseded = supersededAnchorIds(list)
  // Read-only deployment: "Anchor now" stays visible but disabled, with one
  // explanation for the whole trail instead of a wallet prompt.
  const signable = list.filter((a) => canSign(a) && canSignAnchor(a))
  const blockedNote = signable.map(signingBlocked).find(Boolean) || ''

  const retry = async (anchor) => {
    setRetrying(anchor.id)
    try {
      await runAnchor(anchor, { label: `${anchor.entity_ref} · ${anchor.stage_label || anchor.stage}` })
    } finally {
      setRetrying(null)
    }
  }

  const checkOnChain = async () => {
    setChecking(true); setCheckNote('')
    try {
      const res = await apiVerifyProjectChain(projectId)
      setChecked(Object.fromEntries((res.anchors || []).map((a) => [a.id, a])))
      const n = (res.checked || []).length
      setCheckNote(res.detail || (n === 0
        ? 'Nothing to check — no reported transactions are waiting for confirmation.'
        : `Checked ${n} transaction${n === 1 ? '' : 's'} against Sepolia.`))
      onChecked?.(res.anchors || [])
    } catch (err) {
      setCheckNote(err?.message || 'Could not reach the server to check the chain.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="bc-panel">
      <div className="bc-panel-head">
        <div className="bc-panel-title">
          <span className="bc-panel-icon" aria-hidden="true"><ShieldCheck size={15} /></span>
          <span>
            <span className="bc-panel-name">{title}</span>
            <span className="bc-panel-sub">
              {list.length === 0
                ? 'Nothing recorded yet'
                : `${verified} of ${list.length} confirmed on Sepolia${reported ? ` · ${reported} reported, not yet checked` : ''}`}
            </span>
          </span>
        </div>
        <div className="bc-panel-actions">
          {projectId && list.some((a) => a.tx_hash) && (
            <button type="button" className="bc-check" onClick={checkOnChain} disabled={checking}
              title="Read each reported transaction back from Sepolia and confirm it records this step">
              {checking ? <Loader2 size={12} className="bc-spin" /> : <Search size={12} />}
              {checking ? 'Checking…' : 'Check on-chain'}
            </button>
          )}
          <BlockchainBadge anchors={list} />
        </div>
      </div>
      {checkNote && <div className="bc-check-note" role="status">{checkNote}</div>}
      {blockedNote && (
        <div className="bc-check-note bc-signing-off" role="note" id="bc-signing-off-note">
          <Info size={12} aria-hidden="true" /> {blockedNote}
        </div>
      )}

      {list.length === 0 ? (
        <div className="bc-panel-empty">
          <span className="bc-panel-empty-icon" aria-hidden="true"><Link2 size={18} /></span>
          <span>No lifecycle events have been recorded for {entityRef || 'this record'} yet.</span>
        </div>
      ) : (
        <ol className="bc-timeline">
          {list.map((a) => {
            const st = states[a.id]
            const chip = anchorChip(a)
            return (
              <li key={a.id} className={`bc-row ${ROW_CLS[st]}`}>
                <span className="bc-row-marker" aria-hidden="true">
                  {st === 'verified' ? <CheckCircle2 size={14} />
                    : st === 'mismatch' ? <AlertTriangle size={13} />
                    : <Clock size={13} />}
                </span>
                <div className="bc-row-main">
                  <div className="bc-row-top">
                    <div className="bc-row-stage">
                      {a.stage_label || a.stage}
                      {a.entity_type !== 'PROJECT' && (
                        <span className="bc-row-entity">{a.entity_type}</span>
                      )}
                      {superseded.has(a.id) && (
                        <span className="bc-row-entity" title="Issued again later — the newer version is the current one">
                          Superseded
                        </span>
                      )}
                    </div>
                    <div className="bc-row-side">
                      {st !== 'pending' && (
                        <span className={`bc-badge ${chip.tone === 'warning' ? 'bc-badge-partial' : CHIP_CLS[st]}`} title={chip.title}>
                          {st === 'verified' && <ShieldCheck size={11} />} {chip.text}
                        </span>
                      )}
                      {canSign(a) && canSignAnchor(a) && (
                        <button
                          className="bc-retry"
                          onClick={() => retry(a)}
                          disabled={!!signingBlocked(a) || retrying === a.id || isAnchorBusy(activity)}
                          title={signingBlocked(a) || undefined}
                          aria-describedby={signingBlocked(a) ? 'bc-signing-off-note' : undefined}
                        >
                          {retrying === a.id
                            ? <><Loader2 size={12} className="bc-spin" /> Anchoring…</>
                            : signingBlocked(a)
                            ? <><Lock size={12} /> Signing disabled</>
                            : <><RotateCw size={12} /> Anchor now</>}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="bc-row-meta">
                    <time dateTime={a.created_at || undefined}>Recorded {fmtWhen(a.created_at)}</time>
                    {st === 'verified' && a.block_number ? <span> · Block {a.block_number}</span> : null}
                    {a.chain_checked_at ? <span> · Checked {fmtWhen(a.chain_checked_at)}</span> : null}
                    {st === 'pending' && (a.chain_status === 'reverted' || a.chain_status === 'dropped') && (
                      <span> · Last attempt {a.chain_status === 'reverted' ? 'failed on-chain' : 'was never mined'}</span>
                    )}
                  </div>
                  <div className="bc-row-hash">
                    <span className="bc-row-hash-label">Hash</span>
                    <CopyHash value={a.data_hash} head={12} tail={6} label="data hash" />
                    {a.tx_hash ? (
                      <a
                        className="bc-txlink"
                        href={a.explorer_url || txUrl(a.tx_hash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`View transaction ${a.tx_hash} on Etherscan`}
                      >
                        Tx {shortTx(a.tx_hash)} <ExternalLink size={11} />
                      </a>
                    ) : (
                      <span className="bc-row-wait">{ANCHOR_STATES.pending.text}</span>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      <div className="bc-note">
        <Info size={13} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          Only SHA-256 fingerprints go on-chain, never documents, amounts or names.{' '}
          <InfoTip label="What the statuses mean" size={13}
            text="“Confirmed on-chain”: the server read the transaction back and found exactly this fingerprint. “Transaction reported”: a transaction hash was submitted but not yet checked." />
        </span>
      </div>
    </div>
  )
}
