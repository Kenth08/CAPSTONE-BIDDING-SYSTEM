import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertCircle, CheckCircle2, Download, ExternalLink, FileSearch, Loader2, Search,
  ShieldCheck, ShieldX, Upload, XCircle,
} from 'lucide-react'

import { apiPublicAnchors, apiPublicPacket } from '../api'
import { readChainTrail, sha256File } from '../blockchain/anchor'
import { documentVerdict } from '../blockchain/documentCheck'
import { contractUrl, isLedgerConfigured, txUrl, LEDGER_ADDRESS } from '../blockchain/contract'
import { EXAMPLE_CODE, normalizeProcurementCode } from '../utils/procurementCode'
import PacketCheck from './PacketCheck'
import './PublicVerifier.css'

const shortHash = (h) => (h ? `${h.slice(0, 14)}…${h.slice(-8)}` : '—')
const shortTx = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '')
const fmtWhen = (v) =>
  v ? new Date(v).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—'

const STAGE_LABEL = {
  SUBMITTED: 'Procurement submitted for approval',
  HEAD_APPROVED: 'Approved by the Head',
  HEAD_REJECTED: 'Rejected by the Head',
  REVISION_REQUESTED: 'Revision requested by the Head',
  BIDDING_OPEN: 'Published — open for bidding',
  BID_SUBMITTED: 'Bid submitted by a supplier',
  BID_QUALIFIED: 'Bid qualified after evaluation',
  BID_DISQUALIFIED: 'Bid disqualified after evaluation',
  AWARDED: 'Contract awarded',
  RESOLUTION_ISSUED: 'BAC Resolution issued',
  NOA_ISSUED: 'Notice of Award issued',
  NTP_ISSUED: 'Notice to Proceed issued',
  EVALUATION_COMPLETED: 'Evaluation completed (all bids committed)',
}

/**
 * Merge what the system says (backend) with what the blockchain says (contract),
 * matching on stage + hash.
 *
 * This comparison is the whole point of the page. The backend row is a claim; the
 * chain row is the evidence. A record whose hash was quietly edited in the
 * database afterwards would show up here as "recorded, but not found on-chain",
 * because the altered hash no longer matches anything that was ever written.
 */
function mergeTrail(dbAnchors, chainAnchors, { chainReadable = true } = {}) {
  const remaining = [...chainAnchors]
  const rows = dbAnchors.map((a) => {
    const i = remaining.findIndex(
      (c) => c.dataHash?.toLowerCase() === a.data_hash?.toLowerCase(),
    )
    const onChain = i >= 0 ? remaining.splice(i, 1)[0] : null
    return {
      key: `db-${a.stage}-${a.data_hash}`,
      anchorId: a.id,
      entityType: a.entity_type,
      stage: a.stage,
      label: a.stage_label || STAGE_LABEL[a.stage] || a.stage,
      dataHash: a.data_hash,
      documentHash: a.document_hash,
      txHash: a.tx_hash,
      blockNumber: a.block_number,
      recordedAt: a.recorded_at,
      chainTime: onChain?.timestamp || null,
      actor: onChain?.actor || a.actor_address || '',
      integrity: a.integrity || null,
      // A re-issued award document's earlier version: genuine, just no longer
      // the current one. Shown neutrally, never as tampering.
      superseded: a.integrity?.status === 'superseded',
      // 'altered'   — the live record no longer hashes to what was published.
      //               Checked first: it outranks everything else.
      // 'verified'  — the hash is on the public ledger, matching exactly.
      // 'pending'   — recorded here, never anchored (no wallet/gas at the time).
      // 'unmatched' — anchored per our DB, but not found on the ledger.
      // 'server'    — this browser could not read the ledger, but the server
      //               has read the transaction and confirmed it. A second-hand
      //               answer, labelled as such — never shown as 'verified'.
      // 'reported'  — this browser could not read the ledger and the server
      //               has not confirmed the transaction either.
      state:
        a.integrity?.status === 'mismatch' ? 'altered'
        : onChain ? 'verified'
        : !a.anchored ? 'pending'
        : !chainReadable ? (a.verified_on_chain ? 'server' : 'reported')
        : 'unmatched',
    }
  })

  // Anchors on-chain that our DB doesn't know about. Anyone can write to the
  // demo ledger, so these are shown, clearly marked, rather than hidden.
  remaining.forEach((c, i) => {
    rows.push({
      key: `chain-extra-${i}-${c.dataHash}`,
      entityType: c.entityType,
      stage: c.stage,
      label: STAGE_LABEL[c.stage] || c.stage,
      dataHash: c.dataHash,
      chainTime: c.timestamp,
      actor: c.actor,
      state: 'extra',
    })
  })
  return rows
}

