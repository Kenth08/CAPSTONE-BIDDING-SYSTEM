// Reading payload v3 in the browser: the same rules as backend/procurement/
// payload_v3.py and payload_v3_reader.py, kept independent on purpose, so this
// check never takes the server's word for a payload's shape. Validation errors
// name a field, never a value: an opening holds a salt.

import { hashPayload } from './receipt.js'

export const KIND_PROJECT_STAGE = 'project-stage/3'
export const KIND_EVALUATION = 'evaluation/3'
export const KIND_BID_LEAF = 'bid-leaf/3'
export const KIND_AWARD_PRIVATE = 'award-private/3'

export const SUPPORTED_VERSIONS = [1, 2, 3]
const READABLE_KINDS = [KIND_PROJECT_STAGE, KIND_EVALUATION]

export const DOCUMENT_LABELS = {
  purchase_request: 'Purchase Request (PR)',
  technical_specifications: 'Technical Specifications',
  terms_of_reference: 'Terms of Reference (TOR)',
  approved_budget_document: 'Approved Budget Document',
  bid_evaluation_criteria: 'Bid Evaluation Criteria',
}
const DOCUMENT_KEYS = Object.keys(DOCUMENT_LABELS)
const STAGE_EVIDENCE = {
  SUBMITTED: 'purchase_request',
  HEAD_APPROVED: 'approved_budget_document',
  HEAD_REJECTED: 'purchase_request',
  REVISION_REQUESTED: 'purchase_request',
  BIDDING_OPEN: 'bid_evaluation_criteria',
}

const PROJECT_STAGE_KEYS = [
  'v', 'kind', 'entity', 'stage', 'code', 'name', 'category', 'type', 'budget',
  'bidding_period_days', 'delivery_period_days', 'created_at', 'documents', 'document_key', 'document_hash',
]
const EVALUATION_KEYS = ['v', 'kind', 'entity', 'stage', 'code', 'bid_count', 'leaves']
const LEAF_KEYS = ['kind', 'bid_id', 'supplier_id', 'amount', 'submitted_at', 'document_hash', 'status', 'salt']
const AWARD_PRIVATE_KEYS = ['kind', 'salt', 'award_id', 'bid_id', 'supplier_id', 'status', 'awarded_at']

const HASH = /^0x[0-9a-f]{64}$/
const SALT = /^[0-9a-f]{64}$/
const MONEY = /^[0-9]+\.[0-9]{2}$/
const UTC_DATETIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{6})?\+00:00$/
const KEY = /^[a-z0-9_]+$/

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isCount = (v) => Number.isSafeInteger(v) && v >= 0
const isText = (v) => typeof v === 'string'

/** Strict canonical values: [a-z0-9_] keys, strings, whole numbers. `arrays` names allowed array keys. */
function canonicalProblem(value, path, arrays = []) {
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (!KEY.test(key)) return `${path}: a key is not [a-z0-9_]`
      if (Array.isArray(item) && arrays.includes(key)) continue
      const problem = canonicalProblem(item, `${path}.${key}`)
      if (problem) return problem
    }
    return null
  }
  if (isText(value) || isCount(value)) return null
  return `${path}: this kind of value is not allowed`
}

function keysProblem(obj, expected, path) {
  const have = Object.keys(obj).sort()
  const want = [...expected].sort()
  return have.length === want.length && have.every((k, i) => k === want[i]) ? null : `${path}: wrong fields`
}

function entryProblem(key, entry) {
  if (!isObject(entry)) return `documents.${key} must be an object`
  const fields = keysProblem(entry, ['state', 'sha256', 'version'], `documents.${key}`)
  if (fields) return fields
  const { state, sha256, version } = entry
  if (!isCount(version)) return `documents.${key}.version must be a count`
  if (state === 'present') return HASH.test(sha256) && version >= 1 ? null : `documents.${key}: bad present entry`
  if (state === 'absent') return sha256 === '' && version === 0 ? null : `documents.${key}: bad absent entry`
  if (state === 'unreadable') return sha256 === '' && version >= 1 ? null : `documents.${key}: bad unreadable entry`
  return `documents.${key}: unknown state`
}

