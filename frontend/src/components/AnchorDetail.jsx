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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  AlertCircle, AlertTriangle, ArrowLeft, Database, Download, ExternalLink, Eye, FileText,
  Fingerprint, History, Link2, Search, Shield, ShieldX, Upload,
} from 'lucide-react'

import { apiProjectAnchorDetail, apiProjectPacket, apiPublicAnchorDetail, apiPublicPacket } from '../api'
import { sha256File } from '../blockchain/anchor'
import { chainRows, evidenceBanner, txLink, versionLabel } from '../blockchain/recordView'
import PacketCheck from './PacketCheck'
import CopyHash from './ui/CopyHash'
import EmptyState from './ui/EmptyState'
import StatusBadge from './ui/StatusBadge'
import { Skeleton } from './Skeleton'
import { fmtDateTime } from '../utils/format'
import { normalizeProcurementCode } from '../utils/procurementCode'
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
              <span className={r.mono ? 'rd-mono' : ''}>{r.time ? fmtDateTime(r.value) : r.value}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function VersionsTable({ detail, recordHref }) {
  const { versions, record } = detail
  if (!versions.length) return null
  return (
    <section className="rf-card" aria-labelledby="rd-versions-h">
      <div className="rf-card-head"><div>
        <h3 id="rd-versions-h"><History size={15} /> Document versions</h3>
        <p>Every issue of this document, oldest first. Each fingerprinted issue is its own blockchain record — pick one to inspect or verify it.</p>
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
                    {here && <span className="pr-chip pr-chip-info rd-here">Viewing</span>}
                  </td>
                  <td>{v.issued_at ? fmtDateTime(v.issued_at) : <span className="rd-missing">Unknown</span>}</td>
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
                      <a className="pr-link" href={v.file_url}><Download size={12} /> {v.file_name || 'Download'}</a>
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

function VerifyPanel({ detail, loadPacket }) {
  const [fileHash, setFileHash] = useState(null)
  const [fileName, setFileName] = useState('')
  const [hashing, setHashing] = useState(false)
  const [error, setError] = useState('')
  const doc = detail.document
  const version = doc?.version

  const pick = async (file) => {
    if (!file) return
    setHashing(true); setError(''); setFileName(file.name)
    try { setFileHash(await sha256File(file)) } catch { setError('This browser could not read that file.') }
    finally { setHashing(false) }
  }

  return (
    <section className="rf-card" aria-labelledby="rd-verify-h">
      <div className="rf-card-head"><div>
        <h3 id="rd-verify-h"><Shield size={15} /> Verify independently</h3>
        <p>
          {doc
            ? <>Checks a file against <strong>exactly this record</strong>{version ? ` (${versionLabel(version)})` : ''}: the file’s SHA-256, the stored payload, its fingerprint, and the record on Sepolia — read by this browser, not taken from the server.</>
            : 'This record does not fingerprint a document. Its fingerprint can still be checked against Sepolia.'}
        </p>
      </div></div>
      <div className="rf-card-body">
        {!detail.packet_available ? (
          <div className="rd-note">
            <AlertCircle size={15} />
            <span>
              {detail.packet_unavailable_reason === 'missing_payload'
                ? 'UNCONFIRMED — this record’s data (its payload) is not stored in this system, so nobody can recompute its fingerprint. The chain evidence above can be inspected, but the document cannot be proven to belong to it.'
                : detail.viewer === 'public'
                  ? 'This record cannot be verified independently by the public: its data includes confidential award or bid details, available only to the Admin, the Head and the winning supplier. The evidence above is what the server reports.'
                  : 'Your account cannot verify this record independently: its data includes details reserved for the Admin, the Head and the winning supplier. The evidence above is what the server reports.'}
            </span>
          </div>
        ) : (
          <>
            {doc && (
              <label className="rd-file">
                <Upload size={14} />
                <input type="file" onChange={(e) => pick(e.target.files?.[0])} aria-label="Document to verify against this record" />
                <span>{fileName || `Choose the ${doc.label} file to check…`}</span>
              </label>
            )}
            <p className="pr-muted pr-small">
              {doc ? 'The file is hashed in your browser and never uploaded. ' : ''}
              {fileHash ? <>File SHA-256: <span className="rd-mono">{fileHash}</span></> : doc ? 'Until a file is chosen, only the record itself is checked.' : ''}
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
        {backTo && <Link className="ui-btn ui-btn--ghost ui-btn--sm" to={backTo}><ArrowLeft size={14} /> {backLabel}</Link>}
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
            <span>Record #{rec.id} in this system</span>
            <span>{fmtDateTime(rec.created_at)}</span>
          </div>
        </div>
      </section>

      <div className={`rd-evidence rd-tone-${ev.tone}`} role="status">
        <EvIcon size={18} />
        <div>
          <strong>{ev.title}</strong>
          <p>{detail.evidence_text}</p>
          {integrity === 'mismatch' && (
            <p className="rd-warn"><AlertTriangle size={13} /> The data stored for this record now differs from what was fingerprinted. {detail.integrity.detail}</p>
          )}
          {supersededBy && (
            <p>This document was issued again later. <Link className="pr-link" to={recordHref(supersededBy)}>View the newer record #{supersededBy}</Link></p>
          )}
          {detail.evidence === 'verified' && (
            <p className="pr-small">This is the server’s check, not proof on its own. Only the independent check below — run in your browser against Sepolia — can show <strong>VERIFIED — MATCH</strong>.</p>
          )}
        </div>
      </div>

      <div className="pr-grid">
        <section className="rf-card" aria-labelledby="rd-doc-h">
          <div className="rf-card-head"><div><h3 id="rd-doc-h"><FileText size={15} /> Document</h3>
            <p>The file this record fingerprints</p></div></div>
          <div className="rf-card-body">
            {!doc ? (
              <p className="pr-muted pr-small">This record has no document. It fingerprints the record’s data only.</p>
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
                <div className="rd-dl-row"><dt>Document SHA-256</dt><dd>
                  {rec.document_hash ? <CopyHash value={rec.document_hash} /> : (
                    <span className="rd-missing">
                      {detail.viewer === 'public' && rec.entity_type === 'BID' ? 'Not shown publicly (bid document)' : 'Not recorded for this record'}
                    </span>
                  )}
                  <small className="rd-explain">The fingerprint of the file’s exact bytes. It is stored inside the record’s data, not on the blockchain by itself.</small>
                </dd></div>
              </dl>
            )}
          </div>
        </section>

        <section className="rf-card" aria-labelledby="rd-chain-h">
          <div className="rf-card-head"><div><h3 id="rd-chain-h"><Link2 size={15} /> Blockchain evidence</h3>
            <p>What the server holds about this record on Sepolia</p></div></div>
          <div className="rf-card-body">
            <ChainList detail={detail} />
            <div className="rd-dl-row rd-fp">
              <dt><Fingerprint size={13} /> Record fingerprint (dataHash)</dt>
              <dd>
                <CopyHash value={rec.data_hash} />
                <small className="rd-explain">SHA-256 of this record’s data (which includes the document’s SHA-256). This is the value written to the smart contract.</small>
              </dd>
            </div>
            {txLink(rec.tx_hash) && (
              <a className="ui-btn ui-btn--secondary ui-btn--sm" href={txLink(rec.tx_hash)} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={13} /> Open transaction on Etherscan
              </a>
            )}
          </div>
        </section>
      </div>

      <VerifyPanel detail={detail} loadPacket={loadPacket} />
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
          backTo={base} backLabel="Back to the procurement record" />}
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
      <nav className="pub-nav">
        <Link to="/" className="lp-logo">
          <span className="lp-logo-icon"><Shield size={18} /></span>
          <div>
            <div className="lp-logo-name">E-Procurement</div>
            <div className="lp-logo-sub">Blockchain System</div>
          </div>
        </Link>
        <div className="pub-nav-right">
          <Link to={`/public/procurement/${encodeURIComponent(code)}`} className="pub-back"><ArrowLeft size={15} /> {code}</Link>
        </div>
      </nav>
      <header className="pub-header">
        <div className="pub-badge"><Eye size={14} /> Public View</div>
        <h1>Blockchain record</h1>
        <p>One step of this procurement, its evidence on Sepolia, and an independent check you can run in this browser.</p>
      </header>
      <main className="pub-main rf-home">
        <DetailState detail={detail} error={error}>
          {detail && <AnchorDetailView detail={detail} loadPacket={loadPacket} recordHref={recordHref}
            backTo={`/public/procurement/${encodeURIComponent(code)}`} backLabel="Back to the procurement" />}
        </DetailState>
      </main>
    </div>
  )
}
