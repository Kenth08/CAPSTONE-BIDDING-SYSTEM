import { memo } from 'react'
import { fmtDateTime, relativeTime } from '../../utils/format'
import { useNow } from './Countdown'

/** "5 minutes ago" with the full date and time in the tooltip. */
function RelativeTime({ value, prefix = '' }) {
  const now = useNow()
  if (!value) return <span className="rf-muted">—</span>
  return (
    <time dateTime={new Date(value).toISOString()} title={fmtDateTime(value)} className="rf-reltime">
      {prefix}{relativeTime(value, now)}
    </time>
  )
}

// Memoized: rendered once per table row, so a parent re-render (typing in a
// search box, a toast) doesn't re-render every badge when its props are the same.
export default memo(RelativeTime)
