// The record details page: one blockchain record (anchor) in full — which
// procurement and document version it vouches for, every piece of chain
// evidence the server holds, the document's version history, and an
// independent check of a chosen file against exactly this record.
//
// Everything comes from GET .../anchors/{id}/ (procurement/anchor_detail.py),
// which the SERVER scopes to the viewer. The independent check runs in this
// browser (PacketCheck → packetVerify) and only when the server says this
// viewer may have the record's packet. A database row or a stored "verified"
// flag never turns anything green here: only PacketCheck's own result does.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  AlertCircle, AlertTriangle, ArrowLeft, Database, Download, ExternalLink, FileText,
  Fingerprint, History, Link2, Search, Shield, ShieldX, Upload,
} from 'lucide-react'

import { apiProjectAnchorDetail, apiProjectPacket, apiPublicAnchorDetail, apiPublicPacket } from '../api'
import { sha256File } from '../blockchain/fileHash'
import { chainRows, evidenceBanner, legacyDocumentNote, outcomeChip, payloadNotStored, recordTime, txLink, versionLabel } from '../blockchain/recordView'
import PacketCheck from './PacketCheck'
import { PublicBackBar, PublicNav } from './PublicShell'
import CopyHash from './ui/CopyHash'
import EmptyState from './ui/EmptyState'
import InfoTip from './ui/InfoTip'
import MoreInfo from './ui/MoreInfo'
import StatusBadge from './ui/StatusBadge'
import { Skeleton } from './Skeleton'
import { normalizeProcurementCode } from '../utils/procurementCode'
import PreviewButton from './ui/FilePreview'
import '../style/PublicResultsPage.css'
import '../style/procurement-record.css'
import '../style/record-detail.css'

const EVIDENCE_ICON = { info: Link2, warn: Database, bad: ShieldX }

