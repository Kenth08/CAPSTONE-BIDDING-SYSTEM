import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { documentVerdict, findDocumentMatch } from './documentCheck.js'
import {
  checkOpening, completenessOf, incompleteLabel, matchManifest, passedDisplay, payloadProblem, versionProblem,
} from './payloadV3.js'
import { isCurrentCheck, verifyPacket } from './packetVerify.js'
import { hashPayload } from './receipt.js'

const VECTORS = JSON.parse(readFileSync(new URL('../../../contracts/payload-hash-vectors.json', import.meta.url)))
const vector = (prefix) => structuredClone(VECTORS.vectors.find((v) => v.name.startsWith(prefix)))
const ALL_PRESENT = 'project-stage/3, all five documents present'
const TOR_ABSENT = 'project-stage/3, non-ASCII and emoji, Terms of Reference absent'
const UNREADABLE = 'project-stage/3, evidence document unreadable when recorded'

// ── Schema: the shared vectors pass, and each way of breaking one is refused ──

test('every v3 vector the backend validated passes here too', () => {
  for (const prefix of [ALL_PRESENT, TOR_ABSENT, UNREADABLE, 'project-stage/3, Purchase Request at version 3', 'evaluation/3']) {
    assert.equal(payloadProblem(vector(prefix).payload), null, prefix)
  }
})

test('a project-stage/3 payload outside its schema is refused', () => {
  const changes = {
    'extra key': (p) => { p.extra = 'x' },
    'missing key': (p) => { delete p.category },
    null: (p) => { p.category = null },
    boolean: (p) => { p.bidding_period_days = true },
    float: (p) => { p.bidding_period_days = 1.5 },
    'array value': (p) => { p.name = ['x'] },
    'uppercase hash': (p) => { p.documents.purchase_request.sha256 = `0x${'AB'.repeat(32)}` },
    'sixth document': (p) => { p.documents.sixth = { state: 'absent', sha256: '', version: 0 } },
    'missing document': (p) => { delete p.documents.terms_of_reference },
    'unknown state': (p) => { p.documents.purchase_request.state = 'lost' },
    'hash on an absent file': (p) => { p.documents.terms_of_reference = { state: 'absent', sha256: `0x${'ab'.repeat(32)}`, version: 0 } },
    'present with no version': (p) => { p.documents.terms_of_reference.version = 0 },
    'wrong evidence key': (p) => { p.document_key = 'terms_of_reference' },
    'repeated hash disagrees': (p) => { p.document_hash = `0x${'00'.repeat(32)}` },
    'not UTC': (p) => { p.created_at = '2026-11-04T08:00:00+08:00' },
    'stage from another object': (p) => { p.stage = 'constructor' },
    'budget without decimals': (p) => { p.budget = '100' },
  }
  for (const [name, change] of Object.entries(changes)) {
    const { payload } = vector(ALL_PRESENT)
    change(payload)
    assert.ok(payloadProblem(payload), name)
  }
})

test('an evaluation/3 payload outside its schema is refused', () => {
  const changes = {
    'wrong count': (p) => { p.bid_count = 9 },
    unsorted: (p) => { p.leaves.reverse() },
    duplicate: (p) => { p.leaves[1] = p.leaves[0] },
    'bad leaf': (p) => { p.leaves[0] = 'x' },
    'not an array': (p) => { p.leaves = 'x' },
    'extra key': (p) => { p.extra = 1 },
    'other stage': (p) => { p.stage = 'AWARDED' },
  }
  for (const [name, change] of Object.entries(changes)) {
    const { payload } = vector('evaluation/3')
    change(payload)
    assert.ok(payloadProblem(payload), name)
  }
})

