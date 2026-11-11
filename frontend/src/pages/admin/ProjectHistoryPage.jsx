import { useState, useMemo } from 'react'
import { useDebouncedValue } from '../../utils/useDebouncedValue'
import { ws } from '../../utils/workspace'
import { useNavigate } from 'react-router-dom'
import { Search, Eye, Clock, ArrowLeft, ShieldCheck } from 'lucide-react'
import { useProjects, isExpired, deadlineLabel } from '../../store/projectsStore'
import { TableSkeleton } from '../../components/Skeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import { TableEmpty } from '../../components/ui/EmptyState'
import { prefetchRecord } from '../../components/ProcurementRecord'
import {
  RefCode,
} from './shared'

const STATUS_CLS = {
  draft: 'badge-gray', pending_head: 'badge-yellow', needs_revision: 'badge-orange', approved: 'badge-green', rejected: 'badge-red',
  published: 'badge-blue', awarded: 'badge-awarded', active: 'badge-blue',
}
// ── Project History Page ─────────────────────────────────────────────────────
// Projects whose bid deadline has passed get pulled out of the active
// Projects table (see ProjectsPage filtering above) so closed biddings don't
// clutter the working view, but they stay one click away with full status
// and bid access. Purely a client-side split of the same `projects` cache —
// no extra request, so opening History never hits the API or slows anything.
export default function ProjectHistoryPage() {
  const { projects, loading } = useProjects()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search)

  // isExpired compares against today, so the day is a dependency too.
  const day = new Date().toDateString()
  const history = useMemo(
    () => projects
      .filter(p => !['draft', 'pending_head', 'needs_revision', 'rejected'].includes(p.status))
      .filter(isExpired),
    [projects, day]) // eslint-disable-line react-hooks/exhaustive-deps

  // Most recently closed first.
  const sorted = useMemo(() => {
    const q = query.toLowerCase()
    const filtered = history.filter(p => !q || p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q))
    return [...filtered].sort((a, b) => (a.deadlineRaw < b.deadlineRaw ? 1 : -1))
  }, [history, query])

  // A row only lands here because its deadline has passed, so the badge should
  // say so — "Open for Bidding"/"Approved" would be stale and confusing once
  // the bidding window is actually over. Awarded is the one outcome worth
  // keeping distinct.
  const closedLabel = (p) => (p.status === 'awarded' ? 'Awarded' : 'Closed')
  const closedCls = (p) => (p.status === 'awarded' ? (STATUS_CLS.awarded || 'badge-awarded') : 'badge-gray')

  return (
    <div className="ad-content">
      <div className="ad-card">
        <div className="ad-card-header">
          <button className="ad-btn-view-sm" onClick={() => navigate(ws('/projects'))}>
            <ArrowLeft size={12} /> Back to Projects
          </button>
          <div className="ad-toolbar">
            <label className="ad-search-inline">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search closed biddings</span>
              <input placeholder="Search title or reference" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
          </div>
        </div>

        <div className="ad-table-scroll ad-x-scroll">
        <table className="ad-table">
          <thead>
            <tr>
              <th>Project</th><th className="ad-num">Budget</th><th>Closed On</th><th>Type</th>
              <th>Eligible Types</th><th>Status</th><th className="ad-actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && sorted.length === 0
              ? <TableSkeleton rows={4} cols={7} />
              : sorted.length === 0
              ? <TableEmpty colSpan={7} icon={Clock}
                  title={search ? 'No closed biddings match your search' : 'No closed biddings yet'}
                  description="Projects move here once their bid deadline passes." />
              : sorted.map(p => (
                <tr key={p.id}>
                  <td className="ad-cell-title"><div className="ad-bold ad-cell-name">{p.name}</div><RefCode code={p.code} /></td>
                  <td className="ad-num">{p.budget}</td>
                  <td className="ad-nowrap">{deadlineLabel(p)}</td>
                  <td className="ad-nowrap">{p.type}</td>
                  <td><span className="ui-badge ui-badge--neutral">{p.eligibleTypes}</span></td>
                  <td>
                    <StatusBadge tone={p.status === 'awarded' ? 'success' : 'neutral'} label={closedLabel(p)} />
                  </td>
                  <td className="ad-actions-col">
                    <button className="ad-btn-view-sm" onClick={() => navigate(`${ws('')}/bids/${p.id}`)}>
                      <Eye size={13} /> View Bids
                    </button>
                    <button className="ad-btn-view-sm" onMouseEnter={() => prefetchRecord(p.id)} onClick={() => navigate(`${ws('')}/record/${p.id}`)}>
                      <ShieldCheck size={13} /> Record
                    </button>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}
