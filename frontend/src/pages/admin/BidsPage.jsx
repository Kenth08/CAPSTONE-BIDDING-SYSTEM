import { useRef } from 'react'
import { ws } from '../../utils/workspace'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  FolderOpen, Search, ChevronRight, ChevronLeft, RefreshCw, FileText, AlertTriangle,
} from 'lucide-react'
import { useProjects, refreshProjects } from '../../store/projectsStore'
import { Skeleton } from '../../components/Skeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import EmptyState from '../../components/ui/EmptyState'
import PageHeader from '../../components/ui/PageHeader'
import {
  BID_TYPE_TABS, BID_STATUS_FILTERS, BID_SORTS, BID_PAGE_SIZES, DEFAULT_BID_PAGE_SIZE, isBiddable, filterBidProjects, paginate, pageList,
} from '../../utils/bidProjects'
import {
  RefCode,
} from './shared'

// ── Bids Page ─────────────────────────────────────────────────────────────────
// Filter, sort and paging rules live in utils/bidProjects.js (unit tested).
//
// Pagination is client-side on purpose: every admin page shares one cached
// project list (store/projectsStore.js), so the full list is already in memory
// and filtering/sorting always see every project. Paging just limits how many
// cards are rendered. List state lives in the URL (?q=&type=&status=&sort=
// &page=&size=) so browser Back from an evaluation returns to the same page
// with the same filters.