test('kinds with no reader are refused, and versions are never guessed at', () => {
  for (const kind of ['award-document/3', 'bid-leaf/3', 'award-private/3', 'project-stage/4', undefined]) {
    assert.equal(payloadProblem({ v: 3, kind }), 'unsupported payload kind', String(kind))
  }
  for (const v of [4, 0, '3', 3.5, true, null]) {
    assert.ok(versionProblem({ v }), String(v))
  }
  for (const payload of [{}, { v: 1 }, { v: 2 }, { v: 3 }]) {
    assert.equal(versionProblem(payload), null)
  }
})

// ── Completeness ─────────────────────────────────────────────────────────────

test('completeness follows design section 6.1', () => {
  assert.equal(completenessOf(vector(ALL_PRESENT).payload).status, 'complete')
  const absent = completenessOf(vector(TOR_ABSENT).payload)
  assert.equal(absent.label, 'INCOMPLETE: 4 of 5 present')
  assert.deepEqual(absent.absent, ['terms_of_reference'])
  assert.equal(completenessOf(vector(UNREADABLE).payload).label, 'INCOMPLETE: UNREADABLE WHEN RECORDED')
  assert.equal(completenessOf(vector('evaluation/3').payload).status, 'not_applicable')
  assert.equal(completenessOf({ v: 2 }).status, 'not_recorded')
  assert.equal(completenessOf({ stage: 'SUBMITTED' }).status, 'not_recorded')
  assert.equal(completenessOf({ v: 4 }).status, 'unknown')
})

test('unreadable takes precedence over absent', () => {
  const { payload } = vector(TOR_ABSENT)
  payload.documents.purchase_request = { state: 'unreadable', sha256: '', version: 1 }
  payload.document_hash = payload.document_key === 'purchase_request' ? '' : payload.document_hash
  const c = completenessOf(payload)
  assert.equal(c.status, 'unreadable_when_recorded')
  assert.deepEqual(c.absent, ['terms_of_reference'])
  assert.deepEqual(c.unreadable, ['purchase_request'])
})

test('green takes complete evidence, a matching file and a transaction read back', () => {
  const complete = completenessOf(vector(ALL_PRESENT).payload)
  const shown = (o) => passedDisplay(complete, o)
  assert.equal(shown().green, false)
  assert.equal(shown().tone, 'legacy')
  assert.equal(shown().label, 'RECORD MATCH — DOCUMENT NOT CHECKED')
  assert.equal(shown({ documentChecked: true }).green, false)
  assert.equal(shown({ transactionChecked: true }).green, false)
  const all = shown({ documentChecked: true, transactionChecked: true,
    documentMatch: { label: 'Terms of Reference (TOR)', version: 2 } })
  assert.equal(all.green, true)
  assert.equal(all.tone, 'ok')
  assert.equal(all.label, 'SELECTED DOCUMENT VERIFIED — RECORD CHECKS COMPLETE')
  assert.match(all.note, /Terms of Reference \(TOR\), version 2 was checked/)
  assert.match(all.note, /other four documents were not individually checked/)
  for (const status of ['incomplete', 'unreadable_when_recorded', 'not_recorded', 'not_applicable', 'unknown']) {
    const c = { status, present: 4, total: 5, absent: [], unreadable: [] }
    assert.equal(passedDisplay(c, { documentChecked: true, transactionChecked: true }).green, false, status)
  }
})

test('incomplete is amber and legacy is blue', () => {
  const amber = passedDisplay(completenessOf(vector(TOR_ABSENT).payload))
  assert.equal(amber.tone, 'amber')
  assert.equal(amber.outcome, 'unconfirmed')
  assert.equal(amber.label, 'MATCH — INCOMPLETE EVIDENCE (4 of 5 present; missing: Terms of Reference (TOR))')
  assert.doesNotMatch(amber.label, /VERIFIED/i)
  assert.match(amber.note, /The fingerprint is genuine; it records that these documents were missing when this step was taken/)
  assert.match(amber.note, /Terms of Reference/)
  const legacy = passedDisplay(completenessOf({ v: 2 }))
  assert.equal(legacy.tone, 'legacy')
  assert.equal(legacy.label, 'VERIFIED — LEGACY RECORD (v1 or v2)')
  assert.match(legacy.note, /five-document completeness was not checked/)
  assert.notEqual(passedDisplay(completenessOf(vector('evaluation/3').payload)).tone, 'ok')
})

