// May this browser ask a wallet to sign an anchor, and is the wallet on the
// right network? Pure functions (no env, no wallet), so they can be unit-tested
// and every "Anchor now" button and runAnchor() decide the same way.
//
// Two independent switches turn signing off; either one is enough:
//   * the build: VITE_BLOCKCHAIN_SIGNING=off (contract.js reads it), and
//   * the backend: every anchor carries `signing_enabled`, false when the
//     deployment runs with BLOCKCHAIN_WALLET_SIGNING=False. The /anchor/
//     endpoints refuse writes there anyway; this keeps the browser from even
//     opening MetaMask for a transaction the server would throw away.
import { WrongNetworkError, assertChainId } from './network.js'

export const SIGNING_DISABLED_MESSAGE =
  'Blockchain signing is disabled in this deployment (read-only). ' +
  'The record is saved, but it can’t be anchored here. No wallet was contacted.'

/** True for the values that mean "off" in VITE_BLOCKCHAIN_SIGNING. Unset = on. */
export const isSigningOffFlag = (value) =>
  ['off', 'false', '0', 'no', 'disabled'].includes(String(value ?? '').trim().toLowerCase())

/**
 * Why this anchor must NOT be signed here, or '' when signing is allowed.
 * A missing `signing_enabled` (an older backend) counts as allowed, so the
 * default production behaviour is unchanged.
 */
export function signingBlockedReason(anchor, { buildSigningOff = false } = {}) {
  if (buildSigningOff) return SIGNING_DISABLED_MESSAGE
  if (anchor && anchor.signing_enabled === false) return SIGNING_DISABLED_MESSAGE
  return ''
}

/** Readable chain id for messages: "1", "5042002", or the raw value if unparseable. */
const chainLabel = (reported) => {
  try { return BigInt(reported).toString() } catch { return String(reported) }
}

/**
 * '' when `reported` (eth_chainId's answer) is the expected network, otherwise
 * the message to show. The app never switches networks for the user: a switch
 * prompt the user didn't ask for is exactly how an unexpected wallet request
 * starts, so they switch in MetaMask themselves and press Anchor now again.
 */
export function walletNetworkProblem(reported, expected) {
  try {
    assertChainId(reported, expected)
    return ''
  } catch (err) {
    if (!(err instanceof WrongNetworkError)) throw err
    return `MetaMask is on a different network (chain ID ${chainLabel(reported)}), not Sepolia ` +
      `(chain ID ${expected}). Nothing was sent. Switch MetaMask to Sepolia yourself, then press Anchor now again.`
  }
}
