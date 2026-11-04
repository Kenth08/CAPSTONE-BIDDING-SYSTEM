// What the public "Check a document" box may honestly say about a file.
//
// The ledger stores ONE fingerprint per step: sha256 of that step's canonical
// record (the payload), which includes the evidence document's hash. The
// document hash itself is never on-chain, and the payload is not public. So a
// file whose hash equals the `document_hash` BidBridge reports for a step has
// matched BidBridge's database — and if that step is verified on the ledger,
// the record it belongs to was fixed at that time. The link between the two
// (file hash -> payload -> on-chain fingerprint) is still BidBridge's word
// until the payload can be checked too. Never word a match as proof beyond that.

/** The trail row whose reported document hash equals `fileHash`, or null. */
export function findDocumentMatch(fileHash, rows) {
  if (!fileHash) return null
  const h = fileHash.toLowerCase()
  return (rows || []).find((r) => r.documentHash && r.documentHash.toLowerCase() === h) || null
}

const LINK_CAVEAT =
  'The ledger stores a fingerprint of the whole step record, not this file’s hash directly — '
  + 'that this file belongs to that fingerprint is, for now, reported by this system’s database.'

// Per row state (see mergeTrail in PublicVerifier.jsx): verdict tone + detail.
const BY_STATE = {
  verified: ['ok', `This step’s record fingerprint is on the Sepolia ledger. ${LINK_CAVEAT}`],
  server: ['pending',
    'This browser could not read the ledger; the server reports the step as confirmed on-chain. '
    + 'Not independently verified here.'],
  reported: ['pending',
    'A transaction was reported for this step but has not been confirmed on-chain, so the match is not verified.'],
  pending: ['pending',
    'This step is recorded in this system but not yet on the blockchain, so the match is not verified.'],
  unmatched: ['bad',
    'This step is marked as anchored, but its fingerprint was not found on the ledger. Treat the match as unverified.'],
  altered: ['bad',
    'This step’s record no longer matches the fingerprint published for it. Treat the match as unverified.'],
}

const NO_MATCH_DETAIL =
  'Either this file is not part of this procurement, or it has been modified since it was recorded — even a '
  + 'single changed byte produces a completely different hash. Images are cleaned of metadata when uploaded, '
  + 'so compare the copy downloaded from this system, not the original photo or scan.'

/** { tone: 'ok' | 'pending' | 'bad', title, detail } for a hashed file. */
export function documentVerdict(fileHash, rows) {
  const m = findDocumentMatch(fileHash, rows)
  if (!m) return { tone: 'bad', title: 'No match in this procurement’s trail.', detail: NO_MATCH_DETAIL, match: null }
  const [tone, detail] = BY_STATE[m.state] || ['pending', 'The on-chain status of this step is unknown, so the match is not verified.']
  const title = m.superseded
    ? `Matches an earlier version recorded at "${m.label}". It was later re-issued.`
    : `Matches the document this system recorded at "${m.label}".`
  return { tone, title, detail, match: m }
}