// ── The whole check, against a fake ledger ───────────────────────────────────

const CONTRACT = '0x0c832739F61dCCb644e21799b1432842572EdcF5'
const TRUSTED = { chainId: 11155111, contract: CONTRACT }
const SIGNER = `0x${'11'.repeat(20)}`
const TX = `0x${'cd'.repeat(32)}`
const TIME = 1762000000

async function setup(payload, over = {}) {
  const dataHash = await hashPayload(payload)
  const entityType = payload.entity || 'PROJECT'
  const row = { entityType, entityRef: payload.code, stage: payload.stage, dataHash, actor: SIGNER, timestamp: TIME }
  const packet = {
    packet_version: 1,
    anchor: { id: 41, entity_type: entityType, entity_ref: payload.code, stage: payload.stage },
    payload,
    payload_version: payload.v,
    data_hash: dataHash,
    expected: { network: 'sepolia', chain_id: 11155111, contract: CONTRACT },
    recorded: {
      tx_hash: TX, actor_address: SIGNER, verified_by_server: true, chain_anchor_id: 18, chain_id: 11155111,
      chain_contract: CONTRACT, chain_timestamp: new Date(TIME * 1000).toISOString(),
    },
    ...over,
  }
  const reader = {
    chainId: async () => '0xaa36a7',
    getAnchor: async (id) => (id === 18 ? row : null),
    findAnchors: async () => [{ id: 18, ...row }],
    getReceipt: async () => ({ status: 1, events: [{ id: 18, ...row }] }),
  }
  return { packet, reader }
}
const run = async (payload, { fileHash = null, packetOver = {} } = {}) => {
  const { packet, reader } = await setup(payload, packetOver)
  return verifyPacket(packet, { fileHash, trusted: TRUSTED, reader })
}

test('complete record, no document selected: every record check passes and it is not green', async () => {
  const r = await run(vector(ALL_PRESENT).payload)
  assert.equal(r.outcome, 'verified')
  assert.equal(r.green, false)
  assert.equal(r.documentChecked, false)
  assert.equal(r.display.tone, 'legacy')
  assert.equal(r.display.label, 'RECORD MATCH — DOCUMENT NOT CHECKED')
  assert.ok(r.checks.filter((c) => c.key !== 'document').every((c) => c.status === 'pass'))
})

test('complete record, matching selected document: green, and it says exactly what was checked', async () => {
  const { payload } = vector(ALL_PRESENT)
  const r = await run(payload, { fileHash: payload.documents.purchase_request.sha256 })
  assert.equal(r.green, true)
  assert.equal(r.display.tone, 'ok')
  assert.equal(r.display.label, 'SELECTED DOCUMENT VERIFIED — RECORD CHECKS COMPLETE')
  assert.match(r.display.note, /other four documents were not individually checked/)
  assert.doesNotMatch(r.display.label, /ALL|FIVE|COMPLETE EVIDENCE/)
  assert.equal(r.checkedFileHash, payload.documents.purchase_request.sha256)
})

test('complete record, mismatching selected document: a mismatch, not an accusation', async () => {
  const r = await run(vector(ALL_PRESENT).payload, { fileHash: `0x${'77'.repeat(32)}` })
  assert.equal(r.outcome, 'hash_mismatch')
  assert.equal(r.green, false)
  assert.equal(r.display.tone, 'bad')
  assert.match(r.display.note, /does not by itself show why/)
  for (const text of [r.display.label, r.display.note, ...r.checks.map((c) => c.detail)]) {
    assert.doesNotMatch(text, /tamper|forge|fraud/i)
  }
})