function projectStageProblem(p) {
  const shape = canonicalProblem(p, 'payload') || keysProblem(p, PROJECT_STAGE_KEYS, 'payload')
  if (shape) return shape
  if (p.v !== 3 || p.entity !== 'PROJECT') return 'v and entity must be 3 and PROJECT'
  if (!Object.hasOwn(STAGE_EVIDENCE, p.stage)) return 'stage is not a project stage'
  if (![p.code, p.name, p.category, p.type].every(isText) || !p.code) return 'code, name, category or type is invalid'
  if (!MONEY.test(p.budget)) return 'budget must be a string with two decimals'
  if (!isCount(p.bidding_period_days) || !isCount(p.delivery_period_days)) return 'the periods must be counts'
  if (!UTC_DATETIME.test(p.created_at)) return 'created_at must be ISO-8601 in UTC'
  if (!isObject(p.documents)) return 'documents must be an object'
  const docs = keysProblem(p.documents, DOCUMENT_KEYS, 'documents')
  if (docs) return docs
  for (const key of DOCUMENT_KEYS) {
    const problem = entryProblem(key, p.documents[key])
    if (problem) return problem
  }
  if (p.document_key !== STAGE_EVIDENCE[p.stage]) return "document_key must be this stage's evidence document"
  if (p.document_hash !== p.documents[p.document_key].sha256) return 'document_hash must repeat the manifest hash'
  return null
}

function evaluationProblem(p) {
  const shape = canonicalProblem(p, 'payload', ['leaves']) || keysProblem(p, EVALUATION_KEYS, 'payload')
  if (shape) return shape
  if (p.v !== 3 || p.entity !== 'PROJECT' || p.stage !== 'EVALUATION_COMPLETED') return 'v, entity or stage is wrong'
  if (!isText(p.code) || !p.code) return 'code must not be empty'
  if (!Array.isArray(p.leaves) || p.bid_count !== p.leaves.length) return 'bid_count must equal the number of leaves'
  if (!p.leaves.every((leaf) => isText(leaf) && HASH.test(leaf))) return 'each leaf must be 0x + 64 lowercase hex'
  // Plain code-point order, as Python's sorted(): never localeCompare.
  const sorted = [...new Set(p.leaves)].sort()
  if (sorted.length !== p.leaves.length || sorted.some((leaf, i) => leaf !== p.leaves[i])) {
    return 'leaves must be unique and sorted by value'
  }
  return null
}

/**
 * Can this browser read this payload's version at all? Mirrors
 * blockchain.payload_rules: no `v` is version 1; anything but a plain supported
 * integer is refused rather than guessed at.
 */
export function versionProblem(payload) {
  if (!('v' in payload)) return null
  return SUPPORTED_VERSIONS.includes(payload.v) ? null : 'unsupported payload version'
}

/** Why a v3 payload can't be read, or null. Any other version has no schema here. */
export function payloadProblem(payload) {
  if (payload.v !== 3) return null
  if (!READABLE_KINDS.includes(payload.kind)) return 'unsupported payload kind'
  return payload.kind === KIND_PROJECT_STAGE ? projectStageProblem(payload) : evaluationProblem(payload)
}

/** Which bound document a file's hash is: { key, label, version } or null. */
export function matchManifest(payload, fileHash) {
  if (!fileHash || !isObject(payload?.documents)) return null
  const hash = fileHash.toLowerCase()
  for (const [key, entry] of Object.entries(payload.documents)) {
    // An absent or unreadable entry holds "", which no file's hash can equal, but
    // the state is checked as well: such an entry must never match.
    if (entry?.state === 'present' && entry.sha256 === hash) {
      return { key, label: DOCUMENT_LABELS[key] || key, version: entry.version }
    }
  }
  return null
}