const STATE_UI = {
  verified: { cls: 'pv-ok', icon: ShieldCheck, text: 'Verified on-chain' },
  altered: { cls: 'pv-bad', icon: ShieldX, text: 'Record altered since it was recorded' },
  pending: { cls: 'pv-pending', icon: AlertCircle, text: 'Recorded, not yet anchored' },
  unmatched: { cls: 'pv-bad', icon: ShieldX, text: 'Not found on the ledger' },
  server: { cls: 'pv-extra', icon: ShieldCheck, text: 'Confirmed by the server (ledger not readable here)' },
  reported: { cls: 'pv-pending', icon: AlertCircle, text: 'Transaction reported, not verified' },
  extra: { cls: 'pv-extra', icon: AlertCircle, text: 'On-chain only (not in this system)' },
}

/**
 * Public, no-login blockchain verification: look up a procurement reference, read
 * its trail from both the system and the Sepolia contract, and optionally check a
 * document you already hold against the hash that was anchored.
 *
 * Everything here is read-only — no wallet, no gas, no account. Contract reads go
 * through a plain JSON-RPC provider; document hashing happens in the browser via
 * WebCrypto, so the file being checked is never uploaded anywhere.
 */
export default function PublicVerifier({ initialCode = '' }) {
  const [code, setCode] = useState(initialCode)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null) // { project, rows, chainReachable, chainError }

  // Document checker
  const [fileName, setFileName] = useState('')
  const [fileHash, setFileHash] = useState('')
  const [hashing, setHashing] = useState(false)

  const lookup = async (e, { deep = false } = {}) => {
    e?.preventDefault()
    const ref = normalizeProcurementCode(code)
    if (!ref) return
    setLoading(true); setError(''); setResult(null); setFileHash(''); setFileName('')
    try {
      const data = await apiPublicAnchors(ref, { deep })
      // Read the contract independently. A failure here (no address configured,
      // RPC rate-limited, offline) must not hide the system's own record — it
      // just means the "verified" column can't be filled in right now.
      let chain = []
      let chainError = ''
      if (isLedgerConfigured()) {
        try {
          // The server's spelling of the code is the on-chain index.
          chain = await readChainTrail(data.code || ref)
        } catch (err) {
          chainError = err?.shortMessage || err?.message || 'Could not reach the Sepolia network.'
        }
      } else {
        chainError = 'No ledger contract is configured for this deployment.'
      }
      setResult({
        project: data,
        rows: mergeTrail(data.anchors || [], chain, { chainReadable: !chainError }),
        chainCount: chain.length,
        chainError,
      })
    } catch (err) {
      setError(err.message || 'Could not look up that reference.')
    } finally {
      setLoading(false)
    }
  }

  const onPickFile = async (file) => {
    if (!file) return
    setHashing(true); setFileName(file.name); setFileHash('')
    try {
      setFileHash(await sha256File(file))
    } catch {
      setError('Could not read that file in this browser.')
    } finally {
      setHashing(false)
    }
  }

  // Does the uploaded file's hash appear anywhere in this procurement's trail,
  // and what may honestly be said about it? (see blockchain/documentCheck.js)
  const docVerdict = fileHash ? documentVerdict(fileHash, result?.rows) : null
  // A match is only a database match. For a public record, also fetch its
  // verification packet and check file → payload → ledger independently.
  const matchedId = docVerdict?.match?.anchorId
  const packetCode = result?.project?.code
  const loadPacket = useCallback(
    () => apiPublicPacket(packetCode, matchedId), [packetCode, matchedId])

  const verifiedCount = (result?.rows || []).filter((r) => r.state === 'verified').length
  const alteredCount = result?.project?.altered_count || 0

  // Opened with a reference (from the landing-page search or a results row):
  // run the lookup straight away. Remounted via `key` when the code changes.
  useEffect(() => {
    if (initialCode) lookup()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="pv" id="verify" style={{ scrollMarginTop: 80 }}>
      <div className="pv-head">
        <div className="pv-title">
          <ShieldCheck size={20} className="pv-title-ico" />
          <div>
            <h2>Verify on the Blockchain</h2>
            <p>
              Enter a procurement reference to replay its entire history from the public Sepolia
              ledger. No account, no wallet, and no fees — this reads the contract directly.
            </p>
          </div>
        </div>
        {isLedgerConfigured() && (
          <a className="pv-contract" href={contractUrl()} target="_blank" rel="noopener noreferrer">
            Contract {LEDGER_ADDRESS.slice(0, 8)}…{LEDGER_ADDRESS.slice(-6)} <ExternalLink size={12} />
          </a>
        )}
      </div>

      <form className="pv-form" onSubmit={lookup}>
        <div className="pv-input-wrap">
          <Search size={16} />
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={`Procurement reference, e.g. ${EXAMPLE_CODE}`}
            aria-label="Procurement reference"
            spellCheck={false}
          />
        </div>
        <button type="submit" className="pv-btn" disabled={loading || !code.trim()}>
          {loading ? <Loader2 size={15} className="pv-spin" /> : <FileSearch size={15} />}
          {loading ? 'Verifying…' : 'Verify'}
        </button>
      </form>

      {!loading && !error && !result && (
        <div className="pv-idle">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>
            Results show every recorded step with its status: <strong className="pv-idle-ok">Verified</strong>,{' '}
            <strong className="pv-idle-pending">Pending</strong> or <strong className="pv-idle-bad">Altered</strong>.
          </span>
        </div>
      )}

      {loading && (
        <div className="pv-loading" role="status" aria-live="polite">
          <Loader2 size={18} className="pv-spin" aria-hidden="true" />
          <div>
            <div className="pv-loading-title">Reading the Sepolia ledger…</div>
            <div className="pv-loading-sub">Replaying every anchored step for {normalizeProcurementCode(code) || 'this reference'}.</div>
          </div>
        </div>
      )}

      {error && <div className="pv-error" role="alert"><AlertCircle size={16} /> {error}</div>}

      {result && (
        <>
          <div className="pv-summary">
            <div className="pv-summary-main">
              <span className="pv-code">{result.project.code}</span>
              <strong>{result.project.name}</strong>
              <span className="pv-muted">{result.project.category || '—'}</span>
            </div>
            <div className="pv-summary-stats">
              <span className={verifiedCount > 0 ? 'pv-chip pv-ok' : 'pv-chip pv-pending'}>
                {verifiedCount} of {result.rows.filter((r) => r.state !== 'extra').length} steps verified on-chain
              </span>
              {/* Re-reads every anchored file and re-hashes it, catching a
                  document swapped after the fact. On demand because it costs a
                  full storage read per step. */}
              <button
                className="pv-deep-btn"
                onClick={() => lookup(null, { deep: true })}
                disabled={loading || result.project.deep_checked}
                title="Re-read every anchored document and re-hash it"
              >
                {result.project.deep_checked ? (
                  <><CheckCircle2 size={12} /> Documents checked</>
                ) : (
                  <><FileSearch size={12} /> Re-check documents</>
                )}
              </button>
              {/* The Notice of Award is public once a procurement is awarded,
                  so anyone can download it and hash it with the checker below. */}
              {result.project.notice_of_award_url && (
                <a className="pv-deep-btn" href={result.project.notice_of_award_url}
                  title="Download the Notice of Award to check it against its recorded hash">
                  <Download size={12} /> Notice of Award
                </a>
              )}
            </div>
          </div>

          {/* The headline finding. A single altered record matters more than
              every step that is still intact, so it goes above the trail. */}
          {alteredCount > 0 && (
            <div className="pv-tamper">
              <ShieldX size={20} />
              <div>
                <strong>
                  {alteredCount} record{alteredCount === 1 ? ' has' : 's have'} been altered since
                  being recorded on the blockchain.
                </strong>
                <p>
                  The details now stored for the step{alteredCount === 1 ? '' : 's'} marked below no
                  longer produce the hash that was published on Sepolia. The blockchain entry itself
                  cannot be changed — so whatever was altered, it was altered afterwards, and this
                  procurement's record can no longer be trusted as issued.
                </p>
              </div>
            </div>
          )}

          {result.chainError && (
            <div className="pv-note">
              <AlertCircle size={14} />
              <span>
                Showing the system's own record only — the Sepolia ledger could not be read
                ({result.chainError}) so on-chain confirmation is unavailable right now.
              </span>
            </div>
          )}

          {result.rows.length === 0 ? (
            <div className="pv-empty">
              Nothing has been recorded for this procurement yet.
            </div>
          ) : (
            <ol className="pv-trail">
              {result.rows.map((r) => {
                const ui = STATE_UI[r.state]
                const Icon = ui.icon
                return (
                  <li className={`pv-step ${ui.cls}`} key={r.key}>
                    <span className="pv-step-dot" />
                    <div className="pv-step-body">
                      <div className="pv-step-top">
                        <span className="pv-step-label">{r.label}</span>
                        <span className="pv-step-chips">
                          {r.superseded && (
                            <span className="pv-chip pv-superseded" title="This document was issued again later; the newer version is the current one.">
                              Superseded
                            </span>
                          )}
                          <span className={`pv-chip ${ui.cls}`}><Icon size={11} /> {ui.text}</span>
                        </span>
                      </div>
                      <div className="pv-step-meta">
                        {r.entityType} · {fmtWhen(r.chainTime || r.recordedAt)}
                        {r.blockNumber ? ` · block ${r.blockNumber}` : ''}
                        {r.actor ? ` · signed by ${r.actor.slice(0, 8)}…${r.actor.slice(-4)}` : ''}
                      </div>
                      {r.integrity?.detail && (
                        <div className={`pv-step-detail ${r.state === 'altered' ? 'pv-bad' : ''}`}>
                          {r.integrity.detail}
                        </div>
                      )}
                      <div className="pv-step-hashes">
                        <span className="pv-hash" title={r.dataHash}>record {shortHash(r.dataHash)}</span>
                        {r.documentHash && (
                          <span className="pv-hash" title={r.documentHash}>
                            document {shortHash(r.documentHash)}
                          </span>
                        )}
                        {r.txHash && (
                          <a className="pv-txlink" href={txUrl(r.txHash)} target="_blank" rel="noopener noreferrer">
                            {shortTx(r.txHash)} <ExternalLink size={11} />
                          </a>
                        )}
                        {r.anchorId != null && result.project?.code && (
                          <Link className="pv-txlink"
                            to={`/public/procurement/${encodeURIComponent(result.project.code)}/record/${r.anchorId}`}>
                            Record details →
                          </Link>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}

          {/* Document checker — hashes locally, compares against the document
              hashes the system reports per step. The file never leaves the browser. */}
          <div className="pv-doccheck">
            <div className="pv-doccheck-head">
              <Upload size={15} />
              <div>
                <strong>Check a document</strong>
                <p>
                  Have a copy of a document from this procurement? Pick it below. Your browser
                  hashes it locally — the file is never uploaded — and compares that hash with the
                  document hashes this system recorded for this procurement’s steps. The blockchain
                  holds each step’s record fingerprint, which includes its document’s hash.
                </p>
              </div>
            </div>
            <label className="pv-file">
              <input
                type="file"
                onChange={(e) => onPickFile(e.target.files?.[0])}
                aria-label="Document to verify"
              />
              <span>{fileName || 'Choose a file…'}</span>
            </label>

            {hashing && <div className="pv-note"><Loader2 size={14} className="pv-spin" /> Hashing locally…</div>}

            {docVerdict && !hashing && (
              <div className={`pv-verdict pv-${docVerdict.tone}`}>
                {docVerdict.tone === 'ok' ? <CheckCircle2 size={17} />
                  : docVerdict.tone === 'bad' ? <XCircle size={17} /> : <AlertCircle size={17} />}
                <div>
                  <strong>{docVerdict.title}</strong>
                  <p className="pv-hash pv-hash-block">{fileHash}</p>
                  <p className="pv-muted">{docVerdict.detail}</p>
                </div>
              </div>
            )}
            {docVerdict?.match && !hashing && matchedId != null && packetCode && (
              <PacketCheck
                key={`${matchedId}-${fileHash}`}
                loadPacket={loadPacket}
                fileHash={fileHash}
                unavailableText={'Independent verification of this record is not public: award and bid '
                  + 'records are confidential, so their verification data is available only to the Admin, '
                  + 'the Head and the winning supplier. The match above is against this system’s database.'}
              />
            )}
          </div>
        </>
      )}
    </section>
  )
}
