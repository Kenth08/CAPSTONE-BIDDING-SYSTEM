// Small SVG charts drawn from token colours — no chart library. Each one
// renders a visually-hidden text summary, so screen readers get the numbers.

const TONE_VAR = {
  primary: 'var(--c-primary-500)',
  success: 'var(--tone-success-solid)',
  warning: 'var(--tone-warning-solid)',
  danger: 'var(--tone-danger-solid)',
  info: 'var(--tone-info-solid)',
  neutral: 'var(--tone-neutral-solid)',
  muted: 'var(--border-strong)',
}

/**
 * Horizontal bars. data: [{ label, value, display?, tone?, onClick? }].
 * `display` is the text shown at the end of the bar (defaults to value).
 */
export function BarChart({ data = [], title, format = (v) => String(v), tone = 'primary' }) {
  const max = Math.max(1, ...data.map((d) => d.value))
  const summary = data.map((d) => `${d.label}: ${d.display ?? format(d.value)}`).join('; ')
  return (
    <figure className="rf-bars">
      <figcaption className="sr-only">{title ? `${title}. ` : ''}{summary}</figcaption>
      <ul aria-hidden={data.some((d) => d.onClick) ? undefined : 'true'}>
        {data.map((d) => {
          const pct = Math.max(d.value > 0 ? 2 : 0, (d.value / max) * 100)
          const Row = d.onClick ? 'button' : 'div'
          return (
            <li key={d.label}>
              <Row className="rf-bar-row" {...(d.onClick ? { type: 'button', onClick: d.onClick, 'aria-label': `${d.label}: ${d.display ?? format(d.value)}` } : {})}>
                <span className="rf-bar-label" title={d.label}>{d.label}</span>
                <svg className="rf-bar-track" viewBox="0 0 100 10" preserveAspectRatio="none" role="presentation">
                  <rect x="0" y="0" width="100" height="10" rx="2" fill="var(--tone-neutral-bg)" />
                  <rect className="rf-bar-fill" x="0" y="0" width={pct} height="10" rx="2" fill={TONE_VAR[d.tone || tone]} />
                </svg>
                <span className="rf-bar-value">{d.display ?? format(d.value)}</span>
              </Row>
            </li>
          )
        })}
      </ul>
    </figure>
  )
}

/**
 * Donut with a centre total and a legend.
 * segments: [{ label, value, tone }]
 */
export function Donut({ segments = [], title, centerLabel, size = 132, stroke = 16 }) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  let offset = 0
  const summary = segments.map((s) => `${s.label}: ${s.value}`).join('; ')
  return (
    <figure className="rf-donut">
      <figcaption className="sr-only">{title ? `${title}. ` : ''}{summary}. Total {total}.</figcaption>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--tone-neutral-bg)" strokeWidth={stroke} />
        {total > 0 && segments.map((s) => {
          const len = (s.value / total) * c
          const el = (
            <circle
              key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={TONE_VAR[s.tone] || TONE_VAR.primary} strokeWidth={stroke}
              strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )
          offset += len
          return el
        })}
        <text x="50%" y="47%" textAnchor="middle" className="rf-donut-total">{total}</text>
        <text x="50%" y="62%" textAnchor="middle" className="rf-donut-caption">{centerLabel}</text>
      </svg>
      <ul className="rf-legend" aria-hidden="true">
        {segments.map((s) => (
          <li key={s.label}>
            <span className="rf-legend-swatch" style={{ background: TONE_VAR[s.tone] || TONE_VAR.primary }} />
            <span className="rf-legend-label">{s.label}</span>
            <span className="rf-legend-value">{s.value}</span>
          </li>
        ))}
      </ul>
    </figure>
  )
}
