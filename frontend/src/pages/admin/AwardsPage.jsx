import { useState, useEffect, useRef, useMemo } from 'react'
import { useDebouncedValue } from '../../utils/useDebouncedValue'
import { ws, useBacStatus, canPrepare } from '../../utils/workspace'
import { Link } from 'react-router-dom'
import {
  Calendar, Award, BarChart2, Search, FileText, Info, Upload, ShieldCheck, Link2, Loader2,
} from 'lucide-react'
import { apiListAwards, apiUploadAwardDocument, apiGenerateAwardDocument } from '../../api'
import { Skeleton, TableSkeleton } from '../../components/Skeleton'
import { getCached, loadCached, updateCached } from '../../utils/sessionCache'
import StatusBadge from '../../components/ui/StatusBadge'
import { TableEmpty } from '../../components/ui/EmptyState'
import { signingBlocked } from '../../blockchain/signingState'
import { runAnchor } from '../../blockchain/anchorStore'
import { ANCHOR_STATES, anchorState } from '../../blockchain/anchorState'
import MoreInfo from '../../components/ui/MoreInfo'
import { prefetchRecord } from '../../components/ProcurementRecord'
import PreviewButton from '../../components/ui/FilePreview'
import {
  AWARDS_CACHE, RefCode, Toast, fmtDate, peso, workspaceRole,
} from './shared'

// ── Awards Page ───────────────────────────────────────────────────────────────

