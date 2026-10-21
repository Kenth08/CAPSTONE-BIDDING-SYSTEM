// Display-only formatting helpers shared by every screen. They never change
// the data — only how it is shown (₱ currency, "Nov 3, 2026" dates, relative
// "Expires in 5 days" labels).

// One peso formatter for every amount. Whole amounts drop the ".00" so a
// budget reads "₱1,250,000"; anything with centavos keeps both digits.
const PHP_WHOLE = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 })
const PHP_CENTS = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 })
const PHP_COMPACT = new Intl.NumberFormat('en-PH', {
  style: 'currency', currency: 'PHP', notation: 'compact', maximumFractionDigits: 1,
})

const num = (v) => {
  const n = Number(typeof v === 'string' ? v.replace(/[^\d.-]/g, '') : v)
  return Number.isFinite(n) ? n : 0
}

/** "₱1,250,000" / "₱172,500.50" */
export const peso = (v) => {
  const n = num(v)
  return (Number.isInteger(n) ? PHP_WHOLE : PHP_CENTS).format(n)
}

/** "₱1.3M", "₱540K" — for KPI tiles and chart labels. Full value belongs in a title. */
export const pesoCompact = (v) => PHP_COMPACT.format(num(v))

/** Plain number from an API decimal string ("1250000.00") or a ₱ label. */
export const amount = num

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

export const fmtDateTime = (v) =>
  v ? new Date(v).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }) : '—'

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const UNITS = [
  ['year', 365 * 24 * 3600], ['month', 30 * 24 * 3600], ['week', 7 * 24 * 3600],
  ['day', 24 * 3600], ['hour', 3600], ['minute', 60],
]

/** "5 minutes ago", "yesterday", "in 3 days". */
export function relativeTime(v, now = Date.now()) {
  if (!v) return '—'
  const t = new Date(v).getTime()
  if (Number.isNaN(t)) return '—'
  const secs = Math.round((t - now) / 1000)
  if (Math.abs(secs) < 45) return 'just now'
  for (const [unit, size] of UNITS) {
    if (Math.abs(secs) >= size || unit === 'minute') return RTF.format(Math.round(secs / size), unit)
  }
  return 'just now'
}

/** Whole days since `v` (0 = today). */
export function daysSince(v, now = Date.now()) {
  if (!v) return null
  const t = new Date(v).getTime()
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / DAY))
}

/**
 * Time left until the END of a deadline day (the deadline date itself is still
 * open for bidding — same rule as the backend). Returns { label, tone, closed }.
 * Tones: danger under 24 hours, warning under 72 hours, info otherwise.
 */
export function timeLeft(deadline, now = Date.now()) {
  if (!deadline) return null
  const [y, m, d] = String(deadline).slice(0, 10).split('-').map(Number)
  if (!y) return null
  const end = new Date(y, m - 1, d, 23, 59, 59).getTime()
  const ms = end - now
  if (ms <= 0) return { label: 'Closed', tone: 'neutral', closed: true }
  const hours = Math.floor(ms / 3600000)
  const days = Math.floor(hours / 24)
  const sameDay = new Date(now).toDateString() === new Date(end).toDateString()
  const tone = hours < 24 ? 'danger' : hours < 72 ? 'warning' : 'info'
  if (sameDay) return { label: hours >= 1 ? `Closes today · ${hours}h left` : 'Closes within the hour', tone, closed: false }
  return { label: days >= 1 ? `${days}d ${hours % 24}h left` : `${hours}h left`, tone, closed: false }
}
