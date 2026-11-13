import { useState, useRef, useMemo } from 'react'
import { useDebouncedValue } from '../../utils/useDebouncedValue'
import { Link } from 'react-router-dom'
import {
  FileText, CheckCircle2, Search, Eye, Shield, X, Send, Trophy, Trash2, AlertTriangle, Upload, Lock, Camera, Check, XCircle,
} from 'lucide-react'
import { apiResubmitBidDocuments, apiUploadBidImages, apiDeleteBidImage } from '../../api'
import { TableSkeleton } from '../../components/Skeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import EmptyState from '../../components/ui/EmptyState'
import BlockchainTrail, { BlockchainBadge } from '../../components/BlockchainTrail'
import { isVerified } from '../../blockchain/anchorState'
import { prefetchRecord } from '../../components/ProcurementRecord'
import SecureImg from '../../components/ui/SecureImg'
import { LocalPreviewButton } from '../../components/ui/FilePreview'
import {
  BID_LABEL, MAX_PRODUCT_IMAGES, ProductImagePicker, appendProductImages, fmtDate, mapProductImage, todayISO, validateFile,
} from './shared'

// ─── Bid detail modal — read-only view of the supplier's own submission ──────

// One flagged-document row inside the bid detail modal: shows the admin's
// note and a re-upload control, mirroring RevisionPanel's per-row UI but
// scoped to a single bid's documents instead of the whole supplier profile.
function BidDocRevisionRow({ doc, file, onFile, onRemove }) {
  const ref = useRef(null)
  return (
    <div className="sd-revision-row">
      <div className="sd-revision-info">
        <span className="sd-bold">{doc.label}</span>
        {doc.review_note && <span className="sd-revision-note"><AlertTriangle size={12} /> {doc.review_note}</span>}
      </div>
      <div className="sd-revision-action">
        {file ? (
          <div className="sd-revision-file">
            <FileText size={14} /><span className="sd-file-name" title={file.name}>{file.name}</span>
            <LocalPreviewButton file={file} className="sd-file-preview" />
            <button onClick={onRemove}><X size={14} /></button>
          </div>
        ) : (
          <button className="sd-reupload-btn" onClick={() => ref.current?.click()}>
            <Upload size={14} /> Re-upload
          </button>
        )}
        <input ref={ref} type="file" accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx" hidden
          onChange={e => onFile(e.target.files[0])} />
      </div>
    </div>
  )
}
// The flagged product-image SET: the supplier picks a fresh set of photos,
// which replaces the current ones when the revision is resubmitted.
function ImageRevisionRow({ doc, items, onChange, disabled }) {
  return (
    <div className="sd-revision-row sd-revision-row-images">
      <div className="sd-revision-info">
        <span className="sd-bold">{doc.label}</span>
        {doc.review_note && <span className="sd-revision-note"><AlertTriangle size={12} /> {doc.review_note}</span>}
        <span className="sd-muted sd-small">The photos you add here replace your current product images.</span>
      </div>
      <ProductImagePicker items={items} onChange={onChange} max={MAX_PRODUCT_IMAGES} disabled={disabled} />
    </div>
  )
}
// Product images already on the bid. Editable (add / remove) only while the
// procurement is open for bidding and before its deadline — the same window the
// backend enforces; afterwards they're read-only like the rest of the bid.
function BidProductImages({ bid, onChanged, setToast }) {
  const [images, setImages] = useState(bid.productImages)
  const [adding, setAdding] = useState([])       // [{ id, file, caption }]
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState(null)
  const editable = bid.projectStatus === 'published' && !(bid.projectDeadline && bid.projectDeadline < todayISO())
  const room = MAX_PRODUCT_IMAGES - images.length
  const lastRequired = bid.requiresProductImages && images.length <= 1

  if (!editable && images.length === 0) return null

  const upload = async () => {
    setBusy(true)
    try {
      const fd = new FormData()
      appendProductImages(fd, adding)
      const updated = await apiUploadBidImages(bid.id, fd)
      setImages((updated.product_images || []).map(mapProductImage))
      setAdding([])
      setToast({ type: 'success', message: 'Product images added to your bid.' })
      onChanged()
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not upload the images.' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (imageId) => {
    setBusy(true)
    try {
      const updated = await apiDeleteBidImage(bid.id, imageId)
      setImages((updated.product_images || []).map(mapProductImage))
      setToast({ type: 'success', message: 'Image removed.' })
      onChanged()
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not remove the image.' })
    } finally {
      setBusy(false)
      setConfirmId(null)
    }
  }

  return (
    <div className="sd-bid-section">
      <h4 className="sd-bid-section-label">
        Product Images{bid.requiresProductImages && <span className="sd-req"> *</span>}
      </h4>
      {bid.requiresProductImages && bid.productImageInstructions && (
        <p className="sd-pimg-instructions"><Camera size={13} /> {bid.productImageInstructions}</p>
      )}
      {images.length > 0 ? (
        <div className="sd-pimg-grid">
          {images.map((img, idx) => (
            <div className="sd-pimg-card" key={img.id}>
              <a className="sd-pimg-thumb" href={img.url} target="_blank" rel="noreferrer" title="Open full size">
                <SecureImg src={img.url} alt={img.caption || `Product image ${idx + 1}`} loading="lazy" />
              </a>
              {img.caption && <span className="sd-pimg-cap" title={img.caption}>{img.caption}</span>}
              {editable && !lastRequired && (
                confirmId === img.id ? (
                  <div className="sd-pimg-confirm">
                    <button type="button" className="sd-pimg-confirm-yes" disabled={busy} onClick={() => remove(img.id)}>
                      {busy ? 'Removing…' : 'Remove'}
                    </button>
                    <button type="button" className="sd-pimg-confirm-no" disabled={busy} onClick={() => setConfirmId(null)}>
                      Keep
                    </button>
                  </div>
                ) : (
                  <button type="button" className="sd-pimg-delete" disabled={busy} onClick={() => setConfirmId(img.id)}>
                    <Trash2 size={12} /> Remove
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="sd-muted sd-small">No product images on this bid yet.</p>
      )}

      {editable ? (
        <div className="sd-pimg-add-wrap">
          {lastRequired && images.length === 1 && (
            <p className="sd-muted sd-small">
              This procurement requires at least one image. To replace it, add the new photo first, then remove the old one.
            </p>
          )}
          {room > 0 ? (
            <>
              <ProductImagePicker items={adding} onChange={setAdding} max={room} disabled={busy} />
              {adding.length > 0 && (
                <button type="button" className="sd-btn-primary sd-pimg-upload" disabled={busy} onClick={upload}>
                  <Upload size={14} /> {busy ? 'Uploading…' : `Upload ${adding.length} image${adding.length > 1 ? 's' : ''}`}
                </button>
              )}
            </>
          ) : (
            <p className="sd-muted sd-small">You've reached the limit of {MAX_PRODUCT_IMAGES} images. Remove one to add another.</p>
          )}
        </div>
      ) : (
        <p className="sd-muted sd-small sd-pimg-locked"><Lock size={12} /> Bidding has closed, so product images can no longer be changed.</p>
      )}
    </div>
  )
}
function BidDetailModal({ bid, award, onClose, onWithdraw, onResubmitted, setToast }) {
  // Only while bidding is open: once it closes (deadline, or ended early by the
  // procuring entity) the server refuses a withdrawal (BidViewSet.destroy).
  const canWithdraw = (bid.status === 'submitted' || bid.status === 'under_review')
    && bid.projectStatus === 'published' && !(bid.projectDeadline && bid.projectDeadline < todayISO())
  const flaggedDocs = (bid.documents || []).filter(d => d.review_status === 'needs_revision')
  const [files, setFiles] = useState({})  // { key: File } — product_images holds [{ id, file, caption }]
  const [busy, setBusy] = useState(false)
  const hasReplacement = (key) => (Array.isArray(files[key]) ? files[key].length > 0 : !!files[key])

  const onFile = (key, file) => {
    if (!file) return
    const msg = validateFile(file)
    if (msg) { setToast({ type: 'error', message: `${key.replace(/_/g, ' ')}: ${msg}` }); return }
    setFiles(f => ({ ...f, [key]: file }))
  }

  const doResubmit = async () => {
    setBusy(true)
    try {
      const fd = new FormData()
      Object.entries(files).forEach(([k, file]) => {
        if (k === 'product_images') appendProductImages(fd, file)
        else fd.append(k, file)
      })
      await apiResubmitBidDocuments(bid.id, fd)
      setToast({ type: 'success', message: 'Documents resubmitted — the admin will take another look.' })
      onResubmitted()
      onClose()
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not resubmit documents.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sd-modal-overlay" onClick={onClose}>
      <div className="sd-modal sd-modal-lg" onClick={e => e.stopPropagation()}>
        <div className="sd-modal-header">
          <div>
            <h3>Bid Details</h3>
            <p className="sd-muted sd-small">{bid.project}</p>
          </div>
          <button className="sd-modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="sd-bid-scroll">
          <div className="sd-modal-meta">
            <div><span>Amount</span><strong>{bid.amount}</strong></div>
            <div><span>Submitted</span><strong>{bid.submitted}</strong></div>
            <div><span>Status</span><strong><StatusBadge domain="bid" status={bid.status} label={BID_LABEL[bid.status]} /></strong></div>
            <div><span>Blockchain</span><strong>
              {bid.status === 'winner'
                ? <BlockchainBadge anchors={bid.anchors} />
                : <StatusBadge tone="neutral" label="Database record" />}
            </strong></div>
          </div>
          <div className="sd-bid-body">
            <div className="sd-bid-section">
              <h4 className="sd-bid-section-label">Bid Information</h4>
              <div className="sd-detail-line"><span>Delivery Timeline</span><strong>{bid.deliveryTimeline || '—'}</strong></div>
              {bid.brandName && <div className="sd-detail-line"><span>Brand Name</span><strong>{bid.brandName}</strong></div>}
              {bid.modelNumber && <div className="sd-detail-line"><span>Model Number</span><strong>{bid.modelNumber}</strong></div>}
              <div className="sd-detail-notes" style={{ padding: '12px 0 0' }}>
                <span className="sd-detail-label">Proposal Notes</span>
                <p>{bid.notes || 'No notes provided.'}</p>
              </div>
              {bid.additionalComments && (
                <div className="sd-detail-notes" style={{ padding: '12px 0 0' }}>
                  <span className="sd-detail-label">Additional Comments</span>
                  <p>{bid.additionalComments}</p>
                </div>
              )}
            </div>

            {flaggedDocs.length > 0 && (
              <div className="sd-bid-section sd-revision-card" style={{ borderColor: 'rgba(249,115,22,0.3)' }}>
                <h4 className="sd-bid-section-label">Documents Needing Revision</h4>
                <p className="sd-bid-section-hint">
                  You're still in this bidding. Re-upload the flagged file(s) and resubmit.
                </p>
                <div className="sd-revision-list">
                  {flaggedDocs.map(d => d.key === 'product_images' ? (
                    <ImageRevisionRow
                      key={d.key} doc={d} items={files.product_images || []} disabled={busy}
                      onChange={(items) => setFiles(f => ({ ...f, product_images: items }))}
                    />
                  ) : (
                    <BidDocRevisionRow
                      key={d.key} doc={d} file={files[d.key]}
                      onFile={(file) => onFile(d.key, file)}
                      onRemove={() => setFiles(f => { const n = { ...f }; delete n[d.key]; return n })}
                    />
                  ))}
                </div>
                <div className="sd-revision-footer">
                  <button
                    className="sd-btn-primary"
                    disabled={!flaggedDocs.every(d => hasReplacement(d.key)) || busy}
                    onClick={doResubmit}
                  >
                    <Send size={14} /> {busy ? 'Resubmitting…' : 'Resubmit Documents'}
                  </button>
                  {!flaggedDocs.every(d => hasReplacement(d.key)) && (
                    <span className="sd-muted sd-small">Replace all flagged documents to enable resubmission.</span>
                  )}
                </div>
              </div>
            )}

            <BidProductImages bid={bid} onChanged={onResubmitted} setToast={setToast} />

            <div className="sd-bid-section">
              <h4 className="sd-bid-section-label">Submitted Documents</h4>
              {bid.files.length === 0 ? (
                <p className="sd-muted sd-small">No documents uploaded.</p>
              ) : (
                <div className="sd-doc-list">
                  {bid.files.map((f, i) => (
                    <a key={i} className="sd-doc-row" href={f.url} target="_blank" rel="noreferrer">
                      <span className="sd-file-check"><Check size={12} /></span>
                      <span className="sd-file-rowname" title={f.name}>{f.name}</span>
                      <span className="sd-doc-view"><Eye size={13} /> View</span>
                    </a>
                  ))}
                </div>
              )}
            </div>

            <div className="sd-bid-section">
              <h4 className="sd-bid-section-label">Declarations</h4>
              <div className="sd-decl-badges">
                {bid.declarations.map((d, i) => (
                  <div className={`sd-decl-badge${d.ok ? '' : ' sd-decl-badge-no'}`} key={i}>
                    {d.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                    <span>{d.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Won: the official documents issued to this supplier. The Notice
                of Award is addressed to them and starts the clock for posting a
                performance security, so they collect it here — and each one can
                be checked against the blockchain, so nobody can hand them an
                altered or backdated notice. */}
            {award && (award.documents || []).some(d => d.url) && (
              <div className="sd-bid-section">
                <h4 className="sd-bid-section-label">
                  <Trophy size={13} style={{ verticalAlign: -1, marginRight: 5 }} />
                  Award Documents
                </h4>
                <p className="sd-bid-section-hint">
                  Each document's fingerprint is on the Sepolia blockchain, so you can check your copy on the
                  public results page.
                </p>
                <div className="sd-doc-list">
                  {(award.documents || []).filter(d => d.url).map(d => (
                    <a key={d.key} className="sd-doc-row" href={d.url} target="_blank" rel="noreferrer">
                      <span className="sd-file-check"><Check size={12} /></span>
                      <span className="sd-file-rowname">
                        {d.label}
                        <span className="sd-muted sd-small" style={{ marginLeft: 8 }}>
                          Issued {fmtDate(d.issued_at)}
                        </span>
                      </span>
                      {isVerified(d.anchor) ? (
                        <span className="sd-award-doc-chain" title={`Confirmed on-chain by the server (tx ${d.tx_hash})`}>
                          <Shield size={11} /> Confirmed on-chain
                        </span>
                      ) : d.anchored ? (
                        <span className="sd-muted sd-small" title={`Transaction reported (tx ${d.tx_hash}), not yet verified`}>
                          Tx reported
                        </span>
                      ) : null}
                      <span className="sd-doc-view"><Eye size={13} /> Download</span>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Only a WINNING bid is fingerprinted on-chain (at award time),
                so this panel must not promise a "proof of submission" to every
                bidder — for them the bid is a database record, and the chain
                only ever sees it inside the evaluation commitment made when
                the winner is selected. */}
            <div className="sd-bid-section">
              {/* The full record: timeline, outcome, and — for every bidder —
                  a receipt to check their bid is inside the evaluation
                  commitment anchored at award. */}
              {bid.projectPk && (
                <Link to={`/supplier/record/${bid.projectPk}`} onMouseEnter={() => prefetchRecord(bid.projectPk)} className="ui-btn ui-btn--secondary ui-btn--sm"
                  style={{ marginBottom: 10 }}>
                  <Shield size={13} /> View procurement record &amp; result
                </Link>
              )}
              {bid.status === 'winner' ? (
                <BlockchainTrail
                  anchors={bid.anchors}
                  title="Winning bid & award on-chain"
                  entityRef={bid.projectId}
                />
              ) : (
                <>
                  <h4 className="sd-bid-section-label">
                    <Shield size={13} style={{ verticalAlign: -1, marginRight: 5 }} />
                    Blockchain
                  </h4>
                  <p className="sd-bid-section-hint">
                    Your bid is a database record. Only the winning bid and the award are fingerprinted
                    on Sepolia, and your amount is never published there.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="sd-modal-footer">
          {canWithdraw && (
            <button type="button" className="sd-btn-withdraw" onClick={() => { onWithdraw(); onClose() }}>
              <Trash2 size={14} /> Withdraw Bid
            </button>
          )}
          <button type="button" className="sd-btn-cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
export default function SupplierBids({ bids, awards = [], onWithdraw, loading, onResubmitted, setToast }) {
  const [detail, setDetail] = useState(null)
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return bids.filter(b => !q || b.project.toLowerCase().includes(q))
  }, [bids, query])

  // The award for the open bid, if it won — matched on the bid itself, falling
  // back to the procurement code for awards created before the bid link existed.
  const awardFor = (bid) =>
    bid && awards.find(a => a.bid === bid.id || a.project_code === bid.projectId)

  return (
    <div className="sd-content">
      {detail && (
        <BidDetailModal
          bid={detail}
          award={awardFor(detail)}
          onClose={() => setDetail(null)}
          onWithdraw={() => { onWithdraw(detail.id); setDetail(null) }}
          onResubmitted={onResubmitted}
          setToast={setToast}
        />
      )}
      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>Submitted bids</h2></div>
          {bids.length > 0 && (
            <label className="sd-search-inline">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search your bids</span>
              <input placeholder="Search your bids" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
          )}
        </div>
        {loading && bids.length === 0 ? (
          <table className="sd-table">
            <thead>
              <tr><th>Project</th><th>Amount</th><th>Notes</th><th>Submitted</th><th>Status</th><th></th></tr>
            </thead>
            <tbody><TableSkeleton rows={3} cols={6} /></tbody>
          </table>
        ) : bids.length === 0 ? (
          <EmptyState icon={FileText} title="No bids submitted yet"
            description="Browse projects to submit your first bid."
            action={<Link to="/supplier/projects" className="sd-btn-primary">Browse bid opportunities</Link>} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Search} title="No matching bids" description={`No bids match "${query}".`}
            action={<button className="sd-btn-cancel" onClick={() => setSearch('')}>Clear search</button>} />
        ) : (
          <div className="sd-table-scroll">
          <table className="sd-table">
            <thead>
              <tr><th>Project</th><th className="sd-num">Amount</th><th>Notes</th><th>Submitted</th><th>Status</th><th><span className="sr-only">Action</span></th></tr>
            </thead>
            <tbody>
              {filtered.map(b => (
                <tr key={b.id}>
                  <td>
                    <div className="sd-bold">{b.project}</div>
                    {b.projectId && <span className="sd-mono" style={{ marginTop: 4, display: 'inline-block' }}>{b.projectId}</span>}
                  </td>
                  <td className="sd-num">{b.amount}</td>
                  <td className="sd-muted" style={{ maxWidth: 200, fontSize: 13 }}>{b.notes}</td>
                  <td className="sd-muted sd-nowrap">{b.submitted}</td>
                  <td><StatusBadge domain="bid" status={b.status} label={BID_LABEL[b.status]} /></td>
                  <td>
                    <button className="sd-btn-view" onClick={() => setDetail(b)}>
                      <Eye size={13} /> View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  )
}