// One post-award document cell: upload it if it hasn't been issued, or open it
// (with its blockchain state) once it has. Re-uploading is allowed and appends a
// NEW anchor rather than rewriting the old one, so a replacement is visible in
// the trail instead of silently overwriting history.
function AwardDocButton({ award, doc, busy, onUpload, onGenerate, onAnchor, readOnly = false }) {
  const inputRef = useRef(null)
  const issued = !!doc.url
  const shortLabel = doc.label.replace(/ \(.*\)/, '')

  const pick = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''   // let the same file be re-picked after an error
    if (file) onUpload(award, doc, file)
  }

  const issuedOn = doc.issued_at ? fmtDate(doc.issued_at) : ''
  const chainState = anchorState(doc.anchor)

  return (
    <div className={`ad-award-doc${issued ? ' is-issued' : ''}${issued && chainState === 'verified' ? ' is-onchain' : ''}`}>
      {/* Must match validate_upload on the backend (PDF/JPG/PNG, 5 MB) — an
          accept list that offers more than the server takes just invites an
          error at the end of the upload. */}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png"
        style={{ display: 'none' }}
        onChange={pick}
        aria-hidden="true"
        tabIndex={-1}
      />
      {issued ? (
        <>
          <a className="ad-award-doc-name" href={doc.url} target="_blank" rel="noreferrer"
            title={`Issued ${issuedOn} — click to open`}>
            <FileText size={13} aria-hidden="true" /> <span>{shortLabel}</span>
          </a>
          <PreviewButton url={doc.url} name={doc.label} className="ui-icon-btn ad-award-doc-upload" iconOnly />
          {chainState === 'verified' || chainState === 'reported' ? (
            <a
              className={`ad-award-doc-chain${chainState === 'verified' ? ' is-anchored' : ''}`}
              href={doc.explorer_url}
              target="_blank"
              rel="noreferrer"
              title={`${ANCHOR_STATES[chainState].text} (tx ${doc.tx_hash})`}
              aria-label={`${shortLabel}: ${ANCHOR_STATES[chainState].text} — view transaction`}
            >
              {chainState === 'verified' ? <><ShieldCheck size={11} /> Confirmed</> : <><Link2 size={11} /> Tx reported</>}
            </a>
          ) : (
            // The document is saved either way — this only completes the
            // optional on-chain step, re-signing the SAME hash. Declining
            // MetaMask earlier is never a dead end.
            <button
              className="ad-award-doc-chain is-retry"
              onClick={() => onAnchor(award, doc)}
              disabled={!doc.anchor || !!signingBlocked(doc.anchor)}
              title={!doc.anchor ? 'No anchor was recorded for this document'
                : signingBlocked(doc.anchor) || 'Record this document on the blockchain'}
            >
              <Link2 size={11} /> {doc.anchor && !signingBlocked(doc.anchor) ? 'Anchor now' : 'Not anchored'}
            </button>
          )}
          {/* Replace the generated notice with the signed scan once it comes
              back. Appends a new anchor, so both versions stay in the trail. */}
          {!readOnly && <button
            className="ui-icon-btn ad-award-doc-upload"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            data-tip="Replace with signed copy"
            data-tip-align="end"
            aria-label={`Replace ${shortLabel} with the signed copy`}
          >
            {busy ? <Loader2 size={13} className="ui-spin" /> : <Upload size={13} />}
          </button>}
        </>
      ) : (
        // Not issued yet: generate it from the award record (the normal path —
        // nothing to retype, and the notice can't disagree with the award), or
        // upload an already-signed copy.
        <>
          <span className="ad-award-doc-name is-missing">
            <FileText size={13} aria-hidden="true" /> <span>{shortLabel}</span>
          </span>
          <span className="ad-award-doc-chain is-pending">Pending</span>
          {!readOnly && <>
          <button className="ad-award-doc-gen" disabled={busy} onClick={() => onGenerate(award, doc)}>
            {busy ? <><Loader2 size={12} className="ui-spin" /> Working…</> : <>Generate</>}
          </button>
          <button
            className="ui-icon-btn ad-award-doc-upload"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            data-tip="Upload a signed copy instead"
            data-tip-align="end"
            aria-label={`Upload a signed copy of ${shortLabel}`}
          >
            <Upload size={13} />
          </button>
          </>}
        </>
      )}
    </div>
  )
}
export default function AwardsPage() {
  const { workflow_enabled: workflowOn } = useBacStatus()
  // A revisit shows the last list at once; the effect below refreshes it.
  const [awards, setAwards] = useState(() => getCached(AWARDS_CACHE) || [])
  const [loading, setLoading] = useState(() => getCached(AWARDS_CACHE) === undefined)
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search)
  const [busyDoc, setBusyDoc] = useState(null)   // `${awardId}:${key}` while uploading
  const [toast, setToast] = useState(null)

  const load = () => loadCached(AWARDS_CACHE, apiListAwards).then(setAwards).catch(() => {})

  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [])

  // Upload the signed document, then anchor it. The upload is what matters —
  // anchoring is the optional on-chain witness and is deliberately not awaited,
  // so a declined MetaMask prompt never looks like a failed upload.
  const issueDoc = async (award, doc, run, verb) => {
    setBusyDoc(`${award.id}:${doc.key}`)
    try {
      const updated = await run()
      const merge = (list) => list.map(a => (a.id === updated.id ? updated : a))
      setAwards(merge)
      // Coming back to this page must not show the document as still missing.
      updateCached(AWARDS_CACHE, merge)
      setToast({ type: 'success', message: `${doc.label} issued for ${award.project_name}.` })
      if (updated.anchor) {
        runAnchor(updated.anchor, { label: `${updated.project_code} · ${doc.label}` })
      }
    } catch (e) {
      setToast({ type: 'error', message: e.message || `Could not ${verb} the ${doc.label}.` })
    } finally {
      setBusyDoc(null)
    }
  }

  // Built server-side from the award record, stored once, then hashed and
  // anchored. Every later download serves those same bytes, so the hash on the
  // blockchain stays reproducible.
  const generateDoc = (award, doc) =>
    issueDoc(award, doc, () => apiGenerateAwardDocument(award.id, doc.key), 'generate')

  // The signed scan, once the printed notice comes back.
  const uploadDoc = (award, doc, file) =>
    issueDoc(award, doc, () => apiUploadAwardDocument(award.id, doc.key, file), 'upload')

  // Complete the on-chain step for a document that was uploaded but never
  // anchored (MetaMask declined, no wallet at the time). It re-signs the hash
  // recorded at upload — the document itself is untouched — then refreshes so
  // the badge flips to "On-chain".
  const anchorDoc = async (award, doc) => {
    if (!doc.anchor) return
    const ok = await runAnchor(doc.anchor, { label: `${award.project_code} · ${doc.label}` })
    if (ok) load()
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return awards.filter(a => !q || a.supplier_name.toLowerCase().includes(q) || a.project_name.toLowerCase().includes(q) ||
      (a.project_code || '').toLowerCase().includes(q))
  }, [awards, query])

  const totalAmount = useMemo(() => awards.reduce((sum, a) => sum + Number(a.amount || 0), 0), [awards])
  // Real count of issued documents — not awards × 3, which claimed documents
  // that had never been uploaded.
  const documentsIssued = useMemo(() => awards.reduce(
    (sum, a) => sum + (a.documents || []).filter(d => d.url).length, 0), [awards])

  return (
    <div className="ad-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div className="ad-stats">
        {[
          { label: 'Contracts awarded', icon: Award, value: awards.length },
          { label: 'Total awarded', icon: BarChart2, value: peso(totalAmount) },
          {
            label: 'Documents issued', icon: FileText,
            value: <>{documentsIssued}<span className="ad-stat-of">/{awards.length * 3}</span></>,
            sub: 'BAC Resolution · NOA · NTP',
          },
          { label: 'Latest award', icon: Calendar, value: fmtDate(awards[0]?.awarded_at), small: true },
        ].map(({ label, icon: Icon, value, sub, small }) => (
          <div className="ad-stat-card" key={label}>
            <div className="ad-stat-top">
              <span className="ad-stat-label">{label}</span>
              <div className="ad-stat-icon-wrap" aria-hidden="true"><Icon size={18} /></div>
            </div>
            <div className={`ad-stat-value${small ? ' ad-stat-value-sm' : ''}`}>
              {loading ? <Skeleton width={70} height={24} /> : value}
            </div>
            {sub && <div className="ad-stat-sub">{sub}</div>}
          </div>
        ))}
      </div>

      <div className="ad-card">
        <div className="ad-card-header">
          <div>
            <h2>Awarded Contracts</h2>
            <p>Issue in order: BAC Resolution, NOA, NTP. PDF, JPG or PNG, up to 5 MB.</p>
          </div>
          <label className="ad-search-inline">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">Search awards</span>
            <input
              placeholder="Search awards"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </label>
        </div>
        <div className="ad-x-scroll">
        <table className="ad-table ad-awards-table">
          <thead>
            <tr>
              <th>Supplier</th><th>Project</th><th className="ad-num">Award Amount</th>
              <th>Award Date</th><th>Status</th><th>Documents</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <TableSkeleton rows={3} cols={6} />
            ) : filtered.length === 0 ? (
              <TableEmpty colSpan={6} icon={Award}
                title={search ? 'No awards match your search' : 'No awards yet'}
                description={search
                  ? 'Try a different supplier, project, or ref code.'
                  : 'Awards appear here after you mark a winning bid in Bid Evaluation.'}
                action={!search && <Link to={ws('/bids')} className="ad-btn-cancel">Go to Bid Evaluation</Link>} />
            ) : filtered.map(a => (
              <tr key={a.id}>
                <td className="ad-bold">{a.supplier_name}</td>
                <td>
                  <div className="ad-cell-stack">
                    <span>{a.project_name}</span>
                    <RefCode code={a.project_code} />
                    <Link to={`${ws('')}/record/${a.project}`} onMouseEnter={() => prefetchRecord(a.project)} className="ad-btn-view-sm" style={{ alignSelf: 'flex-start' }}>
                      <ShieldCheck size={12} /> Procurement record
                    </Link>
                  </div>
                </td>
                <td className="ad-num">{peso(a.amount)}</td>
                <td className="ad-muted ad-nowrap">{fmtDate(a.awarded_at)}</td>
                <td><StatusBadge domain="award" status={a.status === 'won' ? 'won' : 'cancelled'} /></td>
                <td>
                  <div className="ad-doc-btns">
                    {(a.documents || []).map(d => (
                      <AwardDocButton
                        key={d.key}
                        award={a}
                        doc={d}
                        busy={busyDoc === `${a.id}:${d.key}`}
                        onUpload={uploadDoc}
                        onGenerate={generateDoc}
                        onAnchor={anchorDoc}
                        readOnly={!canPrepare(workspaceRole(), workflowOn)}
                      />
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <div className="ui-callout ad-award-callout">
        <Info size={18} className="ui-callout-icon" />
        <MoreInfo summary="About award documents" className="ad-award-more">
          <ol className="ad-award-steps">
            <li><span className="ad-award-step-n">1</span><div><strong>BAC Resolution</strong><span>Official resolution documenting the award decision</span></div></li>
            <li><span className="ad-award-step-n">2</span><div><strong>NOA</strong><span>Official notification to the winning supplier</span></div></li>
            <li><span className="ad-award-step-n">3</span><div><strong>NTP</strong><span>Authorization for the supplier to begin work</span></div></li>
          </ol>
          <p style={{ marginTop: 10 }}>
            Each upload is fingerprinted (SHA-256) with its issue date and recorded on the blockchain
            once signed, so a notice can't be quietly swapped or backdated. Replacing a document adds
            a new entry to the trail; the earlier one is shown as superseded, not altered.
          </p>
        </MoreInfo>
      </div>
    </div>
  )
}