test('incomplete manifest, even with a matching selected document: amber, not green', async () => {
  const { payload } = vector(TOR_ABSENT)
  const r = await run(payload, { fileHash: payload.documents.purchase_request.sha256 })
  assert.equal(r.documentChecked, true)
  assert.equal(r.green, false)
  assert.equal(r.outcome, 'unconfirmed')
  assert.equal(r.display.tone, 'amber')
  assert.match(r.display.label, /^MATCH — INCOMPLETE EVIDENCE/)
})

test('invalid transaction, even with a matching document: not green, and not a mismatch', async () => {
  const { payload } = vector(ALL_PRESENT)
  const { packet, reader } = await setup(payload)
  const r = await verifyPacket(packet, {
    fileHash: payload.documents.purchase_request.sha256,
    trusted: TRUSTED,
    reader: { ...reader, getReceipt: async () => ({ status: 0, events: [] }) },
  })
  assert.equal(r.documentChecked, true)
  assert.equal(r.outcome, 'invalid_tx')
  assert.equal(r.category, 'Invalid transaction')
  assert.equal(r.green, false)
})

test('a matching document with no transaction to read back is not green', async () => {
  const { payload } = vector(ALL_PRESENT)
  const fileHash = payload.documents.purchase_request.sha256
  const { packet, reader } = await setup(payload)
  const pruned = await verifyPacket(packet, { fileHash, trusted: TRUSTED, reader: { ...reader, getReceipt: async () => null } })
  assert.equal(pruned.outcome, 'unconfirmed')   // skipped is not failed, and not a success
  assert.equal(pruned.category, 'Unavailable or incomplete evidence')
  assert.equal(pruned.integrity, 'match')
  assert.equal(pruned.green, false)
  assert.equal(pruned.display.tone, 'legacy')
  assert.equal(pruned.display.label, 'RECORD AND SELECTED DOCUMENT MATCH — TRANSACTION NOT CHECKED')
  assert.equal(pruned.label, pruned.display.label)
  assert.equal(pruned.checks.find((c) => c.key === 'transaction').status, 'skip')
  packet.recorded.tx_hash = ''
  const unreported = await verifyPacket(packet, { fileHash, trusted: TRUSTED, reader })
  assert.equal(unreported.outcome, 'unconfirmed')
  assert.equal(unreported.green, false)
  assert.equal(unreported.display.tone, 'legacy')
})

test('with no file either, a skipped transaction is unconfirmed under the same blue label', async () => {
  const { packet, reader } = await setup(vector(ALL_PRESENT).payload)
  const pruned = await verifyPacket(packet, { trusted: TRUSTED, reader: { ...reader, getReceipt: async () => null } })
  assert.equal(pruned.outcome, 'unconfirmed')
  assert.equal(pruned.green, false)
  assert.equal(pruned.display.tone, 'legacy')
  assert.equal(pruned.display.label, 'RECORD MATCH — DOCUMENT NOT CHECKED')
  assert.match(pruned.display.note, /transaction is unconfirmed/)
  packet.recorded.tx_hash = ''
  const unreported = await verifyPacket(packet, { trusted: TRUSTED, reader })
  assert.equal(unreported.outcome, 'unconfirmed')
})

test('a v3 evaluation with a skipped transaction is unconfirmed, and with one read back is verified', async () => {
  const { payload } = vector('evaluation/3')
  const { packet, reader } = await setup(payload)
  const read = await verifyPacket(packet, { trusted: TRUSTED, reader })
  assert.equal(read.outcome, 'verified')
  assert.equal(read.display.label, 'RECORD MATCH — NO DOCUMENT BOUND')
  const pruned = await verifyPacket(packet, { trusted: TRUSTED, reader: { ...reader, getReceipt: async () => null } })
  assert.equal(pruned.outcome, 'unconfirmed')
  assert.equal(pruned.display.label, 'RECORD MATCH — NO DOCUMENT BOUND')
  assert.equal(pruned.display.tone, 'legacy')
})

