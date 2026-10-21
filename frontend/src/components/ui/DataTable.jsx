import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Search, SearchX } from 'lucide-react'
import EmptyState from './EmptyState'
import { TableSkeleton } from '../Skeleton'

/**
 * Shared data table: sticky header, sortable columns, search, status filter
 * chips, row hover and an empty state.
 *
 * columns: [{ key, header, render?(row), sortValue?(row), align?: 'right',
 *             className?, hideBelow?: 'md', mobileLabel?: false }]
 * Below 640px each row becomes a stacked card; string headers become labels.
 * filters: [{ key, label, test(row) }] — the first is the default ("All").
 * search:  (row) => searchable text; omit to hide the search box.
 */
export default function DataTable({
  columns, rows = [], rowKey = (r) => r.id, loading = false,
  search, searchPlaceholder = 'Search', filters, defaultFilter, initialSort,
  empty, onRowClick, toolbar, caption, maxHeight,
}) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState(defaultFilter || filters?.[0]?.key)
  const [sort, setSort] = useState(initialSort || null) // { key, dir }

  const active = filters?.find((f) => f.key === filter)
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let out = rows.filter((r) => (!active || active.test(r)) && (!needle || !search || search(r).toLowerCase().includes(needle)))
    const col = sort && columns.find((c) => c.key === sort.key)
    if (col?.sortValue) {
      out = [...out].sort((a, b) => {
        const x = col.sortValue(a), y = col.sortValue(b)
        const cmp = x == null ? 1 : y == null ? -1 : typeof x === 'number' ? x - y : String(x).localeCompare(String(y))
        return sort.dir === 'desc' ? -cmp : cmp
      })
    }
    return out
  }, [rows, q, active, sort, columns, search])

  const toggleSort = (key) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))

  const filtered = q || (filters && filter !== filters[0].key)

  return (
    <div className="rf-table-card">
      {(search || filters || toolbar) && (
        <div className="rf-table-toolbar">
          {filters && (
            <div className="rf-chips" role="group" aria-label="Filter by status">
              {filters.map((f) => {
                const n = rows.filter(f.test).length
                return (
                  <button key={f.key} type="button" className={`rf-chip${filter === f.key ? ' is-active' : ''}`}
                    aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                    {f.label} <span className="rf-chip-count">{n}</span>
                  </button>
                )
              })}
            </div>
          )}
          <div className="rf-table-toolbar-right">
            {toolbar}
            {search && (
              <label className="rf-search">
                <Search size={14} aria-hidden="true" />
                <span className="sr-only">{searchPlaceholder}</span>
                <input type="search" placeholder={searchPlaceholder} value={q} onChange={(e) => setQ(e.target.value)} />
              </label>
            )}
          </div>
        </div>
      )}
      <div className="rf-table-scroll" style={maxHeight ? { maxHeight } : undefined}>
        <table className="rf-table is-stacking">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {columns.map((c) => {
                const sorted = sort?.key === c.key ? sort.dir : null
                return (
                  <th key={c.key} scope="col"
                    className={`${c.align === 'right' ? 'is-num ' : ''}${c.hideBelow ? `rf-hide-${c.hideBelow} ` : ''}${c.className || ''}`}
                    aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.sortValue ? (
                      <button type="button" className="rf-th-sort" onClick={() => toggleSort(c.key)}>
                        {c.header}
                        {sorted === 'asc' ? <ArrowUp size={12} aria-hidden="true" />
                          : sorted === 'desc' ? <ArrowDown size={12} aria-hidden="true" />
                          : <ArrowUpDown size={12} aria-hidden="true" className="rf-th-idle" />}
                      </button>
                    ) : c.header}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <TableSkeleton rows={4} cols={columns.length} />
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="ui-empty-cell">
                  {filtered
                    ? <EmptyState compact icon={SearchX} title="Nothing matches"
                        description="Try a different search or filter."
                        action={<button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => { setQ(''); setFilter(filters?.[0]?.key) }}>Clear filters</button>} />
                    : <EmptyState compact {...empty} />}
                </td>
              </tr>
            ) : visible.map((r) => (
              <tr key={rowKey(r)} className={onRowClick ? 'is-clickable' : undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} data-label={c.mobileLabel === false || typeof c.header !== 'string' ? undefined : c.header}
                    className={`${c.align === 'right' ? 'is-num ' : ''}${c.hideBelow ? `rf-hide-${c.hideBelow} ` : ''}${c.className || ''}`}>
                    {c.render ? c.render(r) : r[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && rows.length > 0 && (
        <div className="rf-table-foot" aria-live="polite">Showing {visible.length} of {rows.length}</div>
      )}
    </div>
  )
}
