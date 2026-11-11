import { lazy, Suspense, useState, useMemo } from 'react'
import { useDebouncedValue } from '../../utils/useDebouncedValue'
import { Link } from 'react-router-dom'
import { FolderOpen, Clock, CheckCircle2, Search, Lock } from 'lucide-react'
import { TableSkeleton } from '../../components/Skeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import EmptyState from '../../components/ui/EmptyState'
import { deadlineMeta } from '../../utils/format'

// Same chunk as the dashboard's own lazy BidModal, so it downloads once.
const BidModal = lazy(() => import('./BidModal'))

export default function SupplierProjects({ projects, bids, onBid, eligible, loading, profile }) {
  const [modal, setModal] = useState(null)
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search)
  const alreadyBid = useMemo(() => new Set(bids.map(b => b.projectId)), [bids])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return projects.filter(p => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || p.category.toLowerCase().includes(q))
  }, [projects, query])

  return (
    <div className="sd-content">
      {modal && <Suspense fallback={null}><BidModal project={modal} profile={profile} onClose={() => setModal(null)} onSubmit={onBid} /></Suspense>}
      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>Open for bidding</h2><p>Matching your registered categories</p></div>
          {projects.length > 0 && (
            <label className="sd-search-inline">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search projects</span>
              <input placeholder="Search projects" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
          )}
        </div>
        {loading && projects.length === 0 ? (
          <table className="sd-table">
            <thead>
              <tr><th>ID</th><th>Project</th><th>Budget</th><th>Category</th><th>Deadline</th><th></th></tr>
            </thead>
            <tbody><TableSkeleton rows={4} cols={6} /></tbody>
          </table>
        ) : projects.length === 0 ? (
          <EmptyState icon={FolderOpen} title="No open procurements right now"
            description="None match your categories. Check back later."
            action={<>
              <Link to="/public" className="sd-btn-cancel">View public procurements</Link>
              <Link to="/supplier/profile" className="sd-btn-cancel">Review my categories</Link>
            </>} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Search} title="No matching projects" description={`No projects match "${query}".`}
            action={<button className="sd-btn-cancel" onClick={() => setSearch('')}>Clear search</button>} />
        ) : (
          <div className="sd-table-scroll">
          <table className="sd-table">
            <thead>
              <tr><th>ID</th><th>Project</th><th className="sd-num">Budget</th><th>Category</th><th>Deadline</th><th><span className="sr-only">Action</span></th></tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id}>
                  <td className="sd-mono">{p.id}</td>
                  <td>
                    <div className="sd-bold">{p.name}</div>
                    <div className="sd-muted sd-small" style={{ maxWidth: 220 }}>{p.description}</div>
                  </td>
                  <td className="sd-num">{p.budget}</td>
                  <td><span className="ui-badge ui-badge--neutral">{p.category}</span></td>
                  <td>
                    <div className="sd-deadline-cell">
                      <span className="sd-nowrap">{p.deadline}</span>
                      {!p.isExpired && deadlineMeta(p.deadline) && (
                        <StatusBadge tone={deadlineMeta(p.deadline).tone} dot={false} icon={Clock} label={deadlineMeta(p.deadline).label} />
                      )}
                    </div>
                  </td>
                  <td className="sd-action-cell">
                    {alreadyBid.has(p.id)
                      ? <StatusBadge tone="success" icon={CheckCircle2} label="Bid Submitted" />
                      : p.isExpired
                      ? <StatusBadge tone="danger" label="Deadline Passed" />
                      : eligible
                      ? <button className="sd-bid-btn-table" onClick={() => setModal(p)}>Submit Bid</button>
                      : <StatusBadge tone="neutral" icon={Lock} label="Locked" title="Approval required before bidding" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  )
}
