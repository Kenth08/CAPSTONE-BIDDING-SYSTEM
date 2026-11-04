// One vocabulary for "where is this anchor?", used by every badge and trail.
//
// A tx hash stored on an anchor is only a CLAIM (the browser posted it, or the
// server broadcast it). It counts as on-chain once the server has read the
// receipt back and found an AnchorRecorded event from our ledger with exactly
// this entity / code / stage / hash — `verified_on_chain` from the API
// (blockchain.confirm_anchor). The public verifier additionally reads the
// contract itself in the browser.

export const ANCHOR_STATES = {
  verified: { text: 'Verified on-chain', tone: 'success' },
  reported: { text: 'Transaction reported', tone: 'info' },
  mismatch: { text: 'Reported transaction does not contain this record', tone: 'danger' },
  pending: { text: 'Hash recorded, not yet on-chain', tone: 'warning' },
}

/** 'verified' | 'reported' | 'mismatch' | 'pending' for one anchor summary. */
export function anchorState(a) {
  if (!a) return 'pending'
  if (a.chain_status === 'mismatch') return 'mismatch'
  if (a.verified_on_chain || (a.tx_hash && a.chain_status === 'confirmed')) return 'verified'
  if (a.anchored || a.tx_hash) return 'reported'
  return 'pending'
}

export const isVerified = (a) => anchorState(a) === 'verified'

/** May this anchor be signed (again)? Never-signed ones, and ones whose
 *  reported transaction turned out not to record them. */
export const canSign = (a) => {
  const s = anchorState(a)
  return s === 'pending' || s === 'mismatch'
}