test('v1 and v2 stay verified with a skipped transaction, exactly as they were', async () => {
  const hash = `0x${'ab'.repeat(32)}`
  for (const v of [1, 2]) {
    const payload = { v, entity: 'PROJECT', stage: 'BIDDING_OPEN', code: 'PC-7K4M-Q9XT-3HWD', name: 'x', category: 'x',
      type: 'x', budget: '1.00', bidding_period_days: 1, delivery_period_days: 1,
      created_at: '2026-11-03T08:15:00+00:00', document_hash: hash }
    const { packet, reader } = await setup(payload)
    const pruned = await verifyPacket(packet, { trusted: TRUSTED, reader: { ...reader, getReceipt: async () => null } })
    assert.deepEqual([pruned.outcome, pruned.label, pruned.green, pruned.display.tone],
      ['verified', 'VERIFIED — MATCH', false, 'legacy'], `v${v} pruned`)
    packet.recorded.tx_hash = ''
    const unreported = await verifyPacket(packet, { trusted: TRUSTED, reader })
    assert.equal(unreported.outcome, 'verified', `v${v} unreported`)
  }
})

// ── Historical versions ─────────────────────────────────────────────────────
const V1_HASH = `0x${'a1'.repeat(32)}`
const V2_HASH = `0x${'a2'.repeat(32)}`

function atVersion(hash, version, stage) {
  const { payload } = vector(ALL_PRESENT)
  payload.documents.purchase_request = { state: 'present', sha256: hash, version }
  payload.stage = stage
  payload.document_key = stage === 'HEAD_APPROVED' ? 'approved_budget_document' : 'purchase_request'
  payload.document_hash = payload.documents[payload.document_key].sha256
  return payload
}

test('a file is checked against the version THIS record bound, not the latest', async () => {
  const earlier = atVersion(V1_HASH, 1, 'SUBMITTED')
  const later = atVersion(V2_HASH, 2, 'HEAD_APPROVED')
  const original = await run(earlier, { fileHash: V1_HASH })
  assert.equal(original.green, true)
  assert.deepEqual([original.documentMatch.key, original.documentMatch.version], ['purchase_request', 1])
  assert.equal((await run(later, { fileHash: V2_HASH })).green, true)
  // The later file against the earlier record, and the earlier against the later.
  assert.equal((await run(earlier, { fileHash: V2_HASH })).outcome, 'hash_mismatch')
  assert.equal((await run(later, { fileHash: V1_HASH })).outcome, 'hash_mismatch')
})

const legacyIssue = (hash) => ({
  v: 2, entity: 'AWARD', stage: 'NOA_ISSUED', code: 'PC-7K4M-Q9XT-3HWD', award_id: 7, bid_id: 9, supplier_id: 3,
  amount: '900.00', status: 'won', awarded_at: '2026-11-04', issued_at: '2026-11-04T01:00:00+00:00', document_hash: hash,
})

test('a superseded legacy issue checks its own file, stays blue, and rejects its replacement', async () => {
  const first = await run(legacyIssue(V1_HASH), { fileHash: V1_HASH })
  assert.equal(first.outcome, 'verified')
  assert.equal(first.documentChecked, true)
  assert.equal(first.green, false)
  assert.equal(first.display.tone, 'legacy')
  assert.equal(first.display.label, 'VERIFIED — LEGACY RECORD (v1 or v2)')
  assert.equal((await run(legacyIssue(V1_HASH), { fileHash: V2_HASH })).outcome, 'hash_mismatch')
})

