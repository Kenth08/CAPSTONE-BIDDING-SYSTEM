// Writing and reading procurement anchors on the ProcurementLedger contract.
//
// The flow, end to end:
//   1. A normal API call performs the status change (approve, publish, bid…).
//      That change is COMMITTED and final before any wallet is involved.
//   2. The response carries `anchor` = { id, entity_type, entity_ref, stage,
//      data_hash, attach_url } — the hash Django computed over the record + its
//      key document.
//   3. anchorOnChain() asks MetaMask to sign a recordEvent() transaction for
//      that hash and waits for it to be mined.
//   4. The tx hash + block number are posted back to `attach_url` so the record
//      can show "anchored" and link to Etherscan.
//
// Steps 3–4 are allowed to fail. A declined signature, the wrong network, or an
// empty gas tank leaves the record valid and simply un-anchored, retryable from
// the blockchain badge. Nothing here ever rolls back step 1.
import { BrowserProvider, Contract, JsonRpcProvider } from 'ethers'

import { apiFetch } from '../api'
import {
  LEDGER_ABI,
  LEDGER_ADDRESS,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_CHAIN_ID_HEX,
  SEPOLIA_NETWORK,
  SEPOLIA_RPC_URL,
  isLedgerConfigured,
} from './contract'

/** Error carrying a `code` so the UI can tell "the user said no" (which is not a
 *  failure worth shouting about) from a real problem. */
export class AnchorError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'AnchorError'
    this.code = code
  }
}

export const hasWallet = () => typeof window !== 'undefined' && !!window.ethereum

/** MetaMask / EIP-1193 codes we treat as "the user declined", not as an error. */
const REJECTED_CODES = new Set([4001, 'ACTION_REJECTED'])
export const isUserRejection = (err) =>
  REJECTED_CODES.has(err?.code) ||
  REJECTED_CODES.has(err?.info?.error?.code) ||
  /user (rejected|denied)/i.test(err?.message || '')

/**
 * Make sure the wallet is on Sepolia, prompting a switch (and offering to add
 * the network if it isn't there yet). Signing on the wrong chain would write the
 * anchor to a different ledger, so this is a hard precondition, not a nicety.
 */
export async function ensureSepolia() {
  if (!hasWallet()) throw new AnchorError('MetaMask is not installed in this browser.', 'NO_WALLET')
  const current = await window.ethereum.request({ method: 'eth_chainId' })
  if (current?.toLowerCase() === SEPOLIA_CHAIN_ID_HEX) return

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
    })
  } catch (err) {
    // 4902 = the chain isn't configured in this wallet yet; add it, then retry.
    if (err?.code === 4902 || err?.data?.originalError?.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [SEPOLIA_NETWORK],
      })
      return
    }
    if (isUserRejection(err)) {
      throw new AnchorError('Switch MetaMask to the Sepolia test network to anchor.', 'WRONG_NETWORK')
    }
    throw err
  }
}

/** Connected wallet address, prompting the connection popup if needed. */
export async function connectWallet() {
  if (!hasWallet()) throw new AnchorError('MetaMask is not installed in this browser.', 'NO_WALLET')
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
  if (!accounts?.length) throw new AnchorError('No MetaMask account was connected.', 'NO_ACCOUNT')
  return accounts[0]
}

/**
 * Write one anchor to the ledger with MetaMask and wait for it to be mined.
 *
 * @returns {Promise<{txHash: string, blockNumber: number, actorAddress: string}>}
 */
export async function anchorOnChain({ entityType, entityRef, stage, dataHash, onSubmitted }) {
  if (!isLedgerConfigured()) {
    throw new AnchorError(
      'No ledger contract address configured. Set VITE_LEDGER_ADDRESS in frontend/.env.',
      'NOT_CONFIGURED',
    )
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(dataHash || '')) {
    // The contract requires exactly 0x + 64 hex — fail here with a clear message
    // instead of paying gas for a revert.
    throw new AnchorError('The record hash is malformed; nothing was sent on-chain.', 'BAD_HASH')
  }

  const actorAddress = await connectWallet()
  await ensureSepolia()

  // Build the provider AFTER the network switch so ethers reads the final chain.
  const provider = new BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()
  const ledger = new Contract(LEDGER_ADDRESS, LEDGER_ABI, signer)

  const tx = await ledger.recordEvent(entityType, entityRef, stage, dataHash)
  // Signed and broadcast — from here it's just waiting for a Sepolia block
  // (usually a few seconds, occasionally much longer), so tell the UI.
  onSubmitted?.(tx.hash)
  const receipt = await tx.wait()
  return {
    txHash: receipt?.hash || tx.hash,
    blockNumber: Number(receipt?.blockNumber ?? 0) || null,
    actorAddress,
  }
}

