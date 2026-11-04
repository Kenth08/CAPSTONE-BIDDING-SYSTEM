import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hashPayload } from './receipt.js'
import { verifyPacket } from './packetVerify.js'

// ── Python ↔ browser hashing parity, from the shared vector file ────────────
const VECTORS = JSON.parse(readFileSync(new URL('../../../contracts/payload-hash-vectors.json', import.meta.url)))

test('every backend hash vector is reproduced byte-for-byte in the browser', async () => {
  assert.ok(VECTORS.vectors.length >= 6)
  for (const v of VECTORS.vectors) {
    assert.equal(await hashPayload(v.payload), v.data_hash, v.name)
  }
})

test('numbers JavaScript cannot represent exactly are refused, not mis-hashed', async () => {
  await assert.rejects(hashPayload({ n: 2 ** 53 }), /too large/)
  await assert.rejects(hashPayload({ n: 1.5 }), /only integers/)
})

// ── A synthetic record + a fake ledger that holds it ────────────────────────
const CONTRACT = '0x0c832739F61dCCb644e21799b1432842572EdcF5'
const TRUSTED = { chainId: 11155111, contract: CONTRACT }
const DOC = '0x' + 'ab'.repeat(32)
const TX = '0x' + 'cd'.repeat(32)
const SIGNER = '0x' + '11'.repeat(20)
const TIME = 1762000000

const PAYLOAD = {
  v: 2, entity: 'PROJECT', stage: 'BIDDING_OPEN', code: 'PC-7K4M-Q9XT-3HWD', name: 'Pañuelo supplies',
  category: 'office_supplies', type: 'goods', budget: '250000.00', bidding_period_days: 14,
  delivery_period_days: 30, created_at: '2026-11-03T08:15:00+00:00', document_hash: DOC,
}
const DATA_HASH = await hashPayload(PAYLOAD)

function makePacket(over = {}) {
  const base = {
    packet_version: 1,
    anchor: { id: 41, entity_type: 'PROJECT', entity_ref: PAYLOAD.code, stage: 'BIDDING_OPEN' },
    payload: structuredClone(PAYLOAD),
    payload_version: 2,
    data_hash: DATA_HASH,
    document_hash: DOC,
    expected: { network: 'sepolia', chain_id: 11155111, contract: CONTRACT },
    recorded: {
      tx_hash: TX, actor_address: SIGNER, verified_by_server: true, chain_anchor_id: 18, chain_id: 11155111,
      chain_contract: CONTRACT, chain_timestamp: new Date(TIME * 1000).toISOString(),
    },
  }
  return { ...base, ...over }
}

const ROW = { entityType: 'PROJECT', entityRef: PAYLOAD.code, stage: 'BIDDING_OPEN', dataHash: DATA_HASH, actor: SIGNER, timestamp: TIME }

function makeReader({ chainId = '0xaa36a7', rows = { 18: ROW }, receipt, fail = {} } = {}) {
  const boom = () => { throw new Error('rpc unavailable') }
  return {
    chainId: async () => (fail.chainId ? boom() : chainId),
    getAnchor: async (id) => (fail.getAnchor ? boom() : rows[id] ?? null),
    findAnchors: async () => (fail.find ? boom() : Object.entries(rows).map(([id, r]) => ({ id: Number(id), ...r }))),
    getReceipt: async () => (fail.receipt ? boom()
      : receipt === undefined ? { status: 1, events: [{ id: 18, ...ROW }] } : receipt),
  }
}

const run = (packet, { fileHash = DOC, reader = makeReader(), trusted = TRUSTED } = {}) =>
  verifyPacket(packet, { fileHash, trusted, reader })
const statusOf = (r, key) => r.checks.find((c) => c.key === key).status

test('valid document + valid packet + matching ledger → VERIFIED — MATCH', async () => {
  const r = await run(makePacket())
  assert.equal(r.outcome, 'verified')
  assert.equal(r.label, 'VERIFIED — MATCH')
  assert.equal(r.documentChecked, true)
  assert.ok(r.checks.every((c) => c.status === 'pass'), JSON.stringify(r.checks, null, 1))
})

