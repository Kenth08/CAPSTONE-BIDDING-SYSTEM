// Display-only formatting helpers shared by every screen. They never change
// the data — only how it is shown (₱ currency, "Nov 3, 2026" dates, relative
// "Expires in 5 days" labels).

export const peso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH')

export const fmtDate = (v) =>
  v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

const DAY = 1000 * 60 * 60 * 24

/** Whole days from today until `v` (negative = in the past). */
export function daysUntil(v) {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  d.setHours(0, 0, 0, 0)
  return Math.round((d - today) / DAY)
}

/**
 * Relative expiry label + tone for a date.
 * expired → danger, ≤ 7 days → danger, ≤ 30 days → warning, otherwise neutral.
 */
export function expiryMeta(v) {
  const n = daysUntil(v)
  if (n === null) return { label: '—', tone: 'neutral' }
  if (n < 0) return { label: n === -1 ? 'Expired yesterday' : `Expired ${-n} days ago`, tone: 'danger' }
  if (n === 0) return { label: 'Expires today', tone: 'danger' }
  if (n === 1) return { label: 'Expires tomorrow', tone: 'danger' }
  if (n <= 7) return { label: `Expires in ${n} days`, tone: 'danger' }
  if (n <= 30) return { label: `Expires in ${n} days`, tone: 'warning' }
  return { label: `Expires in ${n} days`, tone: 'neutral' }
}

/** Bidding deadline countdown: "3 days left", "Closes today", "Closed". */
export function deadlineMeta(v) {
  const n = daysUntil(v)
  if (n === null) return null
  if (n < 0) return { label: 'Closed', tone: 'danger' }
  if (n === 0) return { label: 'Closes today', tone: 'danger' }
  if (n === 1) return { label: '1 day left', tone: 'warning' }
  if (n <= 3) return { label: `${n} days left`, tone: 'warning' }
  return { label: `${n} days left`, tone: 'info' }
}

/** First letter for an avatar. */
export const initialOf = (name) => (String(name || '?').trim().charAt(0) || '?').toUpperCase()
