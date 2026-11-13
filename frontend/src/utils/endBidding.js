// Force-ending bidding before its deadline (backend ProjectViewSet.end_bidding,
// POST /projects/<id>/end-bidding/). The server decides; these rules only keep
// the UI from offering what it would refuse, and say why.

// Same roles as the backend's IsAdminOrStaffRole on end_bidding. BAC Committee
// members evaluate the bids, so they never cut the bidding period short.
export const END_BIDDING_ROLES = ['admin', 'staff']
export const END_BIDDING_REASON_LIMIT = 1000  // ProjectViewSet.END_BIDDING_REASON_LIMIT

export const END_BIDDING_TITLE = 'Force End Bidding Period?'
export const END_BIDDING_MESSAGE =
  'Are you sure you want to manually end this bidding period? This action will immediately close the ' +
  'bidding process, prevent further bid submissions, and allow the BAC Committee to proceed with bid ' +
  'evaluation and voting.'
export const END_BIDDING_SUCCESS =
  'Bidding period successfully closed. The BAC Committee may now proceed with bid evaluation and voting.'

export const canEndBidding = (role) => END_BIDDING_ROLES.includes(role)

/** Why `role` can't force-end `status`'s bidding now, or null when it can. */
export function endBiddingBlockReason(role, status) {
  if (status !== 'published') return 'Only a procurement whose bidding is open can be ended.'
  if (!canEndBidding(role)) return 'Only the Admin or Procurement Staff can end bidding early.'
  return null
}

/** The trimmed reason, or an error message: the reason is required. */
export function checkReason(raw) {
  const reason = String(raw || '').trim()
  if (!reason) return { error: 'Give the reason for ending bidding early.' }
  if (reason.length > END_BIDDING_REASON_LIMIT) {
    return { error: `Keep the reason under ${END_BIDDING_REASON_LIMIT} characters.` }
  }
  return { reason }
}