const BID_LIST_DEFAULTS = { q: '', type: 'All', status: 'active', sort: 'bids_desc', page: '1', size: String(DEFAULT_BID_PAGE_SIZE) }
export default function BidsPage() {
  const { projects, loading, error } = useProjects()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const listTopRef = useRef(null)
  const toolbarRef = useRef(null)

  // Read list state from the URL, ignoring values that aren't valid options
  // (a hand-edited or stale link falls back to the defaults).
  const get = (key) => params.get(key) ?? BID_LIST_DEFAULTS[key]
  const search = get('q')
  const filterTab = BID_TYPE_TABS.includes(get('type')) ? get('type') : 'All'
  const statusFilter = BID_STATUS_FILTERS[get('status')] ? get('status') : 'active'
  const sort = BID_SORTS[get('sort')] ? get('sort') : 'bids_desc'
  const pageSize = Number(get('size'))
  const requestedPage = Number(get('page'))

  // Write list state back. Defaults are dropped to keep URLs short, `replace`
  // keeps typing/paging from flooding browser history, and any filter, search
  // or sort change returns to page 1 so the user never lands on an empty page.
  const update = (changes, { resetPage = true } = {}) => {
    setParams(prev => {
      const next = new URLSearchParams(prev)
      const all = resetPage ? { ...changes, page: '1' } : changes
      Object.entries(all).forEach(([k, v]) => {
        if (v === undefined || String(v) === BID_LIST_DEFAULTS[k]) next.delete(k)
        else next.set(k, String(v))
      })
      return next
    }, { replace: true })
  }

  const biddable = projects.filter(isBiddable)
  const filtered = filterBidProjects(projects, { type: filterTab, status: statusFilter, search, sort })
  const pg = paginate(filtered, requestedPage, pageSize)
  // The pager (and its page-size menu) only appears once results outgrow the
  // smallest page; 7 projects is just one tidy grid.
  const showPager = pg.total > BID_PAGE_SIZES[0]

  // Changing pages brings the top of the results back into view — scrolling
  // the content area, not the whole app, and stopping just below the sticky
  // toolbar. If the list top is already visible nothing moves. Focus moves to
  // the results summary so keyboard and screen-reader users start at the new
  // page instead of being left on a pager button at the bottom.
  const goToPage = (n) => {
    update({ page: n }, { resetPage: false })
    requestAnimationFrame(() => {
      const target = listTopRef.current
      const scroller = target?.closest('.ad-body')
      if (!target || !scroller) return
      // Line the results up under the pinned toolbar (or the top of the
      // scroll area when the toolbar isn't sticky, e.g. on phones).
      const toolbar = toolbarRef.current
      const stuck = toolbar && getComputedStyle(toolbar).position === 'sticky'
      const limit = stuck
        ? toolbar.querySelector('.ad-bids-toolbar-card').getBoundingClientRect().bottom
        : scroller.getBoundingClientRect().top
      const delta = target.getBoundingClientRect().top - limit - 12
      if (delta < 0) scroller.scrollTop += delta
      target.focus({ preventScroll: true })
    })
  }

  const firstLoad = loading && projects.length === 0
  const loadFailed = !!error && projects.length === 0

  const countText = pg.total === 0
    ? `No matching projects${biddable.length ? ` · ${biddable.length} available for bidding` : ''}`
    : `Showing ${pg.from}–${pg.to} of ${pg.total} project${pg.total !== 1 ? 's' : ''}` +
      (pg.total !== biddable.length ? ` · ${biddable.length} available for bidding` : '')

  return (
    <div className="ad-content ad-bids-page">
      <PageHeader
        title="Select a project to evaluate"
      />

      {/* Sticky on desktop/tablet (see admin-polish.css) so search and filters
          stay reachable while scrolling a long list. */}
      <div className="ad-bids-sticky" ref={toolbarRef}>
        <div className="ad-card ad-bids-toolbar-card">
          <div className="ad-bids-toolbar">
            <label className="ad-search-inline">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search projects</span>
              <input
                type="search"
                placeholder="Search by project name or code"
                value={search}
                onChange={e => update({ q: e.target.value })}
              />
            </label>
            <div className="ad-filter-pills ad-filter-pills-inline" role="tablist" aria-label="Filter by type">
              {BID_TYPE_TABS.map(t => (
                <button key={t} role="tab" aria-selected={filterTab === t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => update({ type: t })}>{t}</button>
              ))}
            </div>
            <div className="ad-bids-toolbar-right">
              <label className="ad-select-wrap">
                <span>Status</span>
                <select value={statusFilter} onChange={e => update({ status: e.target.value })}>
                  {Object.entries(BID_STATUS_FILTERS).map(([key, { label }]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="ad-select-wrap">
                <span>Sort</span>
                <select value={sort} onChange={e => update({ sort: e.target.value })}>
                  {Object.entries(BID_SORTS).map(([key, { label }]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>
      </div>

      {!firstLoad && !loadFailed && (
        <div className="ad-bids-count" aria-live="polite" ref={listTopRef} tabIndex={-1}>
          {countText}
          {showPager && pg.totalPages > 1 && <span className="ad-bids-count-page"> · Page {pg.page} of {pg.totalPages}</span>}
        </div>
      )}

      <div className="ad-bid-cards">
        {loadFailed
          ? <div className="ad-card ad-bid-cards-empty">
              <EmptyState
                icon={AlertTriangle}
                title="Couldn't load projects"
                description={error}
                action={<button type="button" className="ad-btn-cancel" onClick={() => refreshProjects()}><RefreshCw size={14} aria-hidden="true" /> Try again</button>}
              />
            </div>
          : firstLoad
          ? Array.from({ length: 6 }).map((_, i) => (
              <div className="ad-bid-card" key={i} aria-hidden="true">
                <Skeleton width={48} height={48} radius={12} />
                <Skeleton width="70%" height={18} style={{ marginTop: 18 }} />
                <Skeleton width="40%" style={{ marginTop: 10 }} />
                <Skeleton width="100%" height={36} radius={8} style={{ marginTop: 14 }} />
              </div>
            ))
          : pg.total === 0
          ? <div className="ad-card ad-bid-cards-empty">
              <EmptyState
                icon={biddable.length === 0 ? FolderOpen : Search}
                title={biddable.length === 0 ? 'No projects available for bidding yet' : 'No projects match your search or filters'}
                description={biddable.length === 0
                  ? 'Projects appear here once the Head approves them and you publish them for bidding.'
                  : 'Try a different search term, type, or status filter.'}
                action={biddable.length === 0
                  ? <Link to={ws('/projects')} className="ad-btn-cancel">Go to Projects</Link>
                  : <button type="button" className="ad-btn-cancel" onClick={() => update({ q: '', type: 'All', status: 'all' })}>Clear filters</button>}
              />
            </div>
          : pg.items.map(p => (
            <div
              className="ad-bid-card"
              key={p.id}
              onClick={() => navigate(`${ws('')}/bids/${p.id}`)}
              onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); navigate(`${ws('')}/bids/${p.id}`) } }}
              role="button"
              tabIndex={0}
              aria-label={`Evaluate bids for ${p.name}`}
            >
              <div className="ad-bid-card-top">
                <div className="ad-bid-card-icon" aria-hidden="true"><FolderOpen size={22} /></div>
                <StatusBadge domain="project" status={p.status} />
              </div>
              <div className="ad-bid-card-name">{p.name}</div>
              <div className="ad-ref-line"><RefCode code={p.code} /></div>
              <dl className="ad-bid-card-meta">
                <div><dt>Budget (ABC)</dt><dd className="ad-bid-card-budget">{p.budget}</dd></div>
                <div><dt>Type</dt><dd>{p.type}</dd></div>
                {p.category && <div className="ad-bid-card-meta-full"><dt>Category</dt><dd>{p.category}</dd></div>}
              </dl>
              <div className="ad-bid-card-footer">
                <span className="ad-bid-card-count">
                  <FileText size={16} aria-hidden="true" /> {p.bids} bid{p.bids !== 1 ? 's' : ''}
                </span>
                <span className="ad-bid-card-cta">Evaluate <ChevronRight size={17} className="ad-bid-card-arrow" aria-hidden="true" /></span>
              </div>
            </div>
          ))
        }
      </div>

      {showPager && !loadFailed && (
        <BidPager
          page={pg.page}
          totalPages={pg.totalPages}
          pageSize={pg.pageSize}
          onPage={goToPage}
          onPageSize={size => update({ size })}
        />
      )}
    </div>
  )
}
// Previous / numbered pages / Next, plus a page-size menu.
function BidPager({ page, totalPages, pageSize, onPage, onPageSize }) {
  return (
    <nav className="ad-pager" aria-label="Project list pages">
      <label className="ad-pager-size">
        <span>Per page</span>
        <select value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
          {BID_PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      {totalPages > 1 && (
        <div className="ad-pager-nav">
          <button type="button" className="ad-pager-btn ad-pager-step" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
            <ChevronLeft size={16} aria-hidden="true" /> <span className="ad-pager-step-text">Previous</span>
          </button>
          <ol className="ad-pager-pages">
            {pageList(page, totalPages).map((n, i) => n === 'gap'
              ? <li key={`gap-${i}`} className="ad-pager-gap" aria-hidden="true">…</li>
              : <li key={n}>
                  <button
                    type="button"
                    className={`ad-pager-btn${n === page ? ' ad-pager-current' : ''}`}
                    onClick={() => onPage(n)}
                    aria-label={`Page ${n}`}
                    aria-current={n === page ? 'page' : undefined}
                  >{n}</button>
                </li>
            )}
          </ol>
          <span className="ad-pager-mobile-status" aria-hidden="true">{page} / {totalPages}</span>
          <button type="button" className="ad-pager-btn ad-pager-step" onClick={() => onPage(page + 1)} disabled={page >= totalPages} aria-label="Next page">
            <span className="ad-pager-step-text">Next</span> <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </nav>
  )
}
