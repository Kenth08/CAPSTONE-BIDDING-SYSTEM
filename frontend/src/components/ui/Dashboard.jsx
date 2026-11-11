// The layout every role's dashboard is built from, so the Admin, Staff, Head,
// BAC and Supplier homes read the same way:
//
//   DashHeader   who you are and today's date, with the page's actions
//   KpiRow       at most four headline numbers (components/ui/KpiCard)
//   DashGrid     a wide main column for work that needs a decision, and a
//                narrower side column for status and history
//   Panel        one titled section, with an optional count and "view all" link
//   TabbedPanel  several charts in one panel, one visible at a time
//   StageStrip   procurements per stage as a compact row of clickable counts
//
// Nothing here fetches data: each dashboard passes in what it already loads.
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { greeting, todayLong } from '../../utils/format'

export function DashHeader({ name, context, actions }) {
  return (
    <div className="dash-header">
      <div className="dash-header-text">
        <h2>{greeting()}, {name}</h2>
        <p>{todayLong()}{context ? <> · {context}</> : null}</p>
      </div>
      {actions && <div className="dash-header-actions">{actions}</div>}
    </div>
  )
}

export function DashGrid({ main, side }) {
  return (
    <div className="dash-grid">
      <div className="dash-main">{main}</div>
      <div className="dash-side">{side}</div>
    </div>
  )
}

/**
 * A titled section. `count` shows as a badge beside the title (tone sets its
 * colour); `link` = { to, label } adds a "view all" link on the right.
 */
export function Panel({ id, title, count, countTone = 'neutral', link, actions, children, className = '', ...rest }) {
  const autoId = useId()
  const headingId = `${id || autoId}-h`
  return (
    <section className={`rf-card dash-panel ${className}`} id={id} aria-labelledby={headingId} {...rest}>
      <div className="dash-panel-head">
        <h3 id={headingId}>
          {title}
          {count > 0 && <span className={`dash-count dash-count--${countTone}`}>{count}</span>}
        </h3>
        {(link || actions) && (
          <div className="dash-panel-tools">
            {actions}
            {link && <Link to={link.to} className="rf-card-link">{link.label} <ChevronRight size={13} aria-hidden="true" /></Link>}
          </div>
        )}
      </div>
      {children}
    </section>
  )
}

/**
 * Charts that would otherwise sit side by side at equal weight. Only the chosen
 * tab is drawn; `tabs` = [{ key, label, render: () => node }].
 */
export function TabbedPanel({ title, tabs, link }) {
  const [active, setActive] = useState(tabs[0]?.key)
  const base = useId()
  const current = tabs.find((t) => t.key === active) || tabs[0]
  const onKey = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const i = tabs.findIndex((t) => t.key === current.key)
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    setActive(next.key)
    document.getElementById(`${base}-${next.key}`)?.focus()
  }
  return (
    <section className="rf-card dash-panel" aria-label={title}>
      <div className="dash-panel-head">
        <h3>{title}</h3>
        {link && <Link to={link.to} className="rf-card-link">{link.label} <ChevronRight size={13} aria-hidden="true" /></Link>}
      </div>
      <div className="dash-tabs" role="tablist" aria-label={title} onKeyDown={onKey}>
        {tabs.map((t) => {
          const selected = t.key === current.key
          return (
            <button key={t.key} id={`${base}-${t.key}`} type="button" role="tab"
              aria-selected={selected} aria-controls={`${base}-panel`} tabIndex={selected ? 0 : -1}
              className={`dash-tab${selected ? ' is-active' : ''}`} onClick={() => setActive(t.key)}>
              {t.label}
            </button>
          )
        })}
      </div>
      <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-${current.key}`} className="dash-tabpanel">
        {current.render()}
      </div>
    </section>
  )
}

/**
 * Procurements per stage, in lifecycle order. stages: [{ key, label, count, to? }].
 * A stage with a `to` opens its list; empty stages stay visible but muted, so
 * the lifecycle always reads in full.
 */
export function StageStrip({ stages, ariaLabel = 'Procurements by stage' }) {
  return (
    <ol className="dash-stages" aria-label={ariaLabel}>
      {stages.map((s) => {
        const body = (
          <>
            <span className="dash-stage-count">{s.count}</span>
            <span className="dash-stage-label">{s.label}</span>
          </>
        )
        const cls = `dash-stage${s.count ? '' : ' is-empty'}${s.tone ? ` is-${s.tone}` : ''}`
        return (
          <li key={s.key}>
            {s.to
              ? <Link to={s.to} className={`${cls} is-link`} aria-label={`${s.label}: ${s.count}`}>{body}</Link>
              : <span className={cls}>{body}</span>}
          </li>
        )
      })}
    </ol>
  )
}

/** Shows the first `limit` children of a list, with a "Show all N" toggle. */
export function useShowMore(items, limit) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, limit)
  const toggle = items.length > limit ? (
    <div className="dash-more">
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
        {all ? 'Show fewer' : `Show all ${items.length}`}
      </button>
    </div>
  ) : null
  return [shown, toggle]
}