function ChainList({ detail }) {
  return (
    <dl className="rd-dl">
      {chainRows(detail).map((r) => (
        <div key={r.key} className="rd-dl-row">
          <dt>{r.label}</dt>
          <dd>
            {r.value == null ? (
              <span className="rd-missing">{r.missing}</span>
            ) : r.href ? (
              <a className="pr-link rd-mono" href={r.href} target="_blank" rel="noopener noreferrer">
                {r.value} <ExternalLink size={11} />
              </a>
            ) : (
              <span className={r.mono ? 'rd-mono' : ''}>{r.time ? recordTime(detail.viewer, r.value) : r.value}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function VersionsTable({ detail, recordHref }) {
  const { record } = detail
  if (!detail.versions.length) return null
  // Newest first; earlier versions stay listed for the audit trail.
  const versions = [...detail.versions].sort((a, b) => (b.number || 0) - (a.number || 0))
  const latest = versions[0]?.number
  return (
    <section className="rf-card" aria-labelledby="rd-versions-h">
      <div className="rf-card-head"><div>
        <h3 id="rd-versions-h"><History size={15} /> Document versions</h3>
        <p>Newest first. Earlier versions are kept, and each fingerprinted issue is its own blockchain record.</p>
      </div></div>
      <div className="rf-card-body rd-table-wrap">
        <table className="rd-table">
          <thead>
            <tr><th>Version</th><th>Issued</th><th>Document SHA-256</th><th>Blockchain record</th><th>File</th></tr>
          </thead>
          <tbody>
            {versions.map((v) => {
              const here = v.anchor_id === record.id
              return (
                <tr key={`${v.anchor_id}-${v.number}`} className={here ? 'is-here' : ''}>
                  <td>
                    <strong>{versionLabel(v)}</strong>
                    {v.number === latest && <span className="pr-chip pr-chip-db rd-here">Current</span>}
                    {here && <span className="pr-chip pr-chip-info rd-here">Viewing</span>}
                  </td>
                  <td>{v.issued_at ? recordTime(detail.viewer, v.issued_at) : <span className="rd-missing">Unknown</span>}</td>
                  <td>{v.document_hash ? <CopyHash value={v.document_hash} /> : (
                    <span className="rd-missing">{detail.viewer === 'public' && record.entity_type === 'BID' ? 'Not shown publicly' : 'Not recorded'}</span>
                  )}</td>
                  <td>
                    {!v.fingerprinted ? (
                      <span className="pr-chip pr-chip-db"><Database size={11} /> Not fingerprinted</span>
                    ) : here ? (
                      <span className="pr-muted pr-small">This record</span>
                    ) : (
                      <Link className="pr-link" to={recordHref(v.anchor_id)}>View record #{v.anchor_id}</Link>
                    )}
                  </td>
                  <td>
                    {v.file_url ? (
                      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                        <PreviewButton url={v.file_url} name={v.file_name || versionLabel(v)} className="pr-link" />
                        <a className="pr-link" href={v.file_url}><Download size={12} /> {v.file_name || 'Download'}</a>
                      </span>
                    ) : (
                      <span className="rd-missing" title={v.file_note}>{v.file_note || 'Not available'}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** What the server checked for this answer, and what stays unverified. Never green. */
function CheckedPanel({ verification, completeness }) {
  if (!verification) return null
  return (
    <section className="rf-card" aria-labelledby="rd-checked-h">
      <div className="rf-card-head"><div>
        <h3 id="rd-checked-h"><Search size={15} /> What was checked</h3>
        <p>The server’s account of this record. A transaction hash alone is not proof.</p>
      </div></div>
      <div className="rf-card-body">
        <span className={`pr-chip ${outcomeChip(verification)}`}>{verification.headline}</span>
        {completeness?.label && <p className="pr-muted pr-small">Five-document evidence recorded: {completeness.label}</p>}
        {verification.historical && (
          <dl className="rd-history">
            <dt>Original fingerprint check</dt>
            <dd>{verification.historical.original_detail}</dd>
            <dt>Historical version evidence</dt>
            <dd>{verification.historical.explanation}</dd>
          </dl>
        )}
        <MoreInfo summary="Show each check, and what this does not verify">
          <ul className="rd-checks">
            {verification.checked.map((c) => (
              <li key={c.key} className={`rd-check rd-check-${c.status}`}>
                <strong>{c.label}</strong>
                <span>{c.detail}</span>
              </li>
            ))}
          </ul>
          <p className="pr-small rd-checked-note"><strong>Not verified by this answer</strong></p>
          <ul className="rd-unverified">
            {verification.unverified.map((text) => <li key={text}>{text}</li>)}
          </ul>
        </MoreInfo>
      </div>
    </section>
  )
}

function VerifyPanel({ detail, loadPacket }) {
  const [fileHash, setFileHash] = useState(null)
  const [fileName, setFileName] = useState('')
  const [hashing, setHashing] = useState(false)
  const [error, setError] = useState('')
  const doc = detail.document
  const version = doc?.version
  const input = useRef(null)
  const latest = useRef(0)   // the newest selection: an earlier file still hashing must lose

  // Any change forgets the previous file first, so its result can't outlive it: a
  // cancelled dialog, a file that can't be read, or a new choice still being hashed.
  const forget = () => { latest.current += 1; setFileHash(null); setFileName(''); setError(''); setHashing(false) }
  const clear = () => { forget(); if (input.current) input.current.value = '' }
  const pick = async (file) => {
    forget()
    if (!file) return
    const mine = latest.current
    setHashing(true); setFileName(file.name)
    try {
      const hash = await sha256File(file)
      if (mine === latest.current) setFileHash(hash)
    } catch {
      if (mine === latest.current) { setFileName(''); setError('This browser could not read that file.') }
    } finally {
      if (mine === latest.current) setHashing(false)
    }
  }

  return (
    <section className="rf-card" aria-labelledby="rd-verify-h">
      <div className="rf-card-head"><div>
        <h3 id="rd-verify-h"><Shield size={15} /> Verify independently</h3>
        <p>
          {doc
            ? <>Checks a file against <strong>exactly this record</strong>{version ? ` (${versionLabel(version)})` : ''}, reading Sepolia from this browser, not from the server.</>
            : 'This record has no document. Its fingerprint can still be checked against Sepolia.'}
        </p>
      </div></div>
      <div className="rf-card-body">
        {!detail.packet_available ? (
          <div className="rd-note">
            <AlertCircle size={15} />
            <span>
              {detail.packet_unavailable_reason === 'missing_payload'
                ? 'MISSING EVIDENCE: this record’s data (its payload) is not stored here, so nobody can recompute its fingerprint. The chain evidence above can be inspected, but the document cannot be proven to belong to it.'
                : detail.viewer === 'public'
                  ? 'The public can’t verify this record independently: its data is available only to the Admin, the Head and the winning supplier. The evidence above is what the server reports.'
                  : 'Your account can’t verify this record independently: its data is reserved for the Admin, the Head and the winning supplier. The evidence above is what the server reports.'}
            </span>
          </div>
        ) : (
          <>
            {doc && (
              <label className="rd-file">
                <Upload size={14} />
                <input ref={input} type="file" onChange={(e) => pick(e.target.files?.[0])} aria-label="Document to verify against this record" />
                <span>{fileName || `Choose the ${doc.label} file to check…`}</span>
              </label>
            )}
            {fileName && (
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={clear}>Clear selected file</button>
            )}
            <p className="pr-muted pr-small">
              {doc ? 'The file is hashed in your browser, never uploaded. ' : ''}
              {fileHash ? <>File SHA-256: <span className="rd-mono">{fileHash}</span></> : doc ? 'With no file, only the record is checked.' : ''}
            </p>
            {error && <div className="rd-note rd-note-bad"><AlertTriangle size={15} /> {error}</div>}
            {!hashing && (
              <PacketCheck key={fileHash || 'record-only'} loadPacket={loadPacket} fileHash={fileHash}
                unavailableText="No verification data is available for this record." />
            )}
          </>
        )}
      </div>
    </section>
  )
}

export function AnchorDetailView({ detail, loadPacket, recordHref, backTo, backLabel }) {
  const navigate = useNavigate()
  const { procurement: p, record: rec, document: doc } = detail
  const ev = evidenceBanner(detail)
  const EvIcon = EVIDENCE_ICON[ev.tone]
  const integrity = detail.integrity?.status
  const supersededBy = rec.superseded_by
  const options = useMemo(() => detail.records.map((r) => ({
    id: r.id,
    text: `${r.stage_label}${r.document_label ? ` — ${r.document_label}` : ''}${r.issues > 1 ? ` (issue ${r.issue} of ${r.issues})` : ''}`,
  })), [detail.records])

  return (
    <div className="rd">
      <div className="rd-top">
        {backTo ? <Link className="ui-btn ui-btn--ghost ui-btn--sm" to={backTo}><ArrowLeft size={14} /> {backLabel}</Link> : <span />}
        <label className="rd-select">
          <span>Record</span>
          <select value={rec.id} onChange={(e) => navigate(recordHref(e.target.value))}
            aria-label="Choose another blockchain record of this procurement">
            {options.map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}
          </select>
        </label>
      </div>

      <section className="rf-card">
        <div className="rf-card-body rd-head">
          <div className="pr-title-row">
            <h2 className="pr-title">{rec.stage_label}</h2>
            <StatusBadge domain="project" status={p.status} />
          </div>
          <div className="pr-meta">
            <span>{p.name}</span>
            <span className="rf-code">{p.code}</span>
            {p.id != null && <span>Procurement ID {p.id}</span>}
            <span>Record #{rec.id}</span>
            <span>{recordTime(detail.viewer, rec.created_at)}</span>
          </div>
        </div>
      </section>

      <div className={`rd-evidence rd-tone-${ev.tone}`} role="status">
        <EvIcon size={18} />
        <div>
          <strong>{ev.title}</strong>
          <p>{detail.evidence_text}</p>
          {integrity === 'mismatch' && !legacyDocumentNote(detail.verification) && !payloadNotStored(detail.verification) && (
            <p className="rd-warn"><AlertTriangle size={13} /> The data stored for this record now differs from what was fingerprinted. {detail.integrity.detail}</p>
          )}
          {supersededBy && (
            <p>This document was issued again later. <Link className="pr-link" to={recordHref(supersededBy)}>View the newer record #{supersededBy}</Link></p>
          )}
          {detail.evidence === 'verified' && (
            <p className="pr-small">This is the server’s check, not proof. Only the independent check below can show green, and only with complete evidence and a matching document.</p>
          )}
        </div>
      </div>

      <div className="pr-grid">
        <section className="rf-card" aria-labelledby="rd-doc-h">
          <div className="rf-card-head"><div><h3 id="rd-doc-h"><FileText size={15} /> Document</h3></div></div>
          <div className="rf-card-body">
            {!doc ? (
              <p className="pr-muted pr-small">No document. This record fingerprints its data only.</p>
            ) : (
              <dl className="rd-dl">
                <div className="rd-dl-row"><dt>Document</dt><dd><strong>{doc.label}</strong></dd></div>
                <div className="rd-dl-row"><dt>File</dt><dd>
                  {doc.file_name || <span className="rd-missing">{detail.viewer === 'public' ? 'Not shown publicly' : 'Not available to you'}</span>}
                  {doc.file_type && <span className="pr-chip pr-chip-db rd-type">{doc.file_type}</span>}
                </dd></div>
                <div className="rd-dl-row"><dt>Version</dt><dd>
                  {doc.version ? (
                    <span className={`pr-chip ${doc.version.current ? 'pr-chip-info' : 'pr-chip-warn'}`}>{versionLabel(doc.version)}</span>
                  ) : <span className="rd-missing">Unknown</span>}
                </dd></div>
                <div className="rd-dl-row"><dt>Download</dt><dd>
                  {doc.version?.file_url
                    ? <a className="pr-link" href={doc.version.file_url}><Download size={12} /> Download this version</a>
                    : <span className="rd-missing">{doc.version?.file_note || 'Not available'}</span>}
                </dd></div>
                <div className="rd-dl-row"><dt>Document SHA-256{' '}
                  <InfoTip label="About the document hash" text="The fingerprint of the file’s exact bytes. It is stored inside the record’s data, not on the blockchain by itself." />
                </dt><dd>
                  {rec.document_hash ? <CopyHash value={rec.document_hash} /> : (
                    <span className="rd-missing">
                      {detail.viewer === 'public' && rec.entity_type === 'BID' ? 'Not shown publicly (bid document)' : 'Not recorded for this record'}
                    </span>
                  )}
                </dd></div>
              </dl>
            )}
          </div>
        </section>

        <section className="rf-card" aria-labelledby="rd-chain-h">
          <div className="rf-card-head"><div><h3 id="rd-chain-h"><Link2 size={15} /> Blockchain evidence</h3></div></div>
          <div className="rf-card-body">
            <ChainList detail={detail} />
            <div className="rd-dl-row rd-fp">
              <dt><Fingerprint size={13} /> Record fingerprint (dataHash){' '}
                <InfoTip label="About the record fingerprint" text="SHA-256 of this record’s data, which includes the document’s SHA-256. This is the value written to the smart contract." />
              </dt>
              <dd><CopyHash value={rec.data_hash} /></dd>
            </div>
            {txLink(rec.tx_hash) && (
              <a className="ui-btn ui-btn--secondary ui-btn--sm" href={txLink(rec.tx_hash)} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={13} /> Open transaction on Etherscan
              </a>
            )}
          </div>
        </section>
      </div>

      <CheckedPanel verification={detail.verification} completeness={detail.integrity?.completeness} />
      <VerifyPanel key={rec.id} detail={detail} loadPacket={loadPacket} />
      <VersionsTable detail={detail} recordHref={recordHref} />
    </div>
  )
}

function DetailState({ detail, error, children }) {
  if (error) {
    return (
      <div className="rf-card"><EmptyState icon={Search} title="Blockchain record not available"
        description={/not found/i.test(error) ? 'It does not exist, or you may not view it.' : error} /></div>
    )
  }
  if (!detail) {
    return (
      <div className="rf-card"><div className="rf-card-body">
        <Skeleton width="40%" height={20} /><Skeleton width="70%" style={{ marginTop: 10 }} />
        <Skeleton width="100%" height={120} style={{ marginTop: 20 }} />
      </div></div>
    )
  }
  return children
}

/** /admin|head|supplier/record/:id/anchor/:anchorId */
export function ProjectAnchorDetailPage({ className = '' }) {
  const { id, anchorId } = useParams()
  const { pathname } = useLocation()
  const base = pathname.replace(/\/anchor\/[^/]+\/?$/, '')
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setDetail(null); setError('')
    apiProjectAnchorDetail(id, anchorId)
      .then((d) => { if (live) setDetail(d) })
      .catch((e) => { if (live) setError(e.message || 'Could not load this record.') })
    return () => { live = false }
  }, [id, anchorId])

  const loadPacket = useCallback(() => apiProjectPacket(id, anchorId), [id, anchorId])
  const recordHref = useCallback((aid) => `${base}/anchor/${aid}`, [base])

  return (
    <div className={`pr-page rf-home ${className}`}>
      <DetailState detail={detail} error={error}>
        {detail && <AnchorDetailView detail={detail} loadPacket={loadPacket} recordHref={recordHref}
          backTo={base} backLabel="Back to procurement record" />}
      </DetailState>
    </div>
  )
}

/** /public/procurement/:code/record/:anchorId — no login. */
export function PublicAnchorDetailPage() {
  const { code: raw, anchorId } = useParams()
  const code = normalizeProcurementCode(raw)
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setDetail(null); setError('')
    apiPublicAnchorDetail(code, anchorId)
      .then((d) => { if (live) setDetail(d) })
      .catch((e) => { if (live) setError(e.message || 'Could not load this record.') })
    return () => { live = false }
  }, [code, anchorId])

  const loadPacket = useCallback(() => apiPublicPacket(code, anchorId), [code, anchorId])
  const recordHref = useCallback((aid) => `/public/procurement/${encodeURIComponent(code)}/record/${aid}`, [code])

  return (
    <div className="pub">
      <PublicNav />
      <PublicBackBar parent={{ to: `/public/procurement/${encodeURIComponent(code)}`, label: code }} />
      <main className="pub-main pub-main--detail rf-home">
        <h1 className="sr-only">Blockchain record of {code}</h1>
        <DetailState detail={detail} error={error}>
          {detail && <AnchorDetailView detail={detail} loadPacket={loadPacket} recordHref={recordHref} />}
        </DetailState>
      </main>
    </div>
  )
}
