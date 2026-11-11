// The parts of anchoring that don't need ethers: the error type, "is there a
// wallet", "did the user decline" and "may this browser sign this anchor".
//
// Dashboards check signingBlocked() on every render to decide whether to show an
// "Anchor now" button. Keeping it here, away from anchor.js, means opening a
// dashboard doesn't download ethers (~100 kB gzip). ethers loads only when someone
// actually signs or reads the chain. anchor.js re-exports everything here, so
// older imports keep working.
import { SIGNING_OFF_BY_BUILD } from './contract'
import { signingBlockedReason } from './signingPolicy'

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

/** Why this anchor may not be signed from this browser, or '' if it may. */
export const signingBlocked = (anchor) =>
  signingBlockedReason(anchor, { buildSigningOff: SIGNING_OFF_BY_BUILD })
