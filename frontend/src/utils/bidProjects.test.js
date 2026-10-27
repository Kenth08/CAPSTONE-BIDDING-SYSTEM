// Run with: npm test   (Node's built-in test runner — no extra dependencies)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterBidProjects, paginate, pageList, DEFAULT_BID_PAGE_SIZE } from './bidProjects.js'

const make = (n, over = {}) => ({
  id: n, name: `Project ${String(n).padStart(3, '0')}`, code: `PRC-2026-AAAA-${String(n).padStart(4, '0')}`,
  type: 'Goods', status: 'published', bids: 0, deadline: '', ...over,
})
const many = (count, over) => Array.from({ length: count }, (_, i) => make(i + 1, over))

test('drafts, pending, revision and rejected projects are never listed', () => {
  const list = ['draft', 'pending_head', 'needs_revision', 'rejected', 'published']
    .map((status, i) => make(i + 1, { status }))
  const out = filterBidProjects(list, { status: 'all' })
  assert.deepEqual(out.map(p => p.status), ['published'])
})

test('status groups: active hides awarded/closed, awarded shows only awarded', () => {
  const list = [make(1, { status: 'published' }), make(2, { status: 'awarded' }), make(3, { status: 'closed' })]
  assert.deepEqual(filterBidProjects(list, { status: 'active' }).map(p => p.id), [1])
  assert.deepEqual(filterBidProjects(list, { status: 'awarded' }).map(p => p.id), [2])
  assert.equal(filterBidProjects(list, { status: 'all' }).length, 3)
})

test('type tabs filter by project type', () => {
  const list = [make(1, { type: 'Goods' }), make(2, { type: 'Consulting Services' }), make(3, { type: 'Infrastructure' })]
  assert.deepEqual(filterBidProjects(list, { type: 'Services' }).map(p => p.id), [2])
  assert.deepEqual(filterBidProjects(list, { type: 'Infrastructure' }).map(p => p.id), [3])
  assert.equal(filterBidProjects(list, { type: 'All' }).length, 3)
})

test('search matches name or code, case-insensitively', () => {
  const list = [make(1, { name: 'Hospital Beds' }), make(2, { code: 'PRC-2026-7K4M-Q9XT' })]
  assert.deepEqual(filterBidProjects(list, { search: 'hospital' }).map(p => p.id), [1])
  assert.deepEqual(filterBidProjects(list, { search: '  7k4m ' }).map(p => p.id), [2])
  assert.equal(filterBidProjects(list, { search: 'nothing' }).length, 0)
})

test('sorting runs on the full list before paging', () => {
  // 30 projects; the one with the most bids is last in the input.
  const list = many(30).map(p => ({ ...p, bids: p.id === 30 ? 99 : 1 }))
  const sorted = filterBidProjects(list, { sort: 'bids_desc' })
  const first = paginate(sorted, 1, 12)
  assert.equal(first.items[0].id, 30)
})

test('sort orders are stable: ties fall back to id, so pages never overlap', () => {
  const list = many(30).reverse()   // all 0 bids
  const sorted = filterBidProjects(list, { sort: 'bids_desc' })
  const seen = [1, 2, 3].flatMap(n => paginate(sorted, n, 12).items.map(p => p.id))
  assert.equal(new Set(seen).size, 30)
  assert.deepEqual(sorted.slice(0, 3).map(p => p.id), [1, 2, 3])
})

test('name and deadline sorts', () => {
  const list = [make(1, { name: 'b', deadline: 'Dec 1, 2026' }), make(2, { name: 'a', deadline: '' }), make(3, { name: 'c', deadline: 'Nov 1, 2026' })]
  assert.deepEqual(filterBidProjects(list, { sort: 'name' }).map(p => p.name), ['a', 'b', 'c'])
  // Missing deadlines go last.
  assert.deepEqual(filterBidProjects(list, { sort: 'deadline' }).map(p => p.id), [3, 1, 2])
})

test('paginate: slices, counts and range text', () => {
  const r = paginate(many(47), 2, 12)
  assert.equal(r.items.length, 12)
  assert.equal(r.items[0].id, 13)
  assert.deepEqual([r.from, r.to, r.total, r.totalPages], [13, 24, 47, 4])
  const last = paginate(many(47), 4, 12)
  assert.deepEqual([last.from, last.to, last.items.length], [37, 47, 11])
})

test('paginate: out-of-range pages clamp instead of showing an empty page', () => {
  assert.equal(paginate(many(47), 99, 12).page, 4)
  assert.equal(paginate(many(47), 0, 12).page, 1)
  assert.equal(paginate(many(47), NaN, 12).page, 1)
})

test('paginate: fewer items than one page is a single page', () => {
  const r = paginate(many(7), 1, 12)
  assert.deepEqual([r.totalPages, r.items.length, r.from, r.to], [1, 7, 1, 7])
})

test('paginate: empty results', () => {
  const r = paginate([], 1, 12)
  assert.deepEqual([r.total, r.totalPages, r.page, r.from, r.to, r.items.length], [0, 1, 1, 0, 0, 0])
})

test('paginate: unknown page sizes fall back to the default', () => {
  assert.equal(paginate(many(40), 1, 7).pageSize, DEFAULT_BID_PAGE_SIZE)
  assert.equal(paginate(many(40), 1, 24).items.length, 24)
})

test('pageList: short lists show every page, long lists collapse with gaps', () => {
  assert.deepEqual(pageList(1, 5), [1, 2, 3, 4, 5])
  assert.deepEqual(pageList(1, 20), [1, 2, 3, 4, 'gap', 20])
  assert.deepEqual(pageList(10, 20), [1, 'gap', 9, 10, 11, 'gap', 20])
  assert.deepEqual(pageList(20, 20), [1, 'gap', 17, 18, 19, 20])
})