/**
 * Full anchor flow for one transition: sign it, then tell the backend.
 *
 * @param anchor   The `anchor` object from a transition response.
 * @param onStatus Optional progress callback: 'signing' → 'mining' → 'saving' → 'done'.
 */
export async function anchorTransition(anchor, { onStatus } = {}) {
  if (!anchor) return null
  const report = (state, extra = {}) => onStatus?.({ state, anchor, ...extra })

  report('signing')
  const { txHash, blockNumber, actorAddress } = await anchorOnChain({
    entityType: anchor.entity_type,
    entityRef: anchor.entity_ref,
    stage: anchor.stage,
    dataHash: anchor.data_hash,
    onSubmitted: (hash) => report('mining', { txHash: hash }),
  })

  report('saving', { txHash, blockNumber })
  // Best-effort: the transaction is already on-chain and permanent at this
  // point, so a failure here only means our own copy of the tx hash is missing.
  // Surfaced as its own state so the UI can offer a save-only retry
  // (attachAnchorTx) instead of paying gas for a second transaction.
  try {
    const saved = await attachAnchorTx(anchor, { txHash, blockNumber, actorAddress })
    report('done', { txHash, blockNumber, saved })
    return { txHash, blockNumber, saved }
  } catch (err) {
    report('unsaved', { txHash, blockNumber, actorAddress, error: err })
    throw new AnchorError(
      `Anchored on-chain (tx ${txHash.slice(0, 10)}…) but the app could not record it. Retry to save it.`,
      'NOT_SAVED',
    )
  }
}

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

// ── Reads (no wallet, no gas, works for anonymous visitors) ─────────────────

let readProvider = null
const getReadProvider = () => {
  if (!readProvider) {
    // staticNetwork skips the chain-id round trip on every call — the RPC URL
    // already tells us which network this is.
    readProvider = new JsonRpcProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, { staticNetwork: true })
  }
  return readProvider
}

/** Read-only contract handle for the public verification page. */
export const getReadOnlyLedger = () =>
  new Contract(LEDGER_ADDRESS, LEDGER_ABI, getReadProvider())

/**
 * Read a procurement's whole trail straight from the contract.
 *
 * Uses getAnchorsByRef (one round trip). Falls back to getAnchorIds + getAnchor
 * per id if that call isn't available — e.g. against an older deployment of the
 * contract that predates the batch getter.
 *
 * @returns {Promise<Array<{entityType,entityRef,stage,dataHash,actor,timestamp}>>}
 */
export async function readChainTrail(entityRef) {
  if (!isLedgerConfigured() || !entityRef) return []
  const ledger = getReadOnlyLedger()

  const shape = (row) => ({
    entityType: row[0],
    entityRef: row[1],
    stage: row[2],
    dataHash: row[3],
    actor: row[4],
    timestamp: Number(row[5]) * 1000, // seconds → ms for the JS Date
  })

  try {
    const rows = await ledger.getAnchorsByRef(entityRef)
    return rows.map(shape)
  } catch {
    const ids = await ledger.getAnchorIds(entityRef)
    const rows = await Promise.all(ids.map((id) => ledger.getAnchor(id)))
    return rows.map(shape)
  }
}

/** Total anchors on the ledger — a cheap "the contract is reachable" probe. */
export async function readLedgerTotal() {
  if (!isLedgerConfigured()) return null
  return Number(await getReadOnlyLedger().total())
}

/**
 * SHA-256 of a File the visitor picked, formatted exactly like the backend's
 * hash_file() ("0x" + 64 hex) so the two can be compared directly. Runs entirely
 * in the browser via WebCrypto — the file is never uploaded anywhere.
 */
export async function sha256File(file) {
  const buffer = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return '0x' + hex
}
