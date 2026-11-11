// The two anchor calls that only talk to our own backend (no wallet, no ethers).
// Kept apart from anchor.js so the server-signing path and the save-only retry
// never download ethers. anchor.js re-exports both.
import { apiFetch } from '../api'
import { AnchorError, signingBlocked } from './signingState'

/**
 * Tell the backend which transaction anchored a record. Separate from
 * anchorTransition so a failed save can be retried on its own: the transaction
 * is already mined and immutable, so re-signing would only burn gas to record
 * the identical hash twice.
 *
 * The endpoint is idempotent, so a retry that turns out to have already
 * succeeded is harmless.
 */
export function attachAnchorTx(anchor, { txHash, blockNumber, actorAddress = '' }) {
  return apiFetch(anchor.attach_url, {
    method: 'POST',
    body: JSON.stringify({
      anchor_id: anchor.id,
      stage: anchor.stage,
      tx_hash: txHash,
      block_number: blockNumber,
      actor_address: actorAddress,
    }),
  })
}

/**
 * Ask the backend to sign and send this anchor itself (no wallet involved).
 * Only used when the deployment has server signing on — `anchor.server_signing`
 * says so. Goes through the record's own /anchor/ endpoint, so the same role
 * checks apply as for a MetaMask attach. Resolves to the updated anchor.
 */
export function serverSubmitAnchor(anchor) {
  const blocked = signingBlocked(anchor)
  if (blocked) return Promise.reject(new AnchorError(blocked, 'SIGNING_DISABLED'))
  return apiFetch(anchor.attach_url, {
    method: 'POST',
    body: JSON.stringify({ anchor_id: anchor.id, stage: anchor.stage, server_submit: true }),
  })
}
