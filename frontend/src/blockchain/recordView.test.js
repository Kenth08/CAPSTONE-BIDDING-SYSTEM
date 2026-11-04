import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVIDENCE, addressLink, chainRows, evidenceBanner, finalityText, txLink, versionLabel } from './recordView.js'

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
