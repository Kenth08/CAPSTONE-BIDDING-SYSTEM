import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { fmtDate, timeLeft } from '../../utils/format'

// One shared minute ticker for every countdown on screen, instead of one
// interval per badge.
const listeners = new Set()
let timer = null
function subscribe(fn) {
  listeners.add(fn)
  if (!timer) timer = setInterval(() => listeners.forEach((l) => l(Date.now())), 60_000)
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0) { clearInterval(timer); timer = null }
  }
}

/** Current time, refreshed every minute. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => subscribe(setNow), [])
  return now
}

/**
 * Time left to a bidding deadline: "2d 4h left", "Closes today · 5h left",
 * "Closed". Warning tone under 72 hours, danger under 24. Updates every minute.
 * The full deadline date is in the tooltip.
 */
export default function Countdown({ deadline, compact = false }) {
  const now = useNow()
  const meta = timeLeft(deadline, now)
  if (!meta) return <span className="rf-muted">—</span>
  return (
    <span
      className={`ui-badge ui-badge--${meta.tone} rf-countdown${compact ? ' is-compact' : ''}`}
      title={`Bidding deadline: ${fmtDate(deadline)} (end of day)`}
    >
      <Clock size={11} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  )
}
