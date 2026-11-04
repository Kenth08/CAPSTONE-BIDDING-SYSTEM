// Which chain is the read RPC really on?
//
// The public verifier reads through a JsonRpcProvider with `staticNetwork`,
// which skips ethers' own chain-id probe. A VITE_SEPOLIA_RPC_URL pointing at
// another network would then answer every read without complaint, so the
// chain id is checked once, here, before any result is trusted.

export class WrongNetworkError extends Error {
  constructor(reported, expected) {
    super(`The blockchain RPC is on chain ${reported}, not Sepolia (${expected}); nothing read from it is trusted.`)
    this.name = 'WrongNetworkError'
    this.reported = reported
  }
}

/** Throws unless `reported` (hex or number, as eth_chainId returns) equals `expected`. */
export function assertChainId(reported, expected) {
  let id
  try {
    id = BigInt(reported)
  } catch {
    throw new WrongNetworkError(String(reported), expected)
  }
  if (id !== BigInt(expected)) throw new WrongNetworkError(id.toString(), expected)
}
