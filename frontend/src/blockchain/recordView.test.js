import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ANCHOR_STATES, anchorChip, hasIncompleteEvidence } from './anchorState.js'
import {
  EVIDENCE, addressLink, chainRows, evidenceBanner, finalityText, legacyDocumentNote, outcomeChip, payloadNotStored,
  publicDate, recordTime, txLink, verifiedRowDisplay, versionLabel,
} from './recordView.js'

const TX = '0x422d4e215b6be96f775e5a8dee4ddbb59fa4a0dea817d17bfd1593680bec67a4'
const LEDGER = '0x0c832739F61dCCb644e21799b1432842572EdcF5'

const detail = (record) => ({
  network: { name: 'Sepolia', chain_id: 11155111, contract: LEDGER },
  record: {
    tx_hash: '', block_number: null, actor_address: '', chain_anchor_id: null, chain_timestamp: null,
    chain_log_index: null, chain_confirmations: null, chain_finalized: false, verified_on_chain: false, ...record,
  },
})
const row = (rows, key) => rows.find((r) => r.key === key)

test('links are built only from values with the exact shape of a tx hash or address', () => {
  assert.equal(txLink(TX), `https://sepolia.etherscan.io/tx/${TX}`)
  for (const bad of ['', null, undefined, '0x123', 'pending', `${TX}00`, 'javascript:alert(1)']) {
    assert.equal(txLink(bad), '', String(bad))
  }
  assert.equal(addressLink(LEDGER), `https://sepolia.etherscan.io/address/${LEDGER}`)
  assert.equal(addressLink('0xnope'), '')
})

test('a database-only record shows every chain field as missing, with a reason', () => {
  const rows = chainRows(detail({}))
  for (const key of ['onchain_id', 'tx', 'block', 'signer', 'time', 'finality', 'log']) {
    assert.equal(row(rows, key).value, null, key)
    assert.ok(row(rows, key).missing, key)
    assert.ok(!row(rows, key).href, key)
  }
  assert.match(row(rows, 'onchain_id').missing, /nothing has been written/)
  assert.equal(row(rows, 'contract').value, LEDGER)
})

test('a reported but unconfirmed record labels its block and signer as claims', () => {
  const rows = chainRows(detail({ tx_hash: TX, block_number: 9, actor_address: '0x' + '11'.repeat(20) }))
  assert.equal(row(rows, 'tx').href, `https://sepolia.etherscan.io/tx/${TX}`)
  assert.match(row(rows, 'block').label, /reported, unconfirmed/)
  assert.match(row(rows, 'signer').label, /reported, unconfirmed/)
  assert.match(row(rows, 'onchain_id').missing, /Not linked yet/)
})

test('a confirmed, linked record shows its on-chain identity', () => {
  const rows = chainRows(detail({
    tx_hash: TX, block_number: 12053889, actor_address: '0x0d04d9835CbFc1E610C269DeB3F943670C72426b',
    chain_anchor_id: 18, chain_timestamp: '2026-11-03T07:45:24Z', chain_log_index: 237,
    chain_confirmations: 2124, chain_finalized: true, verified_on_chain: true,
  }))
  assert.equal(row(rows, 'onchain_id').value, '#18 (getAnchor(18))')
  assert.equal(row(rows, 'block').label, 'Block')
  assert.equal(row(rows, 'log').value, '237')
  assert.match(row(rows, 'finality').value, /^Final/)
})

test('finality is never claimed without the server establishing it', () => {
  assert.equal(finalityText({ verified_on_chain: false, chain_finalized: true }).value, null)
  assert.match(finalityText({ verified_on_chain: true, chain_finalized: false, chain_confirmations: 3 }).value,
    /3 confirmations — not yet shown to be final/)
  assert.equal(finalityText({ verified_on_chain: true, chain_finalized: false, chain_confirmations: null }).value, null)
})

test('a missing contract is shown as missing, not as an empty link', () => {
  const d = detail({})
  d.network.contract = ''
  const r = row(chainRows(d), 'contract')
  assert.equal(r.value, null)
  assert.equal(r.href, '')
})

test('version labels say which issue and whether it is current', () => {
  assert.equal(versionLabel({ number: 2, total: 2, current: true }), 'Issue 2 of 2 — Current')
  assert.equal(versionLabel({ number: 1, total: 2, current: false }), 'Issue 1 of 2 — Superseded')
  assert.equal(versionLabel(null), 'No document version')
})

test('no server-side state is ever shown in the success (green) tone', () => {
  for (const [state, ev] of Object.entries(EVIDENCE)) assert.notEqual(ev.tone, 'ok', state)
  for (const evidence of ['verified', 'reported', 'mismatch', 'database']) {
    for (const status of ['match', 'mismatch', 'superseded', 'unavailable', undefined]) {
      assert.notEqual(evidenceBanner({ evidence, integrity: { status } }).tone, 'ok')
    }
  }
})

