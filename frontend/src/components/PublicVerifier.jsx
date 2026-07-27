import { useState } from 'react'
import {
  AlertCircle, CheckCircle2, ExternalLink, FileSearch, Loader2, Search,
  ShieldCheck, ShieldX, Upload, XCircle,
} from 'lucide-react'

import { apiPublicAnchors } from '../api'
import { readChainTrail, sha256File } from '../blockchain/anchor'
import { contractUrl, isLedgerConfigured, txUrl, LEDGER_ADDRESS } from '../blockchain/contract'
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
function mergeTrail(dbAnchors, chainAnchors) {
  const remaining = [...chainAnchors]
  const rows = dbAnchors.map((a) => {
    const i = remaining.findIndex(
      (c) => c.dataHash?.toLowerCase() === a.data_hash?.toLowerCase(),
    )
    const onChain = i >= 0 ? remaining.splice(i, 1)[0] : null
    return {
      key: `db-${a.stage}-${a.data_hash}`,
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
      // 'altered'   — the live record no longer hashes to what was published.
      //               Checked first: it outranks everything else.
      // 'verified'  — the hash is on the public ledger, matching exactly.
      // 'pending'   — recorded here, never anchored (no wallet/gas at the time).
      // 'unmatched' — anchored per our DB, but not found on the ledger.
      state:
        a.integrity?.status === 'mismatch' ? 'altered'
        : onChain ? 'verified'
        : a.anchored ? 'unmatched'
        : 'pending',
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
export default function PublicVerifier() {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null) // { project, rows, chainReachable, chainError }

  // Document checker
  const [fileName, setFileName] = useState('')
  const [fileHash, setFileHash] = useState('')
  const [hashing, setHashing] = useState(false)

  const lookup = async (e, { deep = false } = {}) => {
    e?.preventDefault()
    const ref = code.trim().toUpperCase()
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
          chain = await readChainTrail(ref)
        } catch (err) {
          chainError = err?.shortMessage || err?.message || 'Could not reach the Sepolia network.'
        }
      } else {
        chainError = 'No ledger contract is configured for this deployment.'
      }
      setResult({
        project: data,
        rows: mergeTrail(data.anchors || [], chain),
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

  // Does the uploaded file's hash appear anywhere in this procurement's trail?
  const docMatch = fileHash
    ? (result?.rows || []).find(
        (r) => r.documentHash && r.documentHash.toLowerCase() === fileHash.toLowerCase(),
      )
    : null

  const verifiedCount = (result?.rows || []).filter((r) => r.state === 'verified').length
  const alteredCount = result?.project?.altered_count || 0

  return (
    <section className="pv">
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
            placeholder="Procurement reference, e.g. P-2026-001"
            aria-label="Procurement reference"
            spellCheck={false}
          />
        </div>
        <button type="submit" className="pv-btn" disabled={loading || !code.trim()}>
          {loading ? <Loader2 size={15} className="pv-spin" /> : <FileSearch size={15} />}
          {loading ? 'Verifying…' : 'Verify'}
        </button>
      </form>

      {error && <div className="pv-error"><AlertCircle size={16} /> {error}</div>}

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
                        <span className={`pv-chip ${ui.cls}`}><Icon size={11} /> {ui.text}</span>
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
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}

          {/* Document checker — hashes locally, compares against the anchored
              document hash. The file never leaves the browser. */}
          <div className="pv-doccheck">
            <div className="pv-doccheck-head">
              <Upload size={15} />
              <div>
                <strong>Check a document</strong>
                <p>
                  Have a copy of a document from this procurement? Pick it below. Your browser
                  hashes it locally — the file is never uploaded — and compares that hash with the
                  one recorded on the blockchain.
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

            {fileHash && !hashing && (
              <div className={`pv-verdict ${docMatch ? 'pv-ok' : 'pv-bad'}`}>
                {docMatch ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
                <div>
                  <strong>
                    {docMatch
                      ? `Match — this is the document recorded at "${docMatch.label}".`
                      : 'No match in this procurement’s trail.'}
                  </strong>
                  <p className="pv-hash pv-hash-block">{fileHash}</p>
                  <p className="pv-muted">
                    {docMatch
                      ? docMatch.state === 'verified'
                        ? 'That step is confirmed on the Sepolia ledger, so this file is provably the one attested to.'
                        : 'That step is recorded in the system but not yet anchored on-chain.'
                      : 'Either this file is not part of this procurement, or it has been modified since it was recorded — even a single changed byte produces a completely different hash.'}
                  </p>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
