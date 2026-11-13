import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canEndBidding, checkReason, endBiddingBlockReason, END_BIDDING_REASON_LIMIT } from './endBidding.js'

// Must match the backend: IsAdminOrStaffRole on ProjectViewSet.end_bidding.
test('only the Admin and Staff may force-end bidding', () => {
  assert.equal(canEndBidding('admin'), true)
  assert.equal(canEndBidding('staff'), true)
  for (const role of ['bac', 'head', 'supplier', '', undefined]) assert.equal(canEndBidding(role), false)
})

test('only open bidding can be ended, and the reason says who may', () => {
  assert.equal(endBiddingBlockReason('staff', 'published'), null)
  assert.match(endBiddingBlockReason('bac', 'published'), /Admin or Procurement Staff/)
  for (const status of ['closed', 'awarded', 'approved']) {
    assert.match(endBiddingBlockReason('admin', status), /bidding is open/)
  }
})

test('the reason is required, trimmed and limited', () => {
  assert.ok(checkReason('').error)
  assert.ok(checkReason('   ').error)
  assert.equal(checkReason('  Every eligible supplier has bid. ').reason, 'Every eligible supplier has bid.')
  assert.ok(checkReason('x'.repeat(END_BIDDING_REASON_LIMIT + 1)).error)
})
