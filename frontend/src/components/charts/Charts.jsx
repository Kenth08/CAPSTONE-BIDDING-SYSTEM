// Small SVG charts shared by every dashboard. No chart library: the project
// rules ask for no new UI dependency, and these four forms cover what the
// dashboards show.
//
//   ColumnChart  values over time (one or more series, grouped or stacked)
//   BarList      a ranked list of magnitudes (categories, procurements)
//   DonutChart   parts of a whole (statuses, outcomes), always with a legend
//   ProgressBar  one share of a total ("12 of 15 evaluations in")
//
// Rules followed (dataviz guidance): colour follows the series, never its
// rank; text stays in the text tokens; every mark has a hover/focus tooltip;
// a legend appears for two or more series and the values are always written
// out (some fills are below 3:1 on white), plus a visually hidden table.
import { useId, useRef, useState } from 'react'
import '../../style/charts.css'

// Categorical slots, fixed order (validated: CVD ΔE ≥ 9 for adjacent pairs).
export const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)']
// Status colours mean the state they name and are never used as "series 4".
export const STATUS = {
  success: 'var(--tone-success-solid)', warning: 'var(--tone-warning-solid)',
  danger: 'var(--tone-danger-solid)', info: 'var(--tone-info-solid)', neutral: 'var(--chart-neutral)',
}

const fmtCount = (v) => Number(v || 0).toLocaleString('en-PH')

// A round top for the axis. Small counts get an even whole number, so the
// middle gridline is a whole number too (never "0.5 procurements").
function niceMax(v) {
  if (v <= 0) return 2
  if (v <= 10) return Math.max(2, Math.ceil(v / 2) * 2)
  const mag = 10 ** Math.floor(Math.log10(v))
  const n = v / mag
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag
}

function useTooltip() {
  const ref = useRef(null)
  const [tip, setTip] = useState(null)   // { x, y, title, rows }
  const show = (evt, content) => {
    const box = ref.current?.getBoundingClientRect()
    const r = evt.currentTarget.getBoundingClientRect()
    if (!box) return
    setTip({ ...content, x: r.left - box.left + r.width / 2, y: r.top - box.top })
  }
  const hide = () => setTip(null)
  const node = tip && (
    <div className="ch-tip" role="status" style={{ left: tip.x, top: tip.y }}>
      <strong>{tip.title}</strong>
      {tip.rows.map(r => (
        <span key={r.label} className="ch-tip-row">
          {r.color && <i className="ch-swatch" style={{ background: r.color }} aria-hidden="true" />}
          {r.label}<b>{r.value}</b>
        </span>
      ))}
    </div>
  )
  return { ref, show, hide, node }
}

export function Legend({ items }) {
  return (
    <ul className="ch-legend">
      {items.map(it => (
        <li key={it.label}>
          <i className="ch-swatch" style={{ background: it.color }} aria-hidden="true" />
          <span>{it.label}</span>
          {it.value != null && <b>{it.value}</b>}
        </li>
      ))}
    </ul>
  )
}

function HiddenTable({ caption, head, rows }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead><tr>{head.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>)}</tr>)}</tbody>
    </table>
  )
}

/**
 * Columns over a sequence (months). data: [{ label, values: { key: number } }]
 * series: [{ key, label, color? }]. mode 'grouped' (default) or 'stacked'.
 */
