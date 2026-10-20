// One badge for every status in the app. The underlying status values are the
// backend's own strings and are never changed here — this file only maps each
// value to a Title Case label and a semantic tone, so "Approved" looks the same
// whether it is a project, a supplier, or a Head decision.
//
// Tones: neutral (gray), warning (amber), info (blue), success (green), danger (red).

const MAPS = {
  project: {
    draft:          ['Draft', 'neutral'],
    pending_head:   ['Pending', 'warning'],
    needs_revision: ['Needs Revision', 'warning'],
    approved:       ['Approved', 'success'],
    rejected:       ['Rejected', 'danger'],
    published:      ['Open for Bidding', 'info'],
    active:         ['Active', 'info'],
    awarded:        ['Awarded', 'success'],
    closed:         ['Closed', 'neutral'],
  },
  supplier: {
    draft:    ['Draft', 'neutral'],
    pending:  ['Pending', 'warning'],
    approved: ['Approved', 'success'],
    rejected: ['Rejected', 'danger'],
  },
  qualification: {
    verified:               ['Verified', 'success'],
    waiting_admin_approval: ['Waiting Admin Approval', 'warning'],
    needs_revision:         ['Needs Revision', 'warning'],
    rejected:               ['Rejected', 'danger'],
  },
  // Admin's view of a bid.
  bid: {
    submitted:    ['Submitted', 'warning'],
    under_review: ['Under Review', 'warning'],
    shortlisted:  ['Shortlisted', 'success'],
    qualified:    ['Qualified', 'success'],
    winner:       ['Winner Selected', 'success'],
    won:          ['Won', 'success'],
    disqualified: ['Disqualified', 'danger'],
    rejected:     ['Rejected', 'danger'],
    lost:         ['Lost', 'danger'],
  },
  award: {
    won:       ['Won', 'success'],
    cancelled: ['Cancelled', 'neutral'],
  },
  decision: {
    approved: ['Approved', 'success'],
    rejected: ['Rejected', 'danger'],
  },
  email: {
    true:  ['Verified', 'success'],
    false: ['Unverified', 'neutral'],
  },
}

const titleCase = (s) =>
  String(s || '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())

/** Look up { label, tone } for a status value without rendering anything. */
export function statusMeta(domain, status) {
  const hit = MAPS[domain]?.[String(status)]
  return hit ? { label: hit[0], tone: hit[1] } : { label: titleCase(status) || '—', tone: 'neutral' }
}

/**
 * <StatusBadge domain="project" status="published" />
 * <StatusBadge tone="danger" label="Deadline Passed" />
 * `label` / `tone` override the mapping when a screen needs custom wording.
 */
export default function StatusBadge({ domain, status, label, tone, icon: Icon, dot = true, size, title, className = '' }) {
  const meta = statusMeta(domain, status)
  const t = tone || meta.tone
  return (
    <span
      className={`ui-badge ui-badge--${t}${size === 'lg' ? ' ui-badge-lg' : ''}${className ? ` ${className}` : ''}`}
      title={title}
    >
      {Icon ? <Icon size={11} aria-hidden="true" /> : dot ? <span className="ui-badge-dot" aria-hidden="true" /> : null}
      {label || meta.label}
    </span>
  )
}
