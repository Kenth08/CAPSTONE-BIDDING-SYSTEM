// Display logic for the record details page, kept free of React so it can be
// unit-tested. Rule: a value the server does not have is shown as missing,
// with the reason — never as a placeholder that looks like real data — and a
// link is only built from a value that has the exact shape it must have.

import { fmtDateTime } from '../utils/format.js'

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

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DATE_STYLE = { month: 'short', day: 'numeric', year: 'numeric' }

/**
 * A moment as a Philippine date with no time of day, whatever it was given: the
 * API's date, a datetime, or the milliseconds this browser read from the ledger.
 * The public API sends dates only; this keeps a value read from the chain to the
 * same policy (SECURITY.md, "Award disclosure policy").
 */
export function publicDate(value) {
  if (value === null || value === undefined || value === '') return '—'
  const dateOnly = typeof value === 'string' && DATE_ONLY.test(value)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  // A bare date is a calendar day, not an instant: never shift it across a zone.
  return date.toLocaleDateString('en-US', { ...DATE_STYLE, timeZone: dateOnly ? 'UTC' : 'Asia/Manila' })
}

/** A time on the record page: a date for the public, exact for signed-in viewers. */
export const recordTime = (viewer, value) => (viewer === 'public' ? publicDate(value) : fmtDateTime(value))

/**
 * How the public trail may show a step whose fingerprint this browser found on the
 * ledger: { cls, text }. Never green: that compares one hash the server reported.
 * Green takes the full check (PacketCheck), which recomputes it from the payload.
 */
export function verifiedRowDisplay(completeness) {
  const status = completeness?.status
  if (status === 'complete') return { cls: 'pv-extra', text: 'Found on the ledger · all five documents recorded' }
  if (status === 'incomplete' || status === 'unreadable_when_recorded') {
    return { cls: 'pv-pending', text: `Found on the ledger · ${completeness.label}` }
  }
  if (status === 'not_recorded') return { cls: 'pv-extra', text: 'Found on the ledger · legacy record' }
  return { cls: 'pv-extra', text: 'Found on the ledger' }
}

/**
 * Was this record's payload never stored? verify_anchor still reports that as a
 * mismatch, as it always has, but no hash was compared, so nothing may call it altered.
 */
export function payloadNotStored(verification) {
  return verification?.outcome === 'not_found'
    && Boolean(verification.checked?.some((c) => c.key === 'fingerprint' && c.status === 'missing'))
}

/**
 * The verification's account of a v1/v2 file that differs from its fingerprint, when
 * the evidence doesn't indicate tampering, or null. The original result stands
 * beside it; this only stops a normal revision being called tampering.
 */
export function legacyDocumentNote(verification) {
  const history = verification?.historical
  return history && !history.tamper_indicated ? history : null
}

// The server's own outcome (procurement/verification.py), in the page's tones.
// There is deliberately no green: a server's account of itself is not proof.
const OUTCOME_TONES = { info: 'pr-chip-info', warn: 'pr-chip-warn', bad: 'pr-chip-bad' }
export const outcomeChip = (verification) => OUTCOME_TONES[verification?.tone] || 'pr-chip-db'

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
  if (legacyDocumentNote(detail.verification)) {
    return { tone: 'warn', title: detail.verification.headline }
  }
  if (payloadNotStored(detail.verification)) {
    return { tone: 'warn', title: 'Missing evidence: this record’s payload was not stored' }
  }
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
    { key: 'time', label: detail.viewer === 'public' ? 'Recorded on-chain on' : 'Recorded on-chain at',
      value: rec.chain_timestamp || null, time: true,
      missing: rec.tx_hash ? 'Known once the server links the on-chain record' : 'Not on the blockchain' },
    { key: 'finality', label: 'Finality', value: fin.value, missing: fin.missing },
    { key: 'log', label: 'Event log index', value: rec.chain_log_index != null ? String(rec.chain_log_index) : null,
      missing: 'Known once the server links the on-chain record' },
  ]
}
