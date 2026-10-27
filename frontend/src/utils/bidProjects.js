// Filtering, sorting and pagination for the Admin "Bid Evaluation" project list.
// Kept as plain functions (no React) so the rules can be unit tested with
// `node --test` and so the page always filters + sorts the FULL list before
// slicing out a page — never just the cards currently on screen.

// Only Head-approved projects can receive/evaluate bids — not drafts, items
// still awaiting approval, or rejected ones (those stay in Planning).
const NOT_BIDDABLE = ['draft', 'pending_head', 'needs_revision', 'rejected']
export const isBiddable = (p) => !NOT_BIDDABLE.includes(p.status)

export const BID_TYPE_TABS = ['All', 'Goods', 'Services', 'Infrastructure', 'More']

// Status groups. "Active" hides finished (awarded/closed) projects so the ones
// still needing a decision are front and centre.
export const BID_STATUS_FILTERS = {
  active:  { label: 'Active (needs review)', test: p => ['approved', 'published', 'active'].includes(p.status) },
  awarded: { label: 'Awarded',              test: p => p.status === 'awarded' },
  all:     { label: 'All statuses',         test: () => true },
}

// Sort projects with no/invalid deadline to the end.
function deadlineVal(p) {
  const t = new Date(p.deadline).getTime()
  return Number.isNaN(t) ? Infinity : t
}

// Every comparator ends in an id tie-break so equal items keep a stable order —
// otherwise two projects with the same bid count could swap between page 1 and
// page 2 on a refresh, and one would appear twice while the other vanished.
const byId = (a, b) => a.id - b.id
export const BID_SORTS = {
  bids_desc: { label: 'Most bids',        cmp: (a, b) => (b.bids - a.bids) || byId(a, b) },
  deadline:  { label: 'Deadline soonest', cmp: (a, b) => (deadlineVal(a) - deadlineVal(b)) || byId(a, b) },
  name:      { label: 'Name (A–Z)',       cmp: (a, b) => a.name.localeCompare(b.name) || byId(a, b) },
}

export const BID_PAGE_SIZES = [12, 24, 48]
export const DEFAULT_BID_PAGE_SIZE = 12

function matchesType(p, tab) {
  const type = p.type || ''
  if (tab === 'Services')       return type.includes('Services')
  if (tab === 'Goods')          return type.includes('Equipment') || type.includes('Goods')
  if (tab === 'Infrastructure') return type.includes('Infrastructure')
  return true  // 'All' and 'More'
}

/** Biddable projects matching the type tab, status group and search, sorted. */
export function filterBidProjects(projects, { type = 'All', status = 'active', search = '', sort = 'bids_desc' } = {}) {
  const statusTest = (BID_STATUS_FILTERS[status] || BID_STATUS_FILTERS.active).test
  const cmp = (BID_SORTS[sort] || BID_SORTS.bids_desc).cmp
  const q = search.trim().toLowerCase()
  return projects
    .filter(p =>
      isBiddable(p) &&
      matchesType(p, type) &&
      statusTest(p) &&
      (!q || p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q))
    )
    .sort(cmp)
}

/**
 * One page of `items`. `page` is 1-based and clamped into range, so a page
 * number that no longer exists (e.g. after a project was awarded and dropped
 * out of the "Active" filter) shows the last real page instead of nothing.
 */
export function paginate(items, page, pageSize) {
  const size = BID_PAGE_SIZES.includes(pageSize) ? pageSize : DEFAULT_BID_PAGE_SIZE
  const total = items.length
  const totalPages = Math.max(1, Math.ceil(total / size))
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages)
  const start = (current - 1) * size
  const pageItems = items.slice(start, start + size)
  return {
    items: pageItems,
    page: current,
    pageSize: size,
    total,
    totalPages,
    from: total === 0 ? 0 : start + 1,   // "Showing 13–24 of 47"
    to: start + pageItems.length,
  }
}

/**
 * Compact list of page buttons: always first and last, the current page and
 * its neighbours, with 'gap' markers between — 1 … 4 5 6 … 20.
 */
export function pageList(current, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
  const pages = new Set([1, totalPages, current - 1, current, current + 1])
  if (current <= 3) [2, 3, 4].forEach(n => pages.add(n))
  if (current >= totalPages - 2) [totalPages - 3, totalPages - 2, totalPages - 1].forEach(n => pages.add(n))
  const sorted = [...pages].filter(n => n >= 1 && n <= totalPages).sort((a, b) => a - b)
  const out = []
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) out.push('gap')
    out.push(n)
  })
  return out
}
