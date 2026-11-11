// Shared skeleton-loader primitives used across every dashboard so data eases
// in instead of appearing instantly. Styling lives in index.css (.skel).

export function Skeleton({ width = '100%', height = 12, radius = 6, style }) {
  return <span className="skel" style={{ width, height, borderRadius: radius, ...style }} />
}

// Placeholder rows for a <table> body. Render inside <tbody>.
// `widths` optionally sets a per-column bar width.
export function TableSkeleton({ rows = 5, cols = 5, widths }) {
  return Array.from({ length: rows }).map((_, r) => (
    <tr key={r}>
      {Array.from({ length: cols }).map((_, c) => (
        <td key={c}>
          <Skeleton width={widths?.[c] || (c === 0 ? '70%' : '55%')} />
        </td>
      ))}
    </tr>
  ))
}

// A stack of skeleton "rows" for list/card layouts (not tables).
export function ListSkeleton({ rows = 4, height = 56 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} height={height} radius={10} />
      ))}
    </div>
  )
}

// Stand-in for a whole page while its code downloads (Suspense fallback). Pass the
// page's content class (e.g. "ad-content") so it sits exactly where the page will.
export function PageSkeleton({ className, full = false }) {
  return (
    <div
      className={className}
      role="status"
      aria-label="Loading"
      aria-busy="true"
      style={full ? { minHeight: '100vh', padding: 24, maxWidth: 1100, margin: '0 auto' } : undefined}
    >
      <Skeleton width={220} height={22} radius={8} style={{ display: 'block', marginBottom: 8 }} />
      <Skeleton width={340} height={12} style={{ display: 'block', marginBottom: 20 }} />
      <ListSkeleton rows={5} height={52} />
    </div>
  )
}
