// Independent verification of one record from its verification packet.
//
// The packet (GET .../anchors/{id}/packet/) is the server's CLAIM: the exact
// payload, its fingerprint and where it should be on-chain. Nothing in it is
// trusted. This module recomputes every hash itself and reads the ledger
// through `reader`, in this order, stopping at the first decisive failure:
//
//   packet      required fields present and well-formed
//   document    sha256(file bytes)          === payload.document_hash   (if a file is given)
//   payload     sha256(canonical(payload))  === packet.data_hash
//   binding     payload's own entity/stage/code === the record it is filed under
//   contract    packet's network + contract === the ones THIS app is built for
//   network     the RPC really is that network (eth_chainId)
//   record      getAnchor(id) exists        (or, with no stored id, a search finds it)
//   onchain     its entityType/code/stage   === the packet's, and its dataHash === ours
//   signer/time match what the server recorded, when it recorded them
//   transaction the reported tx succeeded and our ledger's event in it is this record
//               (skipped — not failed — when the node no longer serves the receipt:
//               contract STATE is the authoritative record; the tx only delivered it)
//
// `outcome` is one of five results. Integrity is not completeness (payloadV3.js): a
// passed check also reports `completeness`, a `display` and `green`, which is true only
// for a record with all five documents, a selected file that matches, and a transaction
// read back. An incomplete one keeps its genuine fingerprint (`integrity: 'match'`)
// under the 'unconfirmed' outcome, in amber.
//
// A result belongs to the inputs it was computed from: see isCurrentCheck.

import { completenessOf, matchManifest, passedDisplay, payloadProblem, versionProblem } from './payloadV3.js'
import { hashPayload } from './receipt.js'
import { publicDate } from './recordView.js'

export const OUTCOMES = {
  verified: 'VERIFIED — MATCH',
  hash_mismatch: 'NOT VERIFIED — HASH MISMATCH',
  unconfirmed: 'UNCONFIRMED',
  not_found: 'RECORD NOT FOUND',
  invalid_tx: 'INVALID TRANSACTION',
}

// The same five outcomes in plain words, as the server's check names them.
export const OUTCOME_CATEGORY = {
  verified: 'Verified',
  hash_mismatch: 'Mismatch',
  not_found: 'Missing evidence',
  unconfirmed: 'Unavailable or incomplete evidence',
  invalid_tx: 'Invalid transaction',
}
/**
 * Is this result still about what is on screen now? A result computed for another
 * record, or another file (or none), must not be shown, not even while its replacement
 * is being worked out. A check in progress is not shown as anything but in progress.
 */
export const isCurrentCheck = (state, loadPacket, fileHash) =>
  Boolean(state) && state.phase !== 'loading' && state.loadPacket === loadPacket && state.fileHash === fileHash

// What a mismatch establishes: that values differ. Not why, and not who.
const MISMATCH_NOTE = 'The bytes or data differ from the recorded fingerprint. '
  + 'This shows a difference; it does not by itself show why, or that anyone acted maliciously.'
const OUTCOME_TONE = { verified: 'ok', hash_mismatch: 'bad', not_found: 'bad', invalid_tx: 'bad', unconfirmed: 'pending' }

const HEX32 = /^0x[0-9a-fA-F]{64}$/
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const CHECKS = [
  ['packet', 'Packet complete and well-formed'],
  ['document', 'Document matches the recorded document hash'],
  ['payload', 'Payload reproduces the record fingerprint'],
  ['binding', 'Payload belongs to this record (entity, stage, code)'],
  ['contract', 'Record is on the expected network and contract'],
  ['network', 'Blockchain node is on that network'],
  ['record', 'Record exists on the ledger'],
  ['onchain', 'Ledger record matches (entity, code, stage, fingerprint)'],
  ['signer', 'Signer and time match the recorded transaction'],
  ['transaction', 'Reported transaction recorded this entry'],
]

