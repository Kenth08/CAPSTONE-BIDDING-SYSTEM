import { ChevronRight } from 'lucide-react'

/** Secondary details, closed by default: a native <details>, so keyboard and
 *  screen-reader behaviour come for free. */
export default function MoreInfo({ summary, children, className = '' }) {
  return (
    <details className={`ui-more ${className}`}>
      <summary><ChevronRight size={14} className="ui-more-caret" aria-hidden="true" /> {summary}</summary>
      <div className="ui-more-body">{children}</div>
    </details>
  )
}
