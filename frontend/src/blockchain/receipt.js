// Re-checking an evaluation inclusion receipt in the browser.
//
// The backend hashes with
//     json.dumps(value, sort_keys=True, separators=(",", ":"))   (ensure_ascii on)
// then SHA-256, "0x"-prefixed (blockchain.hash_payload). canonicalJson below
// reproduces those bytes exactly, so a bidder can recompute their own leaf and
// the anchored commitment without trusting the server's arithmetic:
//
//   1. sha256(canonical(leaf_fields))  === leaf
//   2. leaf is one of payload.leaves
//   3. sha256(canonical(payload))       === anchor.data_hash   (the value on-chain)

/** Python json.dumps(..., sort_keys=True, separators=(",", ":")) — ASCII-escaped. */
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('canonicalJson: only integers are hashed (amounts are strings)')
    // Beyond 2^53 JSON.parse has already rounded the number, so hashing it
    // would "prove" a value that was never recorded. Refuse instead.
    if (!Number.isSafeInteger(value)) throw new Error('canonicalJson: integer too large to reproduce exactly')
    return String(value)
  }
  if (typeof value === 'string') {
    // JSON.stringify escapes quotes, backslashes and control characters the
    // same way Python does; Python additionally escapes every non-ASCII
    // character as \uXXXX (lowercase hex, UTF-16 units).
    return JSON.stringify(value).replace(/[\u007f-￿]/g,
      (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (typeof value === 'object') {
    // Python sorts keys by code point; plain sort() on these ASCII keys matches.
    const keys = Object.keys(value).sort()
    return '{' + keys.map((k) => canonicalJson(k) + ':' + canonicalJson(value[k])).join(',') + '}'
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`)
}

export async function sha256Text(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return '0x' + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// async so a payload that can't be serialized rejects like any other failure.
export const hashPayload = async (value) => sha256Text(canonicalJson(value))

/**
 * Check a receipt from GET /projects/{id}/record/ (`receipts[].receipt`).
 * @returns {Promise<{leafOk, included, commitmentOk, leaf, commitment}>}
 */
export async function verifyReceipt(receipt) {
  const leaf = await hashPayload(receipt.leaf_fields)
  const commitment = await hashPayload(receipt.payload)
  return {
    leaf,
    commitment,
    leafOk: leaf === receipt.leaf,
    included: (receipt.payload?.leaves || []).includes(leaf),
    commitmentOk: commitment.toLowerCase() === (receipt.anchor?.data_hash || '').toLowerCase(),
  }
}
