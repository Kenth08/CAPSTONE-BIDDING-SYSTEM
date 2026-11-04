// Display logic for the record details page, kept free of React so it can be
// unit-tested. Rule: a value the server does not have is shown as missing,
// with the reason — never as a placeholder that looks like real data — and a
// link is only built from a value that has the exact shape it must have.

const TX = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
export const ETHERSCAN = 'https://sepolia.etherscan.io'

/** Etherscan link for a stored tx hash, or '' for anything that isn't one. */
export const txLink = (hash) => (TX.test(hash || '') ? `${ETHERSCAN}/tx/${hash}` : '')
export const addressLink = (addr) => (ADDRESS.test(addr || '') ? `${ETHERSCAN}/address/${addr}` : '')

/** "Issue 2 of 2 — Current" / "Issue 1 of 2 — Superseded". */
export function versionLabel(v) {
  if (!v) return 'No document version'
  return `Issue ${v.number} of ${v.total} — ${v.current ? 'Current' : 'Superseded'}`
}

// Green is reserved for the browser's own independent check (PacketCheck →
// VERIFIED — MATCH). What the SERVER found is shown in neutral/info tones, so
// a stored flag or a database row can never look like a proof.
export const EVIDENCE = {
  verified: { tone: 'info', title: 'Confirmed on-chain by the server' },
  reported: { tone: 'info', title: 'Transaction reported — not yet confirmed' },
  mismatch: { tone: 'bad', title: 'Reported transaction does not record this entry' },
  database: { tone: 'warn', title: 'Database record only — not on the blockchain' },
}

/** The banner for a record: the server's chain evidence, overridden by the
 *  record check when this system's data no longer matches its fingerprint. */
export function evidenceBanner(detail) {
  if (detail.integrity?.status === 'mismatch') {
    return {
      tone: 'bad',
      title: detail.evidence === 'verified'
        ? 'On-chain record found, but the data stored here no longer matches it'
        : 'The data stored for this record no longer matches its fingerprint',
    }
  }
  return EVIDENCE[detail.evidence] || EVIDENCE.database
}

/** Finality wording that never claims more than the server established. */
export function finalityText(rec) {
  if (!rec?.verified_on_chain) return { value: null, missing: 'Only known once the transaction is confirmed' }
  if (rec.chain_finalized) return { value: 'Final (at or below the chain’s finalized block)' }
  if (rec.chain_confirmations == null) return { value: null, missing: 'The node did not report the block depth' }
  return { value: `${rec.chain_confirmations} confirmation${rec.chain_confirmations === 1 ? '' : 's'} — not yet shown to be final` }
}

/**
 * Rows for the "Blockchain evidence" list: { key, label, value | null,
 * missing (why it's absent), href?, mono? }.
 */
export function chainRows(detail) {
  const rec = detail.record
  const net = detail.network
  const confirmed = rec.verified_on_chain
  const fin = finalityText(rec)
  return [
    { key: 'network', label: 'Network', value: `${net.name} · chain ID ${net.chain_id}` },
    { key: 'contract', label: 'Smart contract', value: net.contract || null, mono: true,
      href: addressLink(net.contract), missing: 'No ledger contract is configured on this server' },
    { key: 'onchain_id', label: 'On-chain record ID',
      value: rec.chain_anchor_id != null ? `#${rec.chain_anchor_id} (getAnchor(${rec.chain_anchor_id}))` : null,
      missing: rec.tx_hash
        ? 'Not linked yet — the server has not read this record’s transaction (or its node no longer serves it)'
        : 'None — nothing has been written to the blockchain' },
    { key: 'tx', label: 'Transaction', value: TX.test(rec.tx_hash || '') ? rec.tx_hash : null, mono: true,
      href: txLink(rec.tx_hash), missing: 'No transaction has been reported' },
    { key: 'block', label: confirmed ? 'Block' : 'Block (reported, unconfirmed)',
      value: rec.block_number != null ? String(rec.block_number) : null, missing: 'Unknown' },
    { key: 'signer', label: confirmed ? 'Signer' : 'Signer (reported, unconfirmed)',
      value: rec.actor_address || null, mono: true, href: addressLink(rec.actor_address),
      missing: 'Unknown' },
    { key: 'time', label: 'Recorded on-chain at', value: rec.chain_timestamp || null, time: true,
      missing: rec.tx_hash ? 'Known once the server links the on-chain record' : 'Not on the blockchain' },
    { key: 'finality', label: 'Finality', value: fin.value, missing: fin.missing },
    { key: 'log', label: 'Event log index', value: rec.chain_log_index != null ? String(rec.chain_log_index) : null,
      missing: 'Known once the server links the on-chain record' },
  ]
}
