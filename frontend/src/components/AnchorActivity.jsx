import { useEffect } from 'react'
import { Check, ExternalLink, Link2, Loader2, RotateCw, ShieldAlert, X } from 'lucide-react'

import { dismissAnchorActivity, isAnchorBusy, retryAnchor, useAnchorActivity } from '../blockchain/anchorStore'
import { txUrl } from '../blockchain/contract'
import './Blockchain.css'

const shortTx = (tx) => (tx ? `${tx.slice(0, 10)}…${tx.slice(-6)}` : '')

// Per-phase presentation. `tone` drives the accent colour; `retry` decides
// whether the card offers a retry button.
const PHASES = {
  signing:     { title: 'Waiting for MetaMask',  tone: '',        spin: true },
  mining:      { title: 'Anchoring on Sepolia',  tone: '',        spin: true },
  saving:      { title: 'Saving the reference',  tone: '',        spin: true },
  done:        { title: 'Anchored on-chain',     tone: 'is-done' },
  rejected:    { title: 'Not anchored',          tone: 'is-warn',  retry: true },
  unavailable: { title: 'Not anchored',          tone: 'is-warn',  retry: true },
  unsaved:     { title: 'Anchored, not saved',   tone: 'is-warn',  retry: true },
  error:       { title: 'Anchoring failed',      tone: 'is-error', retry: true },
}

/**
 * Floating card that reports the blockchain anchoring of the last status change.
 *
 * Mounted once per dashboard. It never blocks anything: by the time it appears
 * the procurement change is already saved, so this only ever reports on the
 * optional on-chain witness — including "declined / no wallet", which is a valid
 * state the user can retry from here or from the record's own badge.
 */
export default function AnchorActivity() {
  const activity = useAnchorActivity()

  // A success dismisses itself after a while (long enough to read the tx hash
  // and click through to Etherscan). Anything the user might want to act on —
  // declined, failed, unsaved — stays until they close or retry it.
  useEffect(() => {
    if (activity?.state !== 'done') return
    const timer = setTimeout(dismissAnchorActivity, 12000)
    return () => clearTimeout(timer)
  }, [activity?.state, activity?.txHash])

  if (!activity) return null

  const phase = PHASES[activity.state] || PHASES.error
  const busy = isAnchorBusy(activity)
  const url = activity.explorerUrl || txUrl(activity.txHash)

  const Icon = phase.spin
    ? Loader2
    : activity.state === 'done'
    ? Check
    : activity.state === 'error'
    ? ShieldAlert
    : Link2

  return (
    <div className={`bc-activity ${phase.tone}`} role="status" aria-live="polite">
      <span className="bc-activity-icon">
        <Icon size={17} className={phase.spin ? 'bc-spin' : undefined} />
      </span>
      <div className="bc-activity-body">
        <div className="bc-activity-title">{phase.title}</div>
        {activity.label && <div className="bc-activity-label">{activity.label}</div>}
        <div className="bc-activity-msg">{activity.message}</div>
        {(url || phase.retry) && (
          <div className="bc-activity-actions">
            {url && (
              <a className="bc-txlink" href={url} target="_blank" rel="noopener noreferrer">
                {shortTx(activity.txHash)} <ExternalLink size={11} />
              </a>
            )}
            {phase.retry && (
              <button className="bc-retry" onClick={retryAnchor} disabled={busy}>
                <RotateCw size={11} /> Retry anchoring
              </button>
            )}
          </div>
        )}
      </div>
      {!busy && (
        <button className="bc-activity-close" onClick={dismissAnchorActivity} aria-label="Dismiss">
          <X size={14} />
        </button>
      )}
    </div>
  )
}
