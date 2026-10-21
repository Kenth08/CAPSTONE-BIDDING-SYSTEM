import { fmtDateTime, relativeTime } from '../../utils/format'
import { useNow } from './Countdown'

/** "5 minutes ago" with the full date and time in the tooltip. */
export default function RelativeTime({ value, prefix = '' }) {
  const now = useNow()
  if (!value) return <span className="rf-muted">—</span>
  return (
    <time dateTime={new Date(value).toISOString()} title={fmtDateTime(value)} className="rf-reltime">
      {prefix}{relativeTime(value, now)}
    </time>
  )
}