test('altered data overrides a server confirmation', () => {
  const b = evidenceBanner({ evidence: 'verified', integrity: { status: 'mismatch' } })
  assert.equal(b.tone, 'bad')
  assert.match(b.title, /no longer matches/)
  assert.equal(evidenceBanner({ evidence: 'verified', integrity: { status: 'match' } }).title,
    'Confirmed on-chain by the server')
})

// ── Public times are dates (Stage 5 Phase 4) ────────────────────────────────
const TIME_OF_DAY = /\d{1,2}:\d{2}|\b[AP]M\b/

test('publicDate shows the Philippine date and no time, from any input', () => {
  // 16:30 UTC is already the next day in Manila.
  assert.equal(publicDate('2026-11-03T16:30:45.123456Z'), 'Nov 4, 2026')
  assert.equal(publicDate(Date.UTC(2026, 10, 3, 16, 30, 45)), 'Nov 4, 2026')
  // A bare date from the API is a calendar day: it never moves across a zone.
  assert.equal(publicDate('2026-11-04'), 'Nov 4, 2026')
  for (const value of ['2026-11-03T16:30:45Z', 1793723445000, '2026-11-04']) {
    assert.doesNotMatch(publicDate(value), TIME_OF_DAY)
  }
  for (const missing of [null, undefined, '', 'not a date']) assert.equal(publicDate(missing), '—')
})

test('the record page gives the public a date and signed-in viewers the exact time', () => {
  const value = '2026-11-03T16:30:45Z'
  assert.doesNotMatch(recordTime('public', value), TIME_OF_DAY)
  for (const viewer of ['admin', 'head', 'supplier']) assert.match(recordTime(viewer, value), TIME_OF_DAY)
})

test('the chain time row does not say "at" to the public', () => {
  const rows = (viewer) => chainRows({ ...detail({ chain_timestamp: '2026-11-04' }), viewer })
  assert.equal(row(rows('public'), 'time').label, 'Recorded on-chain on')
  assert.equal(row(rows('admin'), 'time').label, 'Recorded on-chain at')
})

test('public pages have no way left to format a time of day', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
  // A bare award date through fmtDate is a UTC instant: west of UTC it shows the day before.
  for (const page of ['PublicProcurementPage', 'PublicResultsPage', 'LandingPage']) {
    const source = read(`../pages/${page}.jsx`)
    assert.doesNotMatch(source, /fmtDate\([^)]*awarded_at/, page)
    assert.match(source, /publicDate\([^)]*awarded_at/, page)
  }
  const verifier = read('../components/PublicVerifier.jsx')
  assert.doesNotMatch(verifier, /timeStyle|fmtDateTime|toLocaleString|toLocaleTimeString/)
  const detailPage = read('../components/AnchorDetail.jsx')
  assert.doesNotMatch(detailPage, /fmtDateTime|toLocaleString|toLocaleTimeString|timeStyle/)
  assert.match(detailPage, /recordTime\(detail\.viewer, rec\.created_at\)/)
  assert.match(detailPage, /recordTime\(detail\.viewer, v\.issued_at\)/)
})

// ── Green is earned (design section 6.1) ────────────────────────────────────

test('a trail row is never green, and claims only what it knows', () => {
  assert.equal(verifiedRowDisplay({ status: 'complete' }).text, 'Found on the ledger · all five documents recorded')
  assert.equal(verifiedRowDisplay({ status: 'complete' }).cls, 'pv-extra')
  for (const c of [{ status: 'complete' }, { status: 'incomplete', label: 'x' }, { status: 'not_recorded' }, null]) {
    assert.doesNotMatch(verifiedRowDisplay(c).text, /verified/i)
  }
  assert.equal(verifiedRowDisplay({ status: 'incomplete', label: 'INCOMPLETE: 4 of 5 present' }).cls, 'pv-pending')
  assert.match(verifiedRowDisplay({ status: 'incomplete', label: 'INCOMPLETE: 4 of 5 present' }).text, /4 of 5/)
  assert.equal(verifiedRowDisplay({ status: 'unreadable_when_recorded', label: 'x' }).cls, 'pv-pending')
  assert.equal(verifiedRowDisplay({ status: 'not_recorded' }).cls, 'pv-extra')
  assert.match(verifiedRowDisplay({ status: 'not_recorded' }).text, /legacy record/)
  for (const other of [{ status: 'not_applicable' }, { status: 'unknown' }, null]) {
    assert.notEqual(verifiedRowDisplay(other).cls, 'pv-ok')
  }
})

