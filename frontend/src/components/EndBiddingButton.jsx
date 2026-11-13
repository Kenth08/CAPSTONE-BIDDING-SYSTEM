import { useState } from 'react'
import { TimerOff } from 'lucide-react'
import ConfirmDialog from './ui/ConfirmDialog'
import { endBidding } from '../store/projectsStore'
import {
  END_BIDDING_MESSAGE, END_BIDDING_REASON_LIMIT, END_BIDDING_TITLE, checkReason, endBiddingBlockReason,
} from '../utils/endBidding'

/**
 * "Force End Bidding": ends a published procurement's bidding before its
 * deadline (POST /projects/<id>/end-bidding/, ProjectViewSet.end_bidding).
 *
 * Shown only while bidding is open. For a role that may not end bidding (a BAC
 * Committee member) it stays visible but disabled, with the reason, like the
 * locked Evaluate button. The server checks the role again either way.
 *
 * `project` needs { id, code, status }. `onEnded(updatedApiProject)` runs after
 * success; the caller shows the notification and refreshes its own data.
 */
export default function EndBiddingButton({ project, role, onEnded, className = 'ui-btn ui-btn--secondary ui-btn--sm' }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!project || project.status !== 'published') return null

  const blocked = endBiddingBlockReason(role, project.status)
  const close = () => { if (!busy) { setOpen(false); setReason(''); setError('') } }
  const confirm = async () => {
    const checked = checkReason(reason)
    if (checked.error) { setError(checked.error); return }
    setBusy(true); setError('')
    try {
      const updated = await endBidding(project.id, checked.reason)
      setOpen(false); setReason('')
      onEnded?.(updated)
    } catch (err) {
      // A second click or another tab got there first: the server says it is
      // already closed. Show it here and let the caller refresh.
      setError(err.message || 'Could not end bidding. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className={className} disabled={!!blocked} title={blocked || undefined}
        aria-label={blocked ? `Force End Bidding (unavailable: ${blocked})` : undefined}
        onClick={() => setOpen(true)}>
        <TimerOff size={13} aria-hidden="true" /> Force End Bidding
      </button>
      {open && (
        <ConfirmDialog title={END_BIDDING_TITLE} message={END_BIDDING_MESSAGE} tone="warning"
          confirmLabel="Confirm and End Bidding" busy={busy} confirmDisabled={!reason.trim()}
          points={[
            `${project.code}: the published deadline stays on record, and the actual closing time, your name and this reason are saved.`,
            'Submitted bids and their files are not changed. Bidders can no longer edit or withdraw them.',
            "This is recorded in the audit log and can't be undone.",
          ]}
          onCancel={close} onConfirm={confirm}>
          <div className="rf-dialog-field">
            <label htmlFor={`end-bidding-reason-${project.id}`}>Reason for ending bidding early (required)</label>
            <textarea id={`end-bidding-reason-${project.id}`} value={reason} required maxLength={END_BIDDING_REASON_LIMIT}
              disabled={busy} aria-invalid={!!error} aria-describedby={`end-bidding-hint-${project.id}`}
              placeholder="e.g. Every eligible supplier has already submitted a bid."
              onChange={e => { setReason(e.target.value); if (error) setError('') }} />
            <span id={`end-bidding-hint-${project.id}`} className={error ? 'rf-dialog-error' : 'rf-dialog-hint'} role={error ? 'alert' : undefined}>
              {error || 'Kept on the procurement record and in the audit log.'}
            </span>
          </div>
        </ConfirmDialog>
      )}
    </>
  )
}
