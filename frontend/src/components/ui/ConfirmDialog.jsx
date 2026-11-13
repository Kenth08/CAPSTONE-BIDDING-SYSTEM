import { useEffect, useRef } from 'react'
import { AlertTriangle, CheckCircle2, Link2, XCircle } from 'lucide-react'

/**
 * Confirmation for an action that changes a record. `points` lists exactly
 * what will happen; `onChain` adds the line that the step is recorded on the
 * blockchain. tone: primary | danger | warning. `message` is an optional
 * paragraph under the title; `confirmDisabled` keeps Confirm off until the
 * caller's own fields (passed as children, e.g. a required reason) are filled.
 */
export default function ConfirmDialog({
  title, message = '', points = [], onChain = false, confirmLabel = 'Confirm', tone = 'primary', busy = false,
  confirmDisabled = false, onConfirm, onCancel, children,
}) {
  const cancelRef = useRef(null)
  useEffect(() => {
    const opener = document.activeElement
    cancelRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); opener?.focus?.() }
  }, [busy, onCancel])

  const Icon = tone === 'danger' ? XCircle : tone === 'warning' ? AlertTriangle : CheckCircle2
  return (
    <div className="rf-dialog-overlay" onClick={() => !busy && onCancel()}>
      <div className="rf-dialog" role="alertdialog" aria-modal="true" aria-labelledby="rf-dialog-title"
        onClick={(e) => e.stopPropagation()}>
        <div className={`rf-dialog-icon rf-tone-${tone === 'primary' ? 'success' : tone}`} aria-hidden="true"><Icon size={20} /></div>
        <h3 id="rf-dialog-title">{title}</h3>
        {message && <p className="rf-dialog-message">{message}</p>}
        {points.length > 0 && (
          <ul className="rf-dialog-points">
            {points.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        )}
        {children}
        {onChain && (
          <p className="rf-dialog-chain">
            <Link2 size={13} aria-hidden="true" />
            A fingerprint (SHA-256 hash) of this step is recorded on the Sepolia blockchain once signed, so it can't be quietly changed later.
          </p>
        )}
        <div className="rf-dialog-actions">
          <button ref={cancelRef} type="button" className="ui-btn ui-btn--secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className={`ui-btn rf-btn-${tone}`} onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