export const RECORD_ONLY_LABEL = 'RECORD MATCH — DOCUMENT NOT CHECKED'
export const SELECTED_DOCUMENT_LABEL = 'SELECTED DOCUMENT VERIFIED — RECORD CHECKS COMPLETE'
const TRANSACTION_NOT_CHECKED = 'No transaction receipt was available to check, so the transaction is unconfirmed; '
  + 'the ledger’s stored record is the evidence.'
const LEGACY_TEXT = 'Checked under its original rules; one document per step; five-document completeness was not checked.'
const INCOMPLETE_TEXT = 'The fingerprint is genuine; it records that these documents were missing when this step was taken'

/** Design section 6.1. Read from the payload alone. */
export function completenessOf(payload) {
  if (!isObject(payload)) return { status: 'unknown', label: 'NOT KNOWN' }
  const version = 'v' in payload ? payload.v : 1
  if (version === 1 || version === 2) return { status: 'not_recorded', label: 'NOT RECORDED (legacy)' }
  if (version !== 3) return { status: 'unknown', label: 'NOT KNOWN' }
  if (payload.kind === KIND_EVALUATION) return { status: 'not_applicable', label: 'NOT APPLICABLE' }
  if (payload.kind !== KIND_PROJECT_STAGE || projectStageProblem(payload)) return { status: 'unknown', label: 'NOT KNOWN' }
  const keysIn = (state) => DOCUMENT_KEYS.filter((k) => payload.documents[k].state === state).sort()
  const absent = keysIn('absent')
  const unreadable = keysIn('unreadable')
  const present = DOCUMENT_KEYS.length - absent.length - unreadable.length
  const base = { present, total: DOCUMENT_KEYS.length, absent, unreadable }
  if (unreadable.length) return { ...base, status: 'unreadable_when_recorded', label: 'INCOMPLETE: UNREADABLE WHEN RECORDED' }
  if (absent.length) return { ...base, status: 'incomplete', label: `INCOMPLETE: ${present} of ${base.total} present` }
  return { ...base, status: 'complete', label: 'COMPLETE' }
}

const labelsOf = (keys) => keys.map((k) => DOCUMENT_LABELS[k] || k).join(', ')

/**
 * "MATCH — INCOMPLETE EVIDENCE (4 of 5 present; missing: ...)". The fingerprint is
 * genuine, and the word Verified is deliberately absent: the outcome is
 * `unconfirmed`. backend/procurement/verification.py builds the same text.
 */
export function incompleteLabel(c) {
  const parts = [`${c.present} of ${c.total} present`]
  if (c.unreadable.length) parts.push(`unreadable when recorded: ${labelsOf(c.unreadable)}`)
  if (c.absent.length) parts.push(`missing: ${labelsOf(c.absent)}`)
  return `MATCH — INCOMPLETE EVIDENCE (${parts.join('; ')})`
}

/**
 * How a passed integrity check may be shown: { green, tone, label, note, outcome }.
 *
 * Green takes all of: all five documents recorded, a selected file whose bytes match
 * the version this record bound, and a transaction read back and agreeing. It says
 * only that: one document was checked, not all five. Anything less is blue. Amber,
 * never green, for INCOMPLETE, even with a matching file.
 *
 * For a v3 record the transaction check is required, so a skipped one (a pruned receipt,
 * or no transaction reported) is `unconfirmed`, in blue: not a failure, and not a success.
 * INCOMPLETE is `unconfirmed` too, so anything acting on the outcome alone can't take
 * either for verified. Legacy records (Decision H) keep their blue status and their
 * outcome: `verified`, with a skipped receipt, exactly as they always were.
 */