/**
 * @param packet  the server's packet
 * @param opts.fileHash  "0x…" sha256 of the selected file, or null to check the record only
 * @param opts.trusted   { chainId, contract } — from THIS app's build config, never the packet
 * @param opts.reader    { chainId(), getAnchor(id) → row|null, findAnchors(ref) → [{id,…row}],
 *                         getReceipt(tx) → {status, events:[{id,entityType,entityRef,stage,dataHash}]}|null }
 *                       rows are { entityType, entityRef, stage, dataHash, actor, timestamp (seconds) }
 */
export async function verifyPacket(packet, { fileHash = null, trusted, reader }) {
  const results = new Map(CHECKS.map(([key, label]) => [key, { key, label, status: 'skip', detail: 'Not run.' }]))
  const set = (key, status, detail) => Object.assign(results.get(key), { status, detail })
  const done = (outcome, extra = {}) => ({
    outcome,
    label: OUTCOMES[outcome],
    category: OUTCOME_CATEGORY[outcome],
    green: false,
    checkedFileHash: fileHash,
    display: { green: false, tone: OUTCOME_TONE[outcome], label: OUTCOMES[outcome],
      note: outcome === 'hash_mismatch' ? MISMATCH_NOTE : '' },
    documentChecked: Boolean(fileHash) && results.get('document').status === 'pass',
    checks: [...results.values()],
    ...extra,
  })

  // ── packet ──
  const p = packet || {}
  const a = p.anchor || {}
  const missing = [
    !isObject(p.payload) && 'payload',
    !HEX32.test(p.data_hash || '') && 'data_hash',
    !(a.entity_type && a.entity_ref && a.stage) && 'anchor',
    !isObject(p.expected) && 'expected',
    !isObject(p.recorded) && 'recorded',
  ].filter(Boolean)
  if (missing.length) {
    set('packet', 'fail', `Missing or malformed: ${missing.join(', ')}. This record cannot be checked independently.`)
    return done('unconfirmed')
  }
  const payload = p.payload
  const rec = p.recorded
  // Never guessed at, and never reported as a mismatch: this browser simply has no
  // rules for that version. Refused before anything is compared.
  const unreadable = versionProblem(payload)
  if (unreadable) {
    set('packet', 'fail', `This record uses an ${unreadable}, so it can't be checked here.`)
    return done('unconfirmed')
  }
  set('packet', 'pass', `Packet v${p.packet_version ?? '?'} for payload v${p.payload_version ?? '?'}.`)

  // ── document ──
  // v3 binds five documents: a file matches any of them, and the result names which.
  let documentMatch = null
  if (fileHash) {
    const docHash = payload.document_hash
    documentMatch = matchManifest(payload, fileHash)
    if (!docHash && !documentMatch && !isObject(payload.documents)) {
      set('document', 'fail', 'This record does not fingerprint a document, so no file can be matched to it.')
      return done('unconfirmed')
    }
    if (!documentMatch && (!docHash || !same(docHash, fileHash))) {
      set('document', 'fail', isObject(payload.documents)
        ? `The file hashes to ${fileHash}, which is none of the documents this record binds.`
        : `The file hashes to ${fileHash}, the record holds ${docHash}.`)
      return done('hash_mismatch')
    }
    set('document', 'pass', documentMatch
      ? `${documentMatch.label}, version ${documentMatch.version}: ${fileHash}`
      : fileHash)
  } else {
    set('document', 'skip', 'No document selected — checking the record only.')
  }

  // ── payload ──
  let computed
  try {
    computed = await hashPayload(payload)
  } catch (err) {
    set('payload', 'fail', `The payload cannot be hashed by the documented rules (${err.message}).`)
    return done('unconfirmed')
  }
  if (!same(computed, p.data_hash)) {
    set('payload', 'fail', `The payload hashes to ${computed}, not the recorded ${p.data_hash}.`)
    return done('hash_mismatch', { computedHash: computed })
  }
  // After the hash, as on the server: a payload that was edited is a mismatch above;
  // one that hashes correctly and is still outside its schema proves nothing.
  const outOfSchema = payloadProblem(payload)
  if (outOfSchema) {
    set('payload', 'fail', `The payload is outside its schema (${outOfSchema}), so it can't be checked here.`)
    return done('unconfirmed', { computedHash: computed })
  }
  set('payload', 'pass', computed)

  // ── binding: the hashed content names the record it is filed under ──
  const code = payload.code ?? payload.project_code
  const wrong = [
    payload.entity !== undefined && payload.entity !== a.entity_type && `entity ${payload.entity}`,
    payload.stage !== undefined && payload.stage !== a.stage && `stage ${payload.stage}`,
    code !== undefined && code !== a.entity_ref && `code ${code}`,
  ].filter(Boolean)
  if (wrong.length) {
    set('binding', 'fail', `The hashed payload describes a different record (${wrong.join(', ')}).`)
    return done('invalid_tx', { computedHash: computed })
  }
  set('binding', 'pass', `${a.entity_type} · ${a.entity_ref} · ${a.stage}`)

  // ── contract / network the record claims ──
  if (!trusted?.contract || !trusted?.chainId) {
    set('contract', 'fail', 'This app has no ledger contract configured, so nothing can be checked on-chain.')
    return done('unconfirmed', { computedHash: computed })
  }
  const claims = [
    ['expected chain', p.expected.chain_id, trusted.chainId],
    ['expected contract', p.expected.contract, trusted.contract],
    ['recorded chain', rec.chain_id, trusted.chainId],
    ['recorded contract', rec.chain_contract, trusted.contract],
  ].filter(([, claimed]) => claimed !== null && claimed !== undefined && claimed !== '')
  const off = claims.filter(([, claimed, want]) => !same(claimed, want))
  if (off.length || !claims.some(([name]) => name === 'expected contract')) {
    set('contract', 'fail', off.length
      ? `The record points elsewhere: ${off.map(([n, c]) => `${n} ${c}`).join(', ')} (this app uses chain ${trusted.chainId}, contract ${trusted.contract}).`
      : 'The packet does not name a contract.')
    return done('invalid_tx', { computedHash: computed })
  }
  set('contract', 'pass', `Chain ${trusted.chainId}, contract ${trusted.contract}`)

  // ── network the node is really on ──
  try {
    const id = BigInt(await reader.chainId())
    if (id !== BigInt(trusted.chainId)) {
      set('network', 'fail', `The blockchain node answers for chain ${id}, not ${trusted.chainId}.`)
      return done('unconfirmed', { computedHash: computed })
    }
  } catch (err) {
    set('network', 'fail', `The blockchain node could not be reached (${err?.message || err}).`)
    return done('unconfirmed', { computedHash: computed })
  }
  set('network', 'pass', `Chain ${trusted.chainId}`)

  // ── record: by stored id, or by search when the server never linked one ──
  let row
  let onChainId = rec.chain_anchor_id
  let locatedBy = 'id'
  try {
    if (onChainId !== null && onChainId !== undefined) {
      row = await reader.getAnchor(onChainId)
      if (!row) {
        set('record', 'fail', `The ledger has no record #${onChainId}.`)
        return done('not_found', { computedHash: computed })
      }
    } else {
      locatedBy = 'search'
      const rows = await reader.findAnchors(a.entity_ref)
      row = rows.find((r) => r.entityType === a.entity_type && r.stage === a.stage && same(r.dataHash, computed))
      if (!row) {
        set('record', 'fail', `No record for ${a.entity_ref} · ${a.stage} with this fingerprint is on the ledger`
          + (rec.tx_hash ? '.' : ' (no transaction was ever reported for it).'))
        return done('not_found', { computedHash: computed })
      }
      onChainId = row.id
    }
  } catch (err) {
    set('record', 'fail', `The ledger could not be read (${err?.message || err}).`)
    return done('unconfirmed', { computedHash: computed })
  }
  set('record', 'pass', locatedBy === 'id'
    ? `Ledger record #${onChainId}.`
    : `Ledger record #${onChainId}, found by searching this procurement's records (no id was stored).`)

  // ── onchain: the ledger's record is this one ──
  if (row.entityType !== a.entity_type || row.entityRef !== a.entity_ref || row.stage !== a.stage) {
    set('onchain', 'fail', `Ledger record #${onChainId} is ${row.entityType} · ${row.entityRef} · ${row.stage}, `
      + `a different record.`)
    return done('not_found', { computedHash: computed, onChainId })
  }
  if (!same(row.dataHash, computed)) {
    set('onchain', 'fail', `Ledger record #${onChainId} holds ${row.dataHash}; this payload hashes to ${computed}. `
      + 'The record has changed since it was fingerprinted.')
    return done('hash_mismatch', { computedHash: computed, onChainId })
  }
  set('onchain', 'pass', `#${onChainId} holds ${row.dataHash}`)

  // ── signer / time, against what the server recorded ──
  const recordedTime = rec.chain_timestamp ? Math.floor(new Date(rec.chain_timestamp).getTime() / 1000) : null
  // Only a signer the SERVER read from the chain is comparable. A reported,
  // unconfirmed signer is just the wallet address the browser posted — with a
  // smart-account wallet the ledger's msg.sender is the executor, not that
  // address, so comparing it would fail genuine records.
  const signerKnown = Boolean(rec.actor_address) && rec.verified_by_server === true
  const badSigner = signerKnown && !same(rec.actor_address, row.actor)
  const badTime = recordedTime !== null && recordedTime !== Number(row.timestamp)
  if (badSigner || badTime) {
    set('signer', 'fail', [
      badSigner && `the ledger's signer is ${row.actor}, the record says ${rec.actor_address}`,
      // No values: this text is on public pages, and they show dates only.
      badTime && "the ledger's time differs from the time the record states",
    ].filter(Boolean).join('; ') + '.')
    return done('invalid_tx', { computedHash: computed, onChainId })
  }
  // The exact times were compared above. Only the date is shown (see publicDate).
  set('signer', 'pass', `Signed by ${row.actor} on ${publicDate(Number(row.timestamp) * 1000)}`
    + (signerKnown ? '' : ' (the ledger’s own record; no server-confirmed signer to compare with)'))

  // ── transaction ──
  if (!rec.tx_hash) {
    set('transaction', 'skip', 'No transaction hash was reported; the ledger record above is the evidence.')
  } else {
    let receipt
    try {
      receipt = await reader.getReceipt(rec.tx_hash)
    } catch {
      receipt = null
    }
    if (!receipt) {
      set('transaction', 'skip', 'This node no longer serves that transaction receipt (old history is pruned); '
        + 'the ledger record above is the evidence.')
    } else if (Number(receipt.status) !== 1) {
      set('transaction', 'fail', `Transaction ${rec.tx_hash} failed on-chain.`)
      return done('invalid_tx', { computedHash: computed, onChainId })
    } else {
      const ev = (receipt.events || []).find((e) => (locatedBy === 'id'
        ? Number(e.id) === Number(onChainId)
        : e.entityType === a.entity_type && e.entityRef === a.entity_ref && e.stage === a.stage
          && same(e.dataHash, computed)))
      if (!ev) {
        set('transaction', 'fail', `Transaction ${rec.tx_hash} did not record ledger entry #${onChainId}.`)
        return done('invalid_tx', { computedHash: computed, onChainId })
      }
      set('transaction', 'pass', `${rec.tx_hash} emitted entry #${ev.id}`)
    }
  }

  const completeness = completenessOf(payload)
  const display = passedDisplay(completeness, {
    documentMatch,
    documentChecked: Boolean(fileHash) && results.get('document').status === 'pass',
    transactionChecked: results.get('transaction').status === 'pass',
  })
  return done(display.outcome, {
    integrity: 'match',
    green: display.green === true,
    completeness,
    display,
    documentMatch,
    computedHash: computed,
    onChainId,
    locatedBy,
    ...(display.outcome === 'verified' ? {} : { label: display.label }),
  })
}
