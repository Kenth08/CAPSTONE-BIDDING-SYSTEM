import { useState } from 'react'
import { CheckCircle2, ExternalLink, Info, Link2, RotateCw, ShieldCheck } from 'lucide-react'

import { isAnchorBusy, runAnchor, useAnchorActivity } from '../blockchain/anchorStore'
import { txUrl } from '../blockchain/contract'
import './Blockchain.css'

const shortHash = (h) => (h ? `${h.slice(0, 12)}…${h.slice(-6)}` : '—')
const shortTx = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '')
const fmtWhen = (v) =>
  v ? new Date(v).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—'

/**
 * Compact "on the blockchain" badge: how many of a record's lifecycle steps have
 * a confirmed Sepolia transaction. Anything less than all of them is expected
 * and fine — a step is anchored when someone signs it, which may be later.
 */
export function BlockchainBadge({ anchors = [], onClick }) {
  const list = anchors || []
  const done = list.filter((a) => a.anchored).length
  const total = list.length

  const cls = total === 0 ? 'bc-badge-pending' : done === total ? 'bc-badge-anchored' : 'bc-badge-partial'
  const label =
    total === 0
      ? 'Not anchored'
      : done === total
      ? `On-chain · ${done}/${total}`
      : `Partly on-chain · ${done}/${total}`
  const Icon = done > 0 && done === total ? ShieldCheck : Link2

  const content = (
    <span className={`bc-badge ${cls}`} title="Blockchain anchoring status (Sepolia)">
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

/**
 * The full anchor trail for one record: every lifecycle step, its hash, and the
 * transaction that witnesses it on Sepolia. Un-anchored steps offer a retry that
 * re-signs the SAME hash — so retrying never alters what was recorded, it only
 * finishes publishing it.
 */
export default function BlockchainTrail({ anchors = [], title = 'Blockchain Audit Trail', entityRef = '' }) {
  const activity = useAnchorActivity()
  const [retrying, setRetrying] = useState(null)
  const list = anchors || []
  const done = list.filter((a) => a.anchored).length

  const retry = async (anchor) => {
    setRetrying(anchor.id)
    try {
      await runAnchor(anchor, { label: `${anchor.entity_ref} · ${anchor.stage_label || anchor.stage}` })
    } finally {
      setRetrying(null)
    }
  }

  return (
    <div className="bc-panel">
      <div className="bc-panel-head">
        <div className="bc-panel-title">
          <ShieldCheck size={14} /> {title}
          <span className="bc-panel-sub">
            {list.length === 0 ? 'nothing recorded yet' : `${done} of ${list.length} anchored on Sepolia`}
          </span>
        </div>
        <BlockchainBadge anchors={list} />
      </div>

      {list.length === 0 ? (
        <div className="bc-panel-empty">
          No lifecycle events have been recorded for {entityRef || 'this record'} yet.
        </div>
      ) : (
        list.map((a) => (
          <div key={a.id} className={`bc-row${a.anchored ? ' is-anchored' : ''}`}>
            <span className="bc-row-dot" />
            <div className="bc-row-main">
              <div className="bc-row-stage">
                {a.stage_label || a.stage}
                {a.entity_type !== 'PROJECT' && (
                  <span className="bc-panel-sub" style={{ marginLeft: 6 }}>{a.entity_type}</span>
                )}
              </div>
              <div className="bc-row-meta">
                Recorded {fmtWhen(a.created_at)}
                {a.block_number ? ` · block ${a.block_number}` : ''}
              </div>
              <div className="bc-row-hash">
                <span className="bc-hash" title={a.data_hash}>{shortHash(a.data_hash)}</span>
                {a.anchored ? (
                  <a
                    className="bc-txlink"
                    href={a.explorer_url || txUrl(a.tx_hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {shortTx(a.tx_hash)} <ExternalLink size={11} />
                  </a>
                ) : null}
              </div>
            </div>
            <div className="bc-row-side">
              {a.anchored ? (
                <span className="bc-badge bc-badge-anchored"><CheckCircle2 size={11} /> Anchored</span>
              ) : (
                <button
                  className="bc-retry"
                  onClick={() => retry(a)}
                  disabled={retrying === a.id || isAnchorBusy(activity)}
                >
                  <RotateCw size={11} /> {retrying === a.id ? 'Anchoring…' : 'Anchor now'}
                </button>
              )}
            </div>
          </div>
        ))
      )}

      <div className="bc-note">
        <Info size={13} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          Only a SHA-256 hash of each record and its key document is written to the Sepolia
          ledger — never the documents themselves and never personal data. If a record or file
          were altered afterwards, its hash would no longer match the one on-chain.
        </span>
      </div>
    </div>
  )
}