export function passedDisplay(completeness, { documentMatch = null, documentChecked = false, transactionChecked = false } = {}) {
  const c = completeness
  const v3Outcome = transactionChecked ? 'verified' : 'unconfirmed'
  const noTransaction = transactionChecked ? '' : ` ${TRANSACTION_NOT_CHECKED}`
  if (c.status === 'complete') {
    if (!documentChecked) {
      return { outcome: v3Outcome, green: false, tone: 'legacy', label: RECORD_ONLY_LABEL,
        note: `The record matches the ledger, but no document’s bytes were checked. Choose a file to check one.${noTransaction}` }
    }
    const named = documentMatch ? `${documentMatch.label}, version ${documentMatch.version}` : 'The selected document'
    if (!transactionChecked) {
      return { outcome: 'unconfirmed', green: false, tone: 'legacy',
        label: 'RECORD AND SELECTED DOCUMENT MATCH — TRANSACTION NOT CHECKED',
        note: `${named} matches this record.${noTransaction}` }
    }
    return { outcome: 'verified', green: true, tone: 'ok', label: SELECTED_DOCUMENT_LABEL,
      note: `${named} was checked. The other four documents were not individually checked here: only their recorded fingerprints are part of this record.` }
  }
  if (c.status === 'incomplete' || c.status === 'unreadable_when_recorded') {
    return {
      outcome: 'unconfirmed',
      green: false,
      tone: 'amber',
      label: incompleteLabel(c),
      note: `${INCOMPLETE_TEXT}: ${labelsOf([...c.absent, ...c.unreadable])}.`,
    }
  }
  if (c.status === 'not_applicable') {
    return { outcome: v3Outcome, green: false, tone: 'legacy', label: 'RECORD MATCH — NO DOCUMENT BOUND',
      note: `This record binds no document, so five-document completeness does not apply to it.${noTransaction}` }
  }
  return { outcome: 'verified', green: false, tone: 'legacy', label: 'VERIFIED — LEGACY RECORD (v1 or v2)', note: LEGACY_TEXT }
}

function openingProblem(opening) {
  if (!isObject(opening)) return 'opening must be an object'
  const shape = canonicalProblem(opening, 'opening')
  if (shape) return shape
  if (opening.kind === KIND_BID_LEAF) {
    const fields = keysProblem(opening, LEAF_KEYS, 'opening')
    if (fields) return fields
    if (!MONEY.test(opening.amount)) return 'amount must be a string with two decimals'
    if (!UTC_DATETIME.test(opening.submitted_at)) return 'submitted_at must be ISO-8601 in UTC'
    if (opening.document_hash !== '' && !HASH.test(opening.document_hash)) return 'document_hash is invalid'
  } else if (opening.kind === KIND_AWARD_PRIVATE) {
    const fields = keysProblem(opening, AWARD_PRIVATE_KEYS, 'opening')
    if (fields) return fields
    if (!UTC_DATETIME.test(opening.awarded_at)) return 'awarded_at must be ISO-8601 in UTC'
  } else {
    return 'opening: unknown kind'
  }
  if (!isText(opening.status) || !opening.status) return 'status must be a string'
  return SALT.test(opening.salt) ? null : 'salt must be 64 lowercase hex characters'
}

const COMMITMENT_FIELD = { [KIND_BID_LEAF]: 'leaves', [KIND_AWARD_PRIVATE]: 'private_commitment' }

/**
 * Does an opening someone holds reproduce the commitment in this payload?
 * { status: 'match' | 'mismatch' | 'invalid', detail }. Affects the opening only:
 * the public record's own verdict stands either way.
 */
export async function checkOpening(opening, payload) {
  const problem = openingProblem(opening)
  if (problem) return { status: 'invalid', detail: problem }
  const held = payload?.[COMMITMENT_FIELD[opening.kind]]
  const commitment = await hashPayload(opening)
  const found = Array.isArray(held) ? held.includes(commitment) : held === commitment
  return found
    ? { status: 'match', detail: 'The opening reproduces the commitment.' }
    : { status: 'mismatch', detail: 'opening does not match the commitment' }
}