test('without a file only the record is verified, and it says so', async () => {
  const r = await run(makePacket(), { fileHash: null })
  assert.equal(r.outcome, 'verified')
  assert.equal(r.documentChecked, false)
  assert.equal(statusOf(r, 'document'), 'skip')
})

test('an altered document → HASH MISMATCH, decided before touching the chain', async () => {
  let asked = false
  const reader = { ...makeReader(), chainId: async () => { asked = true; return '0xaa36a7' } }
  const r = await run(makePacket(), { fileHash: '0x' + 'ee'.repeat(32), reader })
  assert.equal(r.outcome, 'hash_mismatch')
  assert.equal(statusOf(r, 'document'), 'fail')
  assert.equal(asked, false)
})

test('a payload edited after fingerprinting → HASH MISMATCH', async () => {
  const p = makePacket()
  p.payload.budget = '999999.00'
  p.payload.document_hash = DOC
  const r = await run(p)
  assert.equal(r.outcome, 'hash_mismatch')
  assert.equal(statusOf(r, 'payload'), 'fail')
})

test('a packet whose payload AND data_hash were rewritten is caught by the ledger', async () => {
  const forged = { ...PAYLOAD, budget: '1.00' }
  const r = await run(makePacket({ payload: forged, data_hash: await hashPayload(forged) }))
  assert.equal(r.outcome, 'hash_mismatch')
  assert.equal(statusOf(r, 'onchain'), 'fail')
})

test('a wrong or unknown anchor id → RECORD NOT FOUND', async () => {
  const unknown = await run(makePacket({ recorded: { ...makePacket().recorded, chain_anchor_id: 99 } }))
  assert.equal(unknown.outcome, 'not_found')
  const other = { ...ROW, stage: 'SUBMITTED' }
  const elsewhere = await run(makePacket(), { reader: makeReader({ rows: { 18: other } }) })
  assert.equal(elsewhere.outcome, 'not_found')
  assert.equal(statusOf(elsewhere, 'onchain'), 'fail')
})

test('a record pointing at another contract or network → INVALID TRANSACTION', async () => {
  const cases = [
    makePacket({ expected: { network: 'sepolia', chain_id: 11155111, contract: '0x' + '99'.repeat(20) } }),
    makePacket({ expected: { network: 'mainnet', chain_id: 1, contract: CONTRACT } }),
    makePacket({ recorded: { ...makePacket().recorded, chain_contract: '0x' + '99'.repeat(20) } }),
    makePacket({ recorded: { ...makePacket().recorded, chain_id: 17000 } }),
  ]
  for (const p of cases) {
    const r = await run(p)
    assert.equal(r.outcome, 'invalid_tx')
    assert.equal(statusOf(r, 'contract'), 'fail')
  }
})

test('a node on the wrong network → UNCONFIRMED (cannot check), not a pass', async () => {
  const r = await run(makePacket(), { reader: makeReader({ chainId: '0x1' }) })
  assert.equal(r.outcome, 'unconfirmed')
  assert.equal(statusOf(r, 'network'), 'fail')
})

test('this app without a configured contract → UNCONFIRMED', async () => {
  const r = await run(makePacket(), { trusted: { chainId: 11155111, contract: '' } })
  assert.equal(r.outcome, 'unconfirmed')
})

test('missing or malformed packet fields → UNCONFIRMED', async () => {
  const broken = [
    null,
    makePacket({ payload: null }),
    makePacket({ payload: [] }),
    makePacket({ data_hash: '0x1234' }),
    makePacket({ anchor: { id: 41 } }),
    makePacket({ expected: undefined }),
    makePacket({ recorded: undefined }),
  ]
  for (const p of broken) {
    const r = await run(p)
    assert.equal(r.outcome, 'unconfirmed')
    assert.equal(statusOf(r, 'packet'), 'fail')
  }
})

test('a payload filed under a different stage or code → INVALID TRANSACTION', async () => {
  for (const anchor of [
    { id: 41, entity_type: 'PROJECT', entity_ref: PAYLOAD.code, stage: 'HEAD_APPROVED' },
    { id: 41, entity_type: 'PROJECT', entity_ref: 'PC-OTHR-OTHR-OTHR', stage: 'BIDDING_OPEN' },
    { id: 41, entity_type: 'AWARD', entity_ref: PAYLOAD.code, stage: 'BIDDING_OPEN' },
  ]) {
    const r = await run(makePacket({ anchor }))
    assert.equal(r.outcome, 'invalid_tx')
    assert.equal(statusOf(r, 'binding'), 'fail')
  }
})

