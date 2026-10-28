// Document status at a glance — shared by every screen that lists documents
// (Admin supplier review, project details, bid review, Head review, the
// supplier's own "My Documents"), so a reviewer never has to click "View" just
// to learn whether a file was submitted.
//
// Works with the `documents` arrays the API returns: { label, required, url,
// file_name, present, expired, expiring_soon, days_left, expiry_date,
// review_status }. Fields a list doesn't have are simply skipped.
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import StatusBadge from './StatusBadge'

const fmtDate = (v) => {
  if (!v) return ''
  const d = new Date(String(v).length === 10 ? `${v}T00:00:00` : v)
  return Number.isNaN(d.getTime()) ? String(v)
    : d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}

/** 'submitted' | 'none' | 'lost' (on record but gone from storage) | 'expired' */
export function fileState(doc) {
  if (!doc?.url) return 'none'
  if (doc.expired) return 'expired'
  if (doc.present === false) return 'lost'
  return 'submitted'
}

/** "Submitted · file.pdf · Expires …" or what's wrong with the file. */
export function DocFileStatus({ doc }) {
  const state = fileState(doc)
  if (state === 'none') {
    return (
      <span className={`ui-docfile ${doc.required ? 'is-bad' : 'is-muted'}`}>
        <XCircle size={13} aria-hidden="true" /> {doc.required ? 'Not submitted' : 'Not provided (optional)'}
      </span>
    )
  }
  if (state === 'lost') {
    return (
      <span className="ui-docfile is-bad" title="The file is on record but no longer in storage. Ask for it to be uploaded again.">
        <AlertTriangle size={13} aria-hidden="true" /> File unavailable — needs re-upload
      </span>
    )
  }
  return (
    <span className={`ui-docfile ${state === 'expired' ? 'is-bad' : 'is-ok'}`}>
      {state === 'expired'
        ? <><AlertTriangle size={13} aria-hidden="true" /> Expired {fmtDate(doc.expiry_date)}</>
        : <><CheckCircle2 size={13} aria-hidden="true" /> Submitted</>}
      {doc.file_name && <span className="ui-docfile-name" title={doc.file_name}>{doc.file_name}</span>}
      {state === 'submitted' && (doc.expiring_soon
        ? <span className="ui-docfile-warn">Expires in {doc.days_left} day{doc.days_left === 1 ? '' : 's'}</span>
        : doc.expiry_date && <span className="ui-docfile-meta">Expires {fmtDate(doc.expiry_date)}</span>)}
      {doc.count > 0 && <span className="ui-docfile-meta">{doc.count} file{doc.count === 1 ? '' : 's'}</span>}
    </span>
  )
}

/** The reviewer's verdict on a document (nothing for a document with no file). */
export function DocReviewBadge({ doc, flagged = false }) {
  if (flagged) return <StatusBadge tone="warning" label="Flagged — not sent yet" />
  switch (doc.review_status) {
    case 'approved': return <StatusBadge tone="success" label="Approved" />
    case 'needs_revision': return <StatusBadge tone="danger" label="Needs revision" />
    case 'resubmitted': return <StatusBadge tone="info" label="Resubmitted — check again" />
    default:
      return fileState(doc) === 'submitted' ? <StatusBadge tone="neutral" label="Not reviewed yet" /> : null
  }
}

/** One-line overview of a document list: "8 of 10 required submitted · 2 approved …" */
export function DocSummary({ docs = [] }) {
  if (docs.length === 0) return null
  const required = docs.filter(d => d.required)
  const reqDone = required.filter(d => fileState(d) === 'submitted').length
  const submitted = docs.filter(d => fileState(d) === 'submitted')
  const approved = docs.filter(d => d.review_status === 'approved').length
  const revision = docs.filter(d => d.review_status === 'needs_revision').length
  const resubmitted = docs.filter(d => d.review_status === 'resubmitted').length
  const problems = docs.filter(d => d.url && fileState(d) !== 'submitted').length
  const unreviewed = submitted.filter(d => !d.review_status).length
  const total = required.length || docs.length
  const done = required.length ? reqDone : submitted.length
  const complete = done === total && problems === 0
  return (
    <div className={`ui-docsum${complete ? ' is-complete' : ''}`}>
      <div className="ui-docsum-main">
        <strong>{done} of {total}</strong>
        <span>{required.length ? 'required documents submitted' : 'documents submitted'}</span>
        <div className="ui-docsum-bar" aria-hidden="true"><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
      </div>
      <div className="ui-docsum-chips">
        {approved > 0 && <StatusBadge tone="success" label={`${approved} approved`} />}
        {revision > 0 && <StatusBadge tone="danger" label={`${revision} need${revision === 1 ? 's' : ''} revision`} />}
        {resubmitted > 0 && <StatusBadge tone="info" label={`${resubmitted} resubmitted`} />}
        {problems > 0 && <StatusBadge tone="danger" label={`${problems} expired or unavailable`} />}
        {unreviewed > 0 && <StatusBadge tone="neutral" label={`${unreviewed} not reviewed yet`} />}
      </div>
    </div>
  )
}
