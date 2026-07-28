// Anchoring progress, shared outside React.
//
// Every dashboard triggers anchoring from a different handler (approve, publish,
// submit bid, qualify, select winner…), but they all need the same "Anchoring…
// → anchored, here's the transaction" feedback and the same retry. Keeping that
// in one small external store means each handler is a single line and there is
// exactly one place that talks to MetaMask.
//
// Only ONE activity is tracked at a time: anchoring is a wallet interaction, and
// MetaMask itself serialises those — a second prompt can't be answered while the
// first is open.
import { useSyncExternalStore } from 'react'

import { AnchorError, anchorTransition, attachAnchorTx, hasWallet, isUserRejection } from './anchor'
import { isLedgerConfigured, txUrl } from './contract'

const listeners = new Set()
let activity = null // { state, anchor, label, txHash, blockNumber, message }
let snapshot = { activity }

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l) }
const getSnapshot = () => snapshot
const emit = () => {
  snapshot = { activity }
  listeners.forEach((l) => l())
}

const set = (next) => { activity = next; emit() }

/** Human wording per phase, shown in the anchoring card. */
const MESSAGES = {
  signing: 'Waiting for MetaMask — confirm the transaction to anchor this record.',
  mining: 'Anchoring on Sepolia… waiting for the transaction to be mined.',
  saving: 'Transaction confirmed. Saving the reference…',
  done: 'Recorded on the blockchain.',
  rejected: 'Not anchored — the MetaMask signature was declined. You can retry any time.',
  unavailable: 'Not anchored — no wallet or contract configured. The record is saved and can be anchored later.',
  error: 'Could not anchor this record. The record itself is saved — you can retry.',
  unsaved: 'Anchored on-chain, but the app could not save the reference. Retry to save it (no extra gas).',
}

export function useAnchorActivity() {
  return useSyncExternalStore(subscribe, getSnapshot).activity
}

export function dismissAnchorActivity() {
  set(null)
}

/**
 * Anchor one transition, reporting progress into this store.
 *
 * Deliberately NOT awaited by callers and never re-throws: the status change has
 * already been saved by the time this runs, so an anchoring problem is feedback,
 * not a failed operation. `label` describes the record for the UI, e.g.
 * "P-2026-001 · Approved by Head".
 *
 * @returns {Promise<boolean>} whether the anchor made it on-chain.
 */
export async function runAnchor(anchor, { label = '' } = {}) {
  if (!anchor) return false

  // Already on-chain before the browser ever saw it — the backend signed and
  // submitted this anchor itself (BLOCKCHAIN_SERVER_SIGNING). Prompting for a
  // wallet signature now would write the IDENTICAL hash a second time: a
  // duplicate entry in the trail, paid for twice, for no added proof.
  //
  // Every caller passes the `anchor` straight from a transition response, so
  // this one guard covers all of them — no dashboard needs to know whether the
  // deployment signs server-side or through MetaMask. Reported as 'done' rather
  // than skipped silently, because from the user's point of view it IS done.
  if (anchor.anchored || anchor.tx_hash) {
    set({
      state: 'done', anchor, label,
      txHash: anchor.tx_hash, blockNumber: anchor.block_number,
      message: MESSAGES.done,
      explorerUrl: txUrl(anchor.tx_hash),
    })
    return true
  }

  if (!isLedgerConfigured() || !hasWallet()) {
    set({
      state: 'unavailable', anchor, label,
      message: !hasWallet()
        ? 'MetaMask was not detected, so this record is not anchored yet. Install MetaMask and retry from the record.'
        : MESSAGES.unavailable,
    })
    return false
  }

  set({ state: 'signing', anchor, label, message: MESSAGES.signing })
  try {
    const result = await anchorTransition(anchor, {
      // signing (wallet popup) → mining (broadcast) → saving (tx confirmed).
      onStatus: ({ state, txHash, blockNumber }) => {
        set({
          state, anchor, label, txHash, blockNumber,
          message: MESSAGES[state] || MESSAGES.mining,
          explorerUrl: txUrl(txHash),
        })
      },
    })
    set({
      state: 'done', anchor, label,
      txHash: result.txHash, blockNumber: result.blockNumber,
      message: MESSAGES.done,
      explorerUrl: txUrl(result.txHash),
    })
    return true
  } catch (err) {
    if (isUserRejection(err)) {
      set({ state: 'rejected', anchor, label, message: MESSAGES.rejected })
      return false
    }
    if (err instanceof AnchorError && err.code === 'NOT_SAVED') {
      // Keep the tx details: the retry only has to re-save them (see below).
      set({
        state: 'unsaved', anchor, label,
        txHash: activity?.txHash, blockNumber: activity?.blockNumber,
        explorerUrl: txUrl(activity?.txHash),
        message: err.message || MESSAGES.unsaved,
      })
      return false
    }
    set({ state: 'error', anchor, label, message: err?.message || MESSAGES.error })
    return false
  }
}

/**
 * Retry whatever is currently on screen.
 *
 * The 'unsaved' case is special: the transaction is already mined and immutable,
 * so it only re-posts the reference. Re-signing would burn gas writing the
 * identical hash a second time.
 */
export async function retryAnchor() {
  if (!activity?.anchor) return false
  const { anchor, label, state, txHash, blockNumber } = activity

  if (state === 'unsaved' && txHash) {
    set({ ...activity, state: 'saving', message: MESSAGES.saving })
    try {
      await attachAnchorTx(anchor, { txHash, blockNumber })
      set({
        state: 'done', anchor, label, txHash, blockNumber,
        explorerUrl: txUrl(txHash), message: MESSAGES.done,
      })
      return true
    } catch (err) {
      set({
        state: 'unsaved', anchor, label, txHash, blockNumber,
        explorerUrl: txUrl(txHash),
        message: err?.message || MESSAGES.unsaved,
      })
      return false
    }
  }
  return runAnchor(anchor, { label })
}

/** True while a wallet interaction is in flight — used to disable retry buttons. */
export const isAnchorBusy = (act) =>
  !!act && ['signing', 'mining', 'saving'].includes(act.state)