test('a wrong signer or timestamp → INVALID TRANSACTION', async () => {
  const signer = await run(makePacket({ recorded: { ...makePacket().recorded, actor_address: '0x' + '22'.repeat(20) } }))
  assert.equal(signer.outcome, 'invalid_tx')
  const time = await run(makePacket(), { reader: makeReader({ rows: { 18: { ...ROW, timestamp: TIME + 60 } } }) })
  assert.equal(time.outcome, 'invalid_tx')
  assert.equal(statusOf(time, 'signer'), 'fail')
})

test('a failed transaction, or one that did not record this entry → INVALID TRANSACTION', async () => {
  const failed = await run(makePacket(), { reader: makeReader({ receipt: { status: 0, events: [] } }) })
  assert.equal(failed.outcome, 'invalid_tx')
  const other = await run(makePacket(), { reader: makeReader({ receipt: { status: 1, events: [{ id: 5 }] } }) })
  assert.equal(other.outcome, 'invalid_tx')
})

test('RPC unavailable or contract read failure → UNCONFIRMED', async () => {
  for (const fail of [{ chainId: true }, { getAnchor: true }]) {
    const r = await run(makePacket(), { reader: makeReader({ fail }) })
    assert.equal(r.outcome, 'unconfirmed', JSON.stringify(fail))
  }
})

test('a receipt the node has pruned is skipped, not failed: ledger state is the evidence', async () => {
  for (const reader of [makeReader({ receipt: null }), makeReader({ fail: { receipt: true } })]) {
    const r = await run(makePacket(), { reader })
    assert.equal(r.outcome, 'verified')
    assert.equal(statusOf(r, 'transaction'), 'skip')
  }
})

test('a historical record with no stored on-chain id is found by searching the ledger', async () => {
  const recorded = { tx_hash: TX, actor_address: '', chain_anchor_id: null, chain_id: null, chain_contract: '' }
  const r = await run(makePacket({ recorded }), { reader: makeReader({ receipt: null }) })
  assert.equal(r.outcome, 'verified')
  assert.equal(r.locatedBy, 'search')
  assert.equal(r.onChainId, 18)
  const absent = await run(makePacket({ recorded }), { reader: makeReader({ rows: {} }) })
  assert.equal(absent.outcome, 'not_found')
})

test('legacy v1 payloads verify exactly as stored', async () => {
  const v1 = VECTORS.vectors.find((v) => v.payload.v === 1)
  const p = v1.payload
  const row = { entityType: 'PROJECT', entityRef: p.code, stage: p.stage, dataHash: v1.data_hash, actor: SIGNER, timestamp: TIME }
  const packet = makePacket({
    anchor: { id: 3, entity_type: 'PROJECT', entity_ref: p.code, stage: p.stage },
    payload: p, payload_version: 1, data_hash: v1.data_hash,
  })
  const r = await run(packet, { fileHash: p.document_hash, reader: makeReader({ rows: { 18: row }, receipt: null }) })
  assert.equal(r.outcome, 'verified')
})

test('a record with no document cannot be used to verify a file', async () => {
  const noDoc = { ...PAYLOAD, document_hash: '' }
  const r = await run(makePacket({ payload: noDoc, data_hash: await hashPayload(noDoc) }))
  assert.equal(r.outcome, 'unconfirmed')
  assert.equal(statusOf(r, 'document'), 'fail')
})

test('a reported, unconfirmed signer is not compared (smart-account wallets)', async () => {
  // MetaMask posted the user's address; the ledger saw the batch executor.
  const recorded = { ...makePacket().recorded, verified_by_server: false, actor_address: '0x' + '22'.repeat(20),
    chain_timestamp: null }
  const r = await run(makePacket({ recorded }))
  assert.equal(r.outcome, 'verified')
  assert.match(r.checks.find((c) => c.key === 'signer').detail, /no server-confirmed signer/)
})
