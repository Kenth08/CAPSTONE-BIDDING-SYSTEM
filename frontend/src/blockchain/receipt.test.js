import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJson, hashPayload, verifyReceipt } from './receipt.js'

// Reference values computed with the BACKEND's blockchain.hash_payload
// (Python json.dumps sort_keys + compact separators + SHA-256). If these ever
// disagree, a bidder's browser would reject an honest receipt.
const LEAF = {
  bid_id: 7, supplier_id: 3, amount: '43333.00', submitted_at: '2026-11-03T08:15:00+00:00',
  document_hash: '0x' + 'ab'.repeat(32), status: 'qualified', salt: 'f'.repeat(64),
}
const LEAF_HASH = '0xa5f6d86ca56b4a3c49664060613d74eb78a4b4612b088c530d07974d1d50be0d'
const PAYLOAD = {
  v: 2, entity: 'PROJECT', stage: 'EVALUATION_COMPLETED', code: 'PC-7K4M-Q9XT-3HWD',
  bid_count: 2, leaves: [LEAF_HASH, '0x' + 'cd'.repeat(32)],
}
const PAYLOAD_HASH = '0x0034174b11ed1a4f0146dba9290fb77e51659b1525329c342fafbd9cb7cc35b9'

test('hashes exactly like the backend', async () => {
  assert.equal(await hashPayload(LEAF), LEAF_HASH)
  assert.equal(await hashPayload(PAYLOAD), PAYLOAD_HASH)
})

test('non-ASCII is escaped the way Python json.dumps does', async () => {
  assert.equal(canonicalJson({ n: 1, name: 'ñ' }), '{"n":1,"name":"\\u00f1"}')
  assert.equal(await hashPayload({ name: 'Kagamitang Pang-opisina — ñ', n: 1 }),
    '0x88ee772e397f5d3aba9796331d845435a7365bde6418df1a63823b34e6ed15a0')
})

test('a genuine receipt verifies; a tampered one does not', async () => {
  const receipt = { leaf_fields: LEAF, leaf: LEAF_HASH, payload: PAYLOAD, anchor: { data_hash: PAYLOAD_HASH } }
  assert.deepEqual(
    (({ leafOk, included, commitmentOk }) => ({ leafOk, included, commitmentOk }))(await verifyReceipt(receipt)),
    { leafOk: true, included: true, commitmentOk: true })

  const repriced = { ...receipt, leaf_fields: { ...LEAF, amount: '40000.00' } }
  const r = await verifyReceipt(repriced)
  assert.equal(r.leafOk, false)
  assert.equal(r.included, false)
})
