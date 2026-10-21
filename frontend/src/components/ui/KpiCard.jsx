import { Link } from 'react-router-dom'
import { ArrowDownRight, ArrowUpRight, ChevronRight } from 'lucide-react'
import { Skeleton } from '../Skeleton'

/**
 * One headline number: label, big value, a short context line ("3 closing this
 * week") and an optional tone + trend. With `to` the whole card is a link to
 * the list behind the number, so every KPI is one click from where you act.
 *
 * tone: neutral | success | warning | danger | info — tints the icon and the
 * accent bar only; the value itself stays high-contrast text.
 */
export default function KpiCard({
  label, value, context, icon: Icon, tone = 'neutral', trend, to, loading = false, title,
}) {
  const body = (
    <>
      <div className="rf-kpi-top">
        <span className="rf-kpi-label">{label}</span>
        {Icon && <span className={`rf-kpi-icon rf-tone-${tone}`} aria-hidden="true"><Icon size={16} /></span>}
      </div>
      <div className="rf-kpi-value" title={title}>
        {loading ? <Skeleton width={72} height={28} /> : value}
      </div>
      <div className="rf-kpi-context">
        {loading ? <Skeleton width="70%" height={10} /> : (
          <>
            {trend && (
              <span className={`rf-kpi-trend rf-trend-${trend.direction === 'down' ? 'down' : 'up'}`}>
                {trend.direction === 'down' ? <ArrowDownRight size={12} aria-hidden="true" /> : <ArrowUpRight size={12} aria-hidden="true" />}
                {trend.label}
              </span>
            )}
            <span>{context}</span>
          </>
        )}
      </div>
      {to && <ChevronRight size={16} className="rf-kpi-go" aria-hidden="true" />}
    </>
  )
  const cls = `rf-kpi rf-kpi--${tone}${to ? ' is-link' : ''}`
  if (!to) return <div className={cls}>{body}</div>
  return <Link to={to} className={cls} aria-label={`${label}: ${loading ? 'loading' : value}. ${context || ''}`}>{body}</Link>
}

export function KpiRow({ children, cols }) {
  return <div className={`rf-kpi-row${cols ? ` is-${cols}` : ''}`}>{children}</div>
}