test('v1 and v2 outcomes and labels stay as they were, with or without a file', async () => {
  const hash = `0x${'ab'.repeat(32)}`
  for (const v of [1, 2]) {
    const payload = { v, entity: 'PROJECT', stage: 'BIDDING_OPEN', code: 'PC-7K4M-Q9XT-3HWD', name: 'x', category: 'x',
      type: 'x', budget: '1.00', bidding_period_days: 1, delivery_period_days: 1,
      created_at: '2026-11-03T08:15:00+00:00', document_hash: hash }
    for (const fileHash of [null, hash]) {
      const r = await run(payload, { fileHash })
      assert.deepEqual([r.outcome, r.label, r.green, r.display.tone],
        ['verified', 'VERIFIED — MATCH', false, 'legacy'], `v${v} ${fileHash}`)
    }
    assert.equal((await run(payload, { fileHash: `0x${'77'.repeat(32)}` })).outcome, 'hash_mismatch')
  }
})

// ── A result belongs to its inputs ──────────────────────────────────────────
test('changing or clearing the file, or the record, makes a result stale at once', () => {
  const loadA = () => {}
  const loadB = () => {}
  const done = { phase: 'done', loadPacket: loadA, fileHash: V1_HASH }
  assert.equal(isCurrentCheck(done, loadA, V1_HASH), true)
  assert.equal(isCurrentCheck(done, loadA, V2_HASH), false, 'another file')
  assert.equal(isCurrentCheck(done, loadA, null), false, 'file cleared')
  assert.equal(isCurrentCheck(done, loadB, V1_HASH), false, 'another record')
  assert.equal(isCurrentCheck({ ...done, phase: 'loading' }, loadA, V1_HASH), false, 'still checking')
  assert.equal(isCurrentCheck({ phase: 'loading' }, loadA, null), false, 'first render')
  assert.equal(isCurrentCheck(null, loadA, null), false)
})

