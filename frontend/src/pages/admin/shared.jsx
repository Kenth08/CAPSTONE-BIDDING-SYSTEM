import { memo, useState, useEffect } from 'react'
import { ws } from '../../utils/workspace'
import {
  FileText, X, CheckCircle2, AlertTriangle, XCircle, Check, Clock, Copy,
} from 'lucide-react'
import { LocalPreviewButton } from '../../components/ui/FilePreview'

// Session cache keys shared by the pages that show the same lists (Suppliers,
// Awards and Reports), so a list fetched on one is on screen at once on another.
export const SUPPLIERS_CACHE = 'admin:suppliers'
export const AWARDS_CACHE = 'admin:awards'

export const workspaceRole = () => (ws('').startsWith('/staff') ? 'staff' : 'admin')
// ── Reference Code ────────────────────────────────────────────────────────────
// Every procurement carries a human-readable reference (e.g. "PC-7K4M-Q9XT-3HWD") that
// doubles as its public lookup key: it is what anyone types into the Public
// Verifier to replay the whole trail from the Sepolia ledger. Admins hand this
// code out constantly, so it gets a deliberately loud, monospace, click-to-copy
// treatment everywhere instead of being buried in muted subtitle text.
function RefCodeImpl({ code, size = 'sm' }) {
  const [copied, setCopied] = useState(false)
  if (!code) return <span className="ad-muted ad-small">—</span>

  const copy = async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* Clipboard blocked (insecure origin / denied) — the code is still on
         screen to be read or selected by hand, so there is nothing to report. */
    }
  }

  return (
    <button
      type="button"
      className={`ad-ref ad-ref-${size}${copied ? ' ad-ref-copied' : ''}`}
      onClick={copy}
      title={copied ? 'Copied!' : `${code}: click to copy`}
    >
      <span className="ad-ref-text">{code}</span>
      {copied ? <Check size={11} /> : <Copy size={11} className="ad-ref-copy" />}
    </button>
  )
}
// Deadline column: the real date once published; before that, a compact
// "N-day period" chip whose tooltip explains the date is set on publish.
function DeadlineCellImpl({ project }) {
  if (project.deadline) return <span className="ad-nowrap">{project.deadline}</span>
  if (project.biddingPeriodDays) {
    return (
      <span
        className="ui-badge ui-badge--neutral"
        data-tip="Deadline is set automatically when the project is published"
        title="Deadline is set automatically when the project is published"
        tabIndex={0}
      >
        <Clock size={11} aria-hidden="true" /> {project.biddingPeriodDays}-day period
      </span>
    )
  }
  return <span className="ad-muted">—</span>
}
export const DOC_EXT = ['pdf', 'jpg', 'jpeg', 'png']
export const checkDoc = (f) => {
  const ext = f.name.split('.').pop().toLowerCase()
  if (!DOC_EXT.includes(ext)) return `Unsupported type ".${ext}". Use PDF, JPG, or PNG.`
  if (f.size > 5 * 1024 * 1024) return 'File is too large (max 5 MB).'
  return ''
}
// Single document upload control used in the procurement creation form.
export function DocUploader({ doc, file, onFile, onRemove, optional }) {
  const inputId = `doc-${doc.key}`
  return (
    <div className="ad-doc-field">
      <div className="ad-doc-label">
        {doc.label} <span className={optional ? 'ad-doc-opt' : 'ad-doc-req'}>{optional ? 'Optional' : 'Required'}</span>
      </div>
      {file ? (
        <div className="ad-doc-file">
          <FileText size={14} />
          <span className="ad-doc-name" title={file.name}>{file.name}</span>
          <LocalPreviewButton file={file} className="sd-file-preview" />
          <button type="button" onClick={onRemove} aria-label="Remove"><X size={14} /></button>
        </div>
      ) : (
        <label htmlFor={inputId} className="ad-doc-upload">
          <FileText size={14} /> Upload file
        </label>
      )}
      <input id={inputId} type="file" accept=".pdf,.jpg,.jpeg,.png" hidden
        onChange={e => onFile(doc.key, e.target.files[0])} />
    </div>
  )
}
// Builds the initial "needs revision" flags from a supplier's documents.
export const initFlagsFrom = (data) => {
  const initial = {}
  ;(data?.documents || []).forEach(d => {
    if (d.review_status === 'needs_revision') initial[d.key] = { checked: true, note: d.review_note || '' }
  })
  return initial
}
export function Info2({ label, value, full }) {
  return (
    <div className={`ad-info-item${full ? ' ad-info-full' : ''}`}>
      <span className="ad-info-label">{label}</span>
      <span className="ad-info-value">{value || '—'}</span>
    </div>
  )
}
// ── Confirmation dialog ───────────────────────────────────────────────────────

export function ConfirmDialog({ title, message, tone = 'green', confirmLabel = 'Confirm', busy, onConfirm, onCancel }) {
  return (
    <div className="ad-confirm-overlay" onClick={onCancel}>
      <div className="ad-confirm" onClick={e => e.stopPropagation()}>
        <div className={`ad-confirm-icon ad-confirm-${tone}`}>
          {tone === 'green' ? <CheckCircle2 size={22} /> : tone === 'red' ? <XCircle size={22} /> : <AlertTriangle size={22} />}
        </div>
        <h4>{title}</h4>
        <p>{message}</p>
        <div className="ad-confirm-actions">
          <button className="ad-btn-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={`ad-btn-confirm ad-confirm-${tone}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
// ── Toast ─────────────────────────────────────────────────────────────────────

export function Toast({ type, message, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000)
    return () => clearTimeout(t)
  }, [onClose])
  return (
    <div className={`ad-toast ad-toast-${type}`} role="status">
      {type === 'success' ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
      <span>{message}</span>
      <button onClick={onClose} aria-label="Dismiss"><X size={15} /></button>
    </div>
  )
}
export const peso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH')
export const fmtDate = (v) => v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

export const RefCode = memo(RefCodeImpl)

export const DeadlineCell = memo(DeadlineCellImpl)