export function ColumnChart({ data, series, mode = 'grouped', format = fmtCount, ariaLabel, height = 180 }) {
  const tip = useTooltip()
  const W = 560, H = height, padL = 34, padB = 24, padT = 10
  const plotW = W - padL - 8, plotH = H - padB - padT
  const totals = data.map(d => series.reduce((s, sr) => s + Number(d.values[sr.key] || 0), 0))
  const max = niceMax(mode === 'stacked' ? Math.max(0, ...totals)
    : Math.max(0, ...data.flatMap(d => series.map(s => Number(d.values[s.key] || 0)))))
  const band = plotW / Math.max(1, data.length)
  const groupW = Math.min(band * 0.62, mode === 'stacked' ? 34 : 18 * series.length + 2 * (series.length - 1))
  const barW = mode === 'stacked' ? groupW : (groupW - 2 * (series.length - 1)) / series.length
  const y = (v) => padT + plotH - (v / max) * plotH
  const ticks = Number.isInteger(max / 2) ? [0, max / 2, max] : [0, max]
  const colorOf = (s, i) => s.color || SERIES[i % SERIES.length]
  const empty = totals.every(t => t === 0)

  return (
    <figure className="ch" ref={tip.ref} aria-label={ariaLabel}>
      {series.length > 1 && <Legend items={series.map((s, i) => ({ label: s.label, color: colorOf(s, i) }))} />}
      <svg viewBox={`0 0 ${W} ${H}`} className="ch-svg" role="img" aria-label={ariaLabel}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={padL} x2={W - 8} y1={y(t)} y2={y(t)} className={t === 0 ? 'ch-axis' : 'ch-grid'} />
            <text x={padL - 6} y={y(t)} dy="0.32em" textAnchor="end" className="ch-tick">{format(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = padL + band * i + band / 2
          const x0 = cx - groupW / 2
          let stackTop = 0
          return (
            <g key={d.label}>
              {series.map((s, si) => {
                const v = Number(d.values[s.key] || 0)
                if (v <= 0) return null
                const h = (v / max) * plotH
                let x, top
                if (mode === 'stacked') {
                  x = x0
                  top = y(stackTop + v)
                  stackTop += v
                } else {
                  x = x0 + si * (barW + 2)
                  top = y(v)
                }
                // 2px surface gap between stacked segments; rounded top on the data end only.
                const hh = Math.max(1, mode === 'stacked' && stackTop !== v ? h - 2 : h)
                return <path key={s.key} d={roundedTop(x, top, barW, hh)} fill={colorOf(s, si)} />
              })}
              {/* Hit target wider than the marks, keyboard-focusable. */}
              <rect x={padL + band * i} y={padT} width={band} height={plotH} fill="transparent" tabIndex={0}
                className="ch-hit" aria-label={`${d.label}: ${series.map(s => `${s.label} ${format(d.values[s.key] || 0)}`).join(', ')}`}
                onMouseEnter={e => tip.show(e, { title: d.label, rows: series.map((s, si) => ({ label: s.label, value: format(d.values[s.key] || 0), color: colorOf(s, si) })) })}
                onFocus={e => tip.show(e, { title: d.label, rows: series.map((s, si) => ({ label: s.label, value: format(d.values[s.key] || 0), color: colorOf(s, si) })) })}
                onMouseLeave={tip.hide} onBlur={tip.hide} />
              <text x={cx} y={H - 6} textAnchor="middle" className="ch-tick">{d.label}</text>
            </g>
          )
        })}
        {empty && <text x={padL + plotW / 2} y={padT + plotH / 2} textAnchor="middle" className="ch-empty">No activity in this period</text>}
      </svg>
      {tip.node}
      <HiddenTable caption={ariaLabel} head={['Period', ...series.map(s => s.label)]}
        rows={data.map(d => [d.label, ...series.map(s => format(d.values[s.key] || 0))])} />
    </figure>
  )
}

function roundedTop(x, top, w, h) {
  const r = Math.min(4, w / 2, h)
  const bottom = top + h
  return `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${bottom} Z`
}

/**
 * Horizontal bars, one series. data: [{ label, value, display?, sub?, max?, onClick? }].
 * `display` is the written value (e.g. ₱ amount); value drives the length.
 */