test('both file pickers forget the old file before doing anything else', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const detail = read('../components/AnchorDetail.jsx')
  assert.match(detail, /const pick = async \(file\) => \{\s+forget\(\)\s+if \(!file\) return/)
  assert.match(detail, /const forget = \(\) => \{ latest\.current \+= 1; setFileHash\(null\)/)
  assert.match(detail, /<VerifyPanel key=\{rec\.id\}/)
  const verifier = read('../components/PublicVerifier.jsx')
  assert.match(verifier, /const onPickFile = async \(file\) => \{\s+forgetFile\(\)\s+if \(!file\) return/)
  assert.match(verifier, /const forgetFile = \(\) => \{ latestFile\.current \+= 1; setFileHash\(''\)/)
  const check = read('../components/PacketCheck.jsx')
  assert.match(check, /if \(!isCurrentCheck\(state, loadPacket, fileHash\)\) \{/)
})

test('Terms of Reference absent: genuine fingerprint, amber, named, and no green', async () => {
  const r = await run(vector(TOR_ABSENT).payload)
  assert.equal(r.integrity, 'match')
  assert.equal(r.outcome, 'unconfirmed')
  assert.equal(r.category, 'Unavailable or incomplete evidence')
  assert.equal(r.label, 'MATCH — INCOMPLETE EVIDENCE (4 of 5 present; missing: Terms of Reference (TOR))')
  assert.equal(r.display.label, r.label)
  assert.equal(r.display.tone, 'amber')
  assert.deepEqual(r.completeness.absent, ['terms_of_reference'])
})

test('a legacy record verifies under its own rules and never shows green', async () => {
  const payload = {
    v: 2, entity: 'PROJECT', stage: 'BIDDING_OPEN', code: 'PC-7K4M-Q9XT-3HWD', name: 'Pañuelo',
    category: 'x', type: 'goods', budget: '1.00', bidding_period_days: 1, delivery_period_days: 1,
    created_at: '2026-11-03T08:15:00+00:00', document_hash: `0x${'ab'.repeat(32)}`,
  }
  const r = await run(payload)
  assert.equal(r.outcome, 'verified')
  assert.equal(r.label, 'VERIFIED — MATCH')
  assert.equal(r.display.tone, 'legacy')
  assert.equal(r.display.label, 'VERIFIED — LEGACY RECORD (v1 or v2)')
})

test('the check compares the exact ledger time but shows only its date', async () => {
  const { payload } = vector(ALL_PRESENT)
  const passed = await run(payload)
  const signer = passed.checks.find((c) => c.key === 'signer')
  assert.equal(signer.status, 'pass')
  assert.doesNotMatch(signer.detail, /\d{1,2}:\d{2}/)
  assert.match(signer.detail, /on [A-Z][a-z]{2} \d{1,2}, 20\d\d/)
  const later = new Date((TIME + 1) * 1000).toISOString()
  const { packet, reader } = await setup(payload)
  packet.recorded.chain_timestamp = later
  const failed = await verifyPacket(packet, { trusted: TRUSTED, reader })
  assert.equal(failed.outcome, 'invalid_tx')
  const detail = failed.checks.find((c) => c.key === 'signer').detail
  assert.doesNotMatch(detail, /\d{1,2}:\d{2}|\d{10}/)
})

test('a v3 evaluation verifies without claiming a document', async () => {
  const r = await run(vector('evaluation/3').payload)
  assert.equal(r.outcome, 'verified')
  assert.notEqual(r.display.tone, 'ok')
})

test('a file is matched to any bound document, naming its key and version', async () => {
  const { payload } = vector(ALL_PRESENT)
  const r = await run(payload, { fileHash: payload.documents.terms_of_reference.sha256 })
  assert.equal(r.outcome, 'verified')
  assert.equal(r.documentChecked, true)
  assert.equal(r.green, true)
  assert.deepEqual(r.documentMatch, {
    key: 'terms_of_reference', label: 'Terms of Reference (TOR)', version: payload.documents.terms_of_reference.version,
  })
})

test('a file bound by no entry is a hash mismatch', async () => {
  const r = await run(vector(ALL_PRESENT).payload, { fileHash: `0x${'77'.repeat(32)}` })
  assert.equal(r.outcome, 'hash_mismatch')
  assert.equal(r.category, 'Mismatch')
})

test('an absent or unreadable entry can never match a file', () => {
  const { payload } = vector(TOR_ABSENT)
  assert.equal(matchManifest(payload, ''), null)
  payload.documents.terms_of_reference.sha256 = `0x${'77'.repeat(32)}`
  assert.equal(matchManifest(payload, `0x${'77'.repeat(32)}`), null)
})

test('an edited v3 payload is a mismatch, checked before its schema', async () => {
  const { payload } = vector(ALL_PRESENT)
  const { packet, reader } = await setup(payload)
  packet.payload = { ...payload, extra: 'added after hashing' }
  const r = await verifyPacket(packet, { trusted: TRUSTED, reader })
  assert.equal(r.outcome, 'hash_mismatch')
})

test('a payload that hashes correctly but is outside its schema is unavailable, never verified', async () => {
  const { payload } = vector(ALL_PRESENT)
  payload.extra = 'x'
  const r = await run(payload)
  assert.equal(r.outcome, 'unconfirmed')
  assert.equal(r.checks.find((c) => c.key === 'payload').status, 'fail')
})

test('an unsupported version stops before anything is compared, and is never a mismatch', async () => {
  for (const v of [4, '3', true]) {
    const r = await run({ ...vector(ALL_PRESENT).payload, v })
    assert.equal(r.outcome, 'unconfirmed', String(v))
    assert.match(r.checks.find((c) => c.key === 'packet').detail, /unsupported payload version/)
    assert.equal(r.checks.find((c) => c.key === 'network').status, 'skip')
  }
})

test('the five outcomes stay distinct', async () => {
  const { payload } = vector(ALL_PRESENT)
  const { packet, reader } = await setup(payload)
  const check = (p, r) => verifyPacket(p, { trusted: TRUSTED, reader: r })
  assert.equal((await check(packet, reader)).category, 'Verified')
  assert.equal((await check({ ...packet, data_hash: `0x${'00'.repeat(32)}` }, reader)).category, 'Mismatch')
  assert.equal((await check(packet, { ...reader, getAnchor: async () => null })).category, 'Missing evidence')
  assert.equal((await check(packet, { ...reader, chainId: async () => { throw new Error('down') } })).category,
    'Unavailable or incomplete evidence')
  assert.equal((await check(packet, { ...reader, getReceipt: async () => ({ status: 0, events: [] }) })).category,
    'Invalid transaction')
})

test('a pruned receipt is skipped, never failed and never verified; a hash alone is not enough', async () => {
  const { payload } = vector(ALL_PRESENT)
  const { packet, reader } = await setup(payload)
  const pruned = await verifyPacket(packet, { trusted: TRUSTED, reader: { ...reader, getReceipt: async () => null } })
  assert.equal(pruned.outcome, 'unconfirmed')
  assert.notEqual(pruned.outcome, 'invalid_tx')
  assert.equal(pruned.checks.find((c) => c.key === 'transaction').status, 'skip')
  const notOnLedger = await verifyPacket(packet, { trusted: TRUSTED, reader: { ...reader, getAnchor: async () => null } })
  assert.equal(notOnLedger.outcome, 'not_found')
})

test('an unreadable document is counted and named too', () => {
  const c = { present: 3, total: 5, absent: ['terms_of_reference'], unreadable: ['purchase_request'] }
  assert.equal(incompleteLabel(c),
    'MATCH — INCOMPLETE EVIDENCE (3 of 5 present; unreadable when recorded: Purchase Request (PR); missing: Terms of Reference (TOR))')
})

// ── Openings ─────────────────────────────────────────────────────────────────

test('an opening reproduces its commitment, and each failure says so', async () => {
  const leaf = vector('bid-leaf/3, winning').payload
  const { payload } = vector('evaluation/3')
  assert.equal((await checkOpening(leaf, payload)).status, 'match')
  const changed = await checkOpening({ ...leaf, amount: '1.00' }, payload)
  assert.deepEqual(changed, { status: 'mismatch', detail: 'opening does not match the commitment' })
  assert.equal((await checkOpening({ ...leaf, salt: '22'.repeat(32) }, payload)).status, 'mismatch')
  assert.equal((await checkOpening({ ...leaf, salt: '' }, payload)).status, 'invalid')
  assert.equal((await checkOpening({ ...leaf, kind: 'other' }, payload)).status, 'invalid')
  assert.equal((await checkOpening(null, payload)).status, 'invalid')
})

test('an invalid opening never repeats a value in its message', async () => {
  const leaf = vector('bid-leaf/3, winning').payload
  const salt = 'ZZ'.repeat(32)
  const { detail } = await checkOpening({ ...leaf, salt }, vector('evaluation/3').payload)
  assert.ok(!detail.includes(salt))
})

test('an award-private/3 opening is checked against private_commitment', async () => {
  const opening = vector('award-private/3').payload
  const commitment = await hashPayload(opening)
  assert.equal((await checkOpening(opening, { private_commitment: commitment })).status, 'match')
  assert.equal((await checkOpening(opening, { private_commitment: `0x${'00'.repeat(32)}` })).status, 'mismatch')
})

// ── The public "Check a document" box ────────────────────────────────────────

test('the document box finds a file in a v3 manifest, and is never green itself', () => {
  const { payload } = vector(TOR_ABSENT)
  const manifest = payload.documents
  const hash = manifest.purchase_request.sha256
  const row = { state: 'verified', label: 'Submitted', manifest, documentHash: '', completeness: completenessOf(payload) }
  assert.equal(findDocumentMatch(hash, [row]), row)
  const verdict = documentVerdict(hash, [row])
  assert.equal(verdict.tone, 'pending')
  assert.match(verdict.title, /Purchase Request \(PR\), version \d+/)
  assert.equal(documentVerdict(hash, [{ ...row, completeness: { status: 'complete' } }]).tone, 'legacy')
  assert.equal(documentVerdict(hash, [{ ...row, completeness: { status: 'not_recorded' } }]).tone, 'legacy')
})