test('a server confirmation is blue everywhere, whatever the record holds', () => {
  assert.equal(ANCHOR_STATES.verified.tone, 'info')
  assert.equal(ANCHOR_STATES.verified.text, 'Confirmed on-chain')
  for (const state of Object.values(ANCHOR_STATES)) assert.notEqual(state.tone, 'success')
  const confirmed = { tx_hash: '0xab', chain_status: 'confirmed', verified_on_chain: true }
  assert.equal(anchorChip({ ...confirmed, completeness: { status: 'complete' } }).tone, 'info')
  assert.match(anchorChip({ ...confirmed, completeness: { status: 'not_recorded' } }).text, /legacy record/)
  assert.equal(anchorChip({ ...confirmed, completeness: { status: 'not_recorded' } }).tone, 'info')
})

test('a confirmed transaction does not make incomplete evidence look finished', () => {
  const a = { tx_hash: '0xab', chain_status: 'confirmed', verified_on_chain: true,
    completeness: { status: 'incomplete', present: 4, total: 5, absent: ['terms_of_reference'], unreadable: [] } }
  assert.equal(hasIncompleteEvidence(a), true)
  const chip = anchorChip(a)
  assert.equal(chip.tone, 'warning')
  assert.equal(chip.text, 'Confirmed on-chain · incomplete evidence (4 of 5)')
  assert.match(chip.title, /^MATCH — INCOMPLETE EVIDENCE .*Terms of Reference/)
})

test('a transaction hash alone is only reported, whatever the record holds', () => {
  const chip = anchorChip({ tx_hash: '0xab', chain_status: 'unchecked', completeness: { status: 'complete' } })
  assert.equal(chip.state, 'reported')
  assert.equal(chip.text, 'Transaction reported')
})

test('a normal v1/v2 revision is not called altered; kept bytes that changed still are', () => {
  const revised = { verification: { headline: 'Mismatch — later revision',
    historical: { kind: 'later_revision', tamper_indicated: false } }, integrity: { status: 'mismatch' }, evidence: 'verified' }
  assert.ok(legacyDocumentNote(revised.verification))
  assert.equal(evidenceBanner(revised).tone, 'warn')
  assert.doesNotMatch(evidenceBanner(revised).title, /no longer matches/)
  const tampered = { verification: { historical: { kind: 'kept_version_differs', tamper_indicated: true } },
    integrity: { status: 'mismatch' }, evidence: 'verified' }
  assert.equal(legacyDocumentNote(tampered.verification), null)
  assert.equal(evidenceBanner(tampered).tone, 'bad')
  assert.equal(legacyDocumentNote({ historical: null }), null)
})

test('a record with no stored payload is missing evidence, never called altered', () => {
  const verification = { outcome: 'not_found', checked: [{ key: 'fingerprint', status: 'missing' }] }
  assert.equal(payloadNotStored(verification), true)
  const banner = evidenceBanner({ verification, integrity: { status: 'mismatch' }, evidence: 'database' })
  assert.equal(banner.tone, 'warn')
  assert.match(banner.title, /Missing evidence/)
  assert.doesNotMatch(banner.title, /no longer matches/)
  // A real mismatch, and missing evidence of another kind, are not this.
  assert.equal(payloadNotStored({ outcome: 'hash_mismatch', checked: [{ key: 'fingerprint', status: 'fail' }] }), false)
  assert.equal(payloadNotStored({ outcome: 'not_found', checked: [{ key: 'fingerprint', status: 'pass' }] }), false)
  assert.equal(payloadNotStored(null), false)
})

test('no status text claims Verified next to incomplete evidence', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
  for (const file of ['./payloadV3.js', './packetVerify.js', './recordView.js', './anchorState.js',
    '../components/PacketCheck.jsx', '../components/PublicVerifier.jsx', '../components/AnchorDetail.jsx',
    '../components/BlockchainTrail.jsx']) {
    assert.doesNotMatch(read(file), /\bCOMPLETE EVIDENCE/, file)
    assert.doesNotMatch(read(file), /VERIFIED — MATCH ·? ?INCOMPLETE|VERIFIED[^'`\n]*INCOMPLETE/, file)
  }
})

test('the only green status classes are on the full check', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
  for (const file of ['../components/BlockchainTrail.jsx', '../components/ProcurementRecord.jsx',
    '../components/AnchorDetail.jsx', '../components/PublicVerifier.jsx', '../pages/admin/AdminHome.jsx']) {
    const source = read(file)
    assert.doesNotMatch(source, /pv-ok|pr-chip-ok|pr-chip-\$\{st\}/, file)
    if (!file.includes('PublicVerifier')) assert.doesNotMatch(source, /Verified on[- ]/, file)
  }
  assert.doesNotMatch(read('../components/Blockchain.css'), /bc-badge-anchored \{[^}]*tone-success/)
  assert.doesNotMatch(read('../style/ui.css'), /bc-badge-anchored \{[^}]*tone-success/)
})

test('the server outcome never has a green chip', () => {
  for (const tone of ['info', 'warn', 'bad', 'unknown']) assert.notEqual(outcomeChip({ tone }), 'pr-chip-ok')
  assert.equal(outcomeChip({ tone: 'bad' }), 'pr-chip-bad')
})