export function BarList({ data, color = SERIES[0], format = fmtCount, ariaLabel, max: maxIn }) {
  const max = maxIn || Math.max(1, ...data.map(d => Number(d.value) || 0))
  if (!data.length) return <p className="ch-empty-text">Nothing to show yet.</p>
  return (
    <figure className="ch" aria-label={ariaLabel}>
      <ul className="ch-bars">
        {data.map(d => {
          // d.max: this row's own full length (e.g. its ABC), else the largest value.
          const pct = Math.max(0, Math.min(100, ((Number(d.value) || 0) / (d.max || max)) * 100))
          const body = (
            <>
              <span className="ch-bar-label" title={d.label}>{d.label}{d.sub && <small>{d.sub}</small>}</span>
              <span className="ch-bar-track" aria-hidden="true">
                <span className="ch-bar-fill" style={{ width: `${pct}%`, background: d.color || color }} />
              </span>
              <span className="ch-bar-value">{d.display ?? format(d.value)}</span>
            </>
          )
          return (
            <li key={d.label}>
              {d.onClick
                ? <button type="button" className="ch-bar-row" onClick={d.onClick}>{body}</button>
                : <div className="ch-bar-row">{body}</div>}
            </li>
          )
        })}
      </ul>
    </figure>
  )
}

/**
 * Parts of a whole. data: [{ label, value, color, display? }]. The centre shows
 * the total (or `centerValue`); the legend writes out each value and share.
 */
export function DonutChart({ data, ariaLabel, centerValue, centerLabel = 'total', size = 150 }) {
  const tip = useTooltip()
  const id = useId()
  const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0)
  const R = 54, stroke = 16, C = 2 * Math.PI * R
  const parts = data.filter(d => Number(d.value) > 0)
  const gap = parts.length > 1 ? 2 : 0   // 2px surface gap between segments
  let offset = 0
  return (
    <figure className="ch ch-donut" ref={tip.ref} aria-label={ariaLabel}>
      <svg viewBox="0 0 140 140" width={size} height={size} role="img" aria-labelledby={`${id}-c`}>
        <title id={`${id}-c`}>{ariaLabel}</title>
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--chart-track)" strokeWidth={stroke} />
        {total > 0 && parts.map(d => {
          const len = (Number(d.value) / total) * C
          const dash = Math.max(0.5, len - gap)
          const el = (
            <circle key={d.label} cx="70" cy="70" r={R} fill="none" stroke={d.color} strokeWidth={stroke}
              strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-offset} transform="rotate(-90 70 70)"
              className="ch-seg" tabIndex={0} aria-label={`${d.label}: ${d.display ?? fmtCount(d.value)}`}
              onMouseEnter={e => tip.show(e, { title: d.label, rows: [{ label: 'Count', value: d.display ?? fmtCount(d.value) }, { label: 'Share', value: `${Math.round((d.value / total) * 100)}%` }] })}
              onFocus={e => tip.show(e, { title: d.label, rows: [{ label: 'Count', value: d.display ?? fmtCount(d.value) }, { label: 'Share', value: `${Math.round((d.value / total) * 100)}%` }] })}
              onMouseLeave={tip.hide} onBlur={tip.hide} />
          )
          offset += len
          return el
        })}
        <text x="70" y="68" textAnchor="middle" className="ch-donut-value">{centerValue ?? fmtCount(total)}</text>
        <text x="70" y="86" textAnchor="middle" className="ch-donut-label">{centerLabel}</text>
      </svg>
      <Legend items={data.map(d => ({
        label: d.label, color: d.color,
        value: `${d.display ?? fmtCount(d.value)}${total ? ` · ${Math.round(((Number(d.value) || 0) / total) * 100)}%` : ''}`,
      }))} />
      {tip.node}
    </figure>
  )
}

export function ProgressBar({ value, total, label, color = SERIES[0] }) {
  const pct = total ? Math.min(100, Math.round((value / total) * 100)) : 0
  return (
    <div className="ch-progress">
      <div className="ch-progress-head"><span>{label}</span><b>{fmtCount(value)} of {fmtCount(total)} · {pct}%</b></div>
      <div className="ch-bar-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span className="ch-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

// "2026-06" -> "Jun"
export const monthLabel = (ym) => {
  const [y, m] = String(ym).split('-').map(Number)
  return new Date(y, (m || 1) - 1, 1).toLocaleString('en-PH', { month: 'short' })
}
