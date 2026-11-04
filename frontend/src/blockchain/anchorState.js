import { incompleteLabel } from './payloadV3.js'

// One vocabulary for "where is this anchor?", used by every badge and trail.
//
// A tx hash stored on an anchor is only a CLAIM (the browser posted it, or the
// server broadcast it). It counts as on-chain once the server has read the
// receipt back and found an AnchorRecorded event from our ledger with exactly
// this entity / code / stage / hash — `verified_on_chain` from the API
// (blockchain.confirm_anchor). The public verifier additionally reads the
// contract itself in the browser.
//
// The server's confirmation is not a complete verification: it says nothing about a
// record's five documents, and the server is vouching for itself. So it is blue. Only
// the browser's own check with complete evidence shows green (PacketCheck). The state
// key stays `verified`, matching the API's `verified_on_chain`; what's shown is not.

export const ANCHOR_STATES = {
  verified: { text: 'Confirmed on-chain', tone: 'info' },
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

const INCOMPLETE = new Set(['incomplete', 'unreadable_when_recorded'])

/** Does this anchor record that documents were missing? */
export const hasIncompleteEvidence = (a) => INCOMPLETE.has(a?.completeness?.status)

/**
 * What one anchor's chip says: { state, text, tone, title }. A confirmed transaction
 * can't make incomplete evidence look finished, and a legacy record says it is one.
 */
export function anchorChip(a) {
  const state = anchorState(a)
  const base = { state, ...ANCHOR_STATES[state], title: ANCHOR_STATES[state].text }
  if (state !== 'verified') return base
  const c = a.completeness
  if (hasIncompleteEvidence(a)) {
    return { ...base, tone: 'warning', text: `Confirmed on-chain · incomplete evidence (${c.present} of ${c.total})`,
      title: incompleteLabel(c) }
  }
  if (c?.status === 'not_recorded') {
    return { ...base, text: 'Confirmed on-chain · legacy record',
      title: 'Checked under its original rules; five-document completeness was not checked.' }
  }
  return base
}

/** May this anchor be signed (again)? Never-signed ones, and ones whose
 *  reported transaction turned out not to record them. */
export const canSign = (a) => {
  const s = anchorState(a)
  return s === 'pending' || s === 'mismatch'
}
