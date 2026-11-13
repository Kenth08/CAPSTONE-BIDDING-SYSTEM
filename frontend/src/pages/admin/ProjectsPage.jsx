import { useState, useMemo } from 'react'
import { useDebouncedValue } from '../../utils/useDebouncedValue'
import { ws, useBacStatus, canPrepare } from '../../utils/workspace'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { FolderOpen, Search, Eye, X, Clock } from 'lucide-react'
import { useProjects, publishProject, isExpired, refreshProjects } from '../../store/projectsStore'
import EndBiddingButton from '../../components/EndBiddingButton'
import { END_BIDDING_SUCCESS } from '../../utils/endBidding'
import { TableSkeleton } from '../../components/Skeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import { TableEmpty } from '../../components/ui/EmptyState'
import Thumbnail from '../../components/ui/Thumbnail'
import Lightbox from '../../components/ui/Lightbox'
import {
  DeadlineCell, RefCode, Toast, workspaceRole,
} from './shared'

// ── Projects Page ─────────────────────────────────────────────────────────────

// Pipeline stages on the dashboard link here as /admin/projects?stage=<key>.
// Same grouping as the admin summary's pipeline (procurement/dashboard.py).
const PIPELINE_STAGES = {
  draft:          { label: 'Draft',            test: p => p.status === 'draft' },
  pending_head:   { label: 'Head Review',      test: p => p.status === 'pending_head' },
  needs_revision: { label: 'Needs Revision',   test: p => p.status === 'needs_revision' },
  approved:       { label: 'Ready to Publish', test: p => p.status === 'approved' },
  published:      { label: 'Published',        test: p => p.status === 'published' },
  evaluation:     { label: 'Evaluation',       test: p => p.status === 'closed' && p.bids > 0 },
  awarded:        { label: 'Awarded',          test: p => p.status === 'awarded' },
  closed:         { label: 'Closed (no bids)', test: p => p.status === 'closed' && !p.bids },
}
export default function ProjectsPage() {
  const { workflow_enabled: workflowOn } = useBacStatus()
  const { projects, loading } = useProjects()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const stage = PIPELINE_STAGES[params.get('stage')] ? params.get('stage') : null
  const [filterTab, setFilterTab] = useState('All')
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search)
  const [toast, setToast] = useState(null)
  const [preview, setPreview] = useState(null)   // project whose reference image is open
  const FILTER_TABS = ['All', 'Active', 'Closed', 'Awarded']

  // Only projects the Head has already approved appear here. Projects still being
  // planned, awaiting approval, or rejected stay on the Planning page.
  const approved = useMemo(
    () => projects.filter(p => !['draft', 'pending_head', 'needs_revision', 'rejected'].includes(p.status)),
    [projects])

  // Once a project's bid deadline has passed, the bidding window is over — pull
  // it out of the active table and into History instead of leaving it to sit
  // here looking "Open for Bidding" forever.
  // isExpired compares against today, so the day is a dependency too: a deadline
  // passing while the page is open still moves the row on the next render.
  const day = new Date().toDateString()
  const active = useMemo(() => approved.filter(p => !isExpired(p)), [approved, day]) // eslint-disable-line react-hooks/exhaustive-deps
  const historyCount = approved.length - active.length

  const filtered = useMemo(() => (stage ? projects.filter(PIPELINE_STAGES[stage].test) : active).filter(p => {
    const q = query.toLowerCase()
    const matchSearch = !q || p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q)
    if (stage) return matchSearch
    const matchTab =
      filterTab === 'All'     ? true :
      filterTab === 'Awarded' ? p.status === 'awarded' :
      filterTab === 'Active'  ? (p.status === 'approved' || p.status === 'published' || p.status === 'active') :
      filterTab === 'Closed'  ? p.status === 'closed' : true
    return matchSearch && matchTab
  }), [stage, projects, active, query, filterTab])

  // No re-sort here: `projects` already arrives newest-first (API orders by
  // -created_at, and the store unshifts new/updated rows), so a freshly
  // created or published project shows up at the top right away.

  return (
    <div className="ad-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div className="ad-card">
        <div className="ad-card-header ad-toolbar-row">
          {stage ? (
            <div className="rf-chips" role="status">
              <span className="rf-chip is-active">Stage: {PIPELINE_STAGES[stage].label} <span className="rf-chip-count">{filtered.length}</span></span>
              <button type="button" className="rf-chip" onClick={() => setParams({})} aria-label="Clear the stage filter">
                <X size={12} aria-hidden="true" /> Clear
              </button>
            </div>
          ) : (
          <div className="ad-filter-pills ad-filter-pills-inline" role="tablist" aria-label="Filter projects">
            {FILTER_TABS.map(t => (
              <button key={t} role="tab" aria-selected={filterTab === t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
            ))}
          </div>
          )}
          <div className="ad-toolbar">
            <label className="ad-search-inline">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search projects</span>
              <input placeholder="Search title or reference" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
            <button className="ad-btn-history" onClick={() => navigate(ws('/projects/history'))}>
              <Clock size={13} /> History{historyCount > 0 ? ` (${historyCount})` : ''}
            </button>
          </div>
        </div>

        <div className="ad-table-scroll ad-x-scroll">
        <table className="ad-table">
          <thead>
            <tr>
              <th><span className="sr-only">Image</span></th>
              <th>Project</th><th className="ad-num">Budget</th><th>Deadline</th><th>Type</th>
              <th>Eligible Types</th><th>Status</th><th className="ad-actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && filtered.length === 0
              ? <TableSkeleton rows={4} cols={8} />
              : filtered.length === 0
              ? <TableEmpty colSpan={8} icon={FolderOpen}
                  title={search || filterTab !== 'All' ? 'No projects match your filters' : 'No approved projects yet'}
                  description={search || filterTab !== 'All'
                    ? 'Try a different search or filter.'
                    : 'Projects appear here once the Head approves them in Planning.'} />
              : filtered.map(p => (
                <tr key={p.id}>
                  <td style={{ width: 64 }}>
                    <Thumbnail src={p.referenceImage} size={48} category={p.category}
                      alt={`Reference image for ${p.code} ${p.name}`} onOpen={() => setPreview(p)} />
                  </td>
                  <td className="ad-cell-title"><div className="ad-bold ad-cell-name">{p.name}</div><RefCode code={p.code} /></td>
                  <td className="ad-num">{p.budget}</td>
                  <td><DeadlineCell project={p} /></td>
                  <td className="ad-nowrap">{p.type}</td>
                  <td><span className="ui-badge ui-badge--neutral">{p.eligibleTypes}</span></td>
                  <td>
                    {/* Open / Closed / Under Evaluation / Completed while bidding runs
                        and is evaluated; "Awarded" once there is a winner. */}
                    {p.biddingPhase && p.status !== 'awarded'
                      ? <StatusBadge domain="bidding" status={p.biddingPhase} />
                      : <StatusBadge domain="project" status={p.status} />}
                  </td>
                  <td className="ad-actions-col">
                    <div className="ad-actions">
                      {p.status === 'published' && (
                        <EndBiddingButton project={p} role={workspaceRole()} className="ad-btn-view-sm"
                          onEnded={() => {
                            setToast({ type: 'success', message: END_BIDDING_SUCCESS })
                            refreshProjects()
                          }} />
                      )}
                      {p.status === 'approved' && canPrepare(workspaceRole(), workflowOn) && (
                        <PublishButton
                          project={p}
                          onPublished={(proj) => setToast({
                            type: 'success',
                            message: `"${proj.name}" published — suppliers can now submit bids.`,
                          })}
                        />
                      )}
                      <button className="ad-btn-view-sm" onClick={() => navigate(`${ws('')}/bids/${p.id}`)}>
                        <Eye size={13} /> View Bids
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
        </div>
      </div>
      {preview && (
        <Lightbox images={[{ url: preview.referenceImage, caption: `${preview.code} · ${preview.name}` }]}
          index={0} title="Project reference image" onClose={() => setPreview(null)} />
      )}
    </div>
  )
}
// Publishes an approved procurement so eligible suppliers can start bidding.
function PublishButton({ project, onPublished }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const onPublish = async () => {
    setBusy(true); setErr('')
    try {
      await publishProject(project.id)
      onPublished?.(project)
    }
    catch (e) { setErr(e.message || 'Publish failed.'); setBusy(false) }
  }
  return (
    <>
      <button className="ad-btn-publish" onClick={onPublish} disabled={busy}>
        {busy ? 'Publishing…' : 'Publish'}
      </button>
      {err && <span style={{ color: '#ef4444', fontSize: 11, marginLeft: 6 }}>{err}</span>}
    </>
  )
}
