import { useState, useEffect } from 'react'
import { ws, useBacStatus } from '../../utils/workspace'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Award, Search, FileText, Info, Eye, X, ExternalLink, CheckCircle2, AlertTriangle, XCircle, Check, ImageIcon, Clock, ArrowLeft, ShieldCheck, Download, Landmark,
} from 'lucide-react'
import {
  apiListProjectBids, apiQualifyBid, apiDisqualifyBid, apiSelectWinner, apiGetProject, apiListAwards, apiBidRequestRevision,
} from '../../api'
import { refreshProjects } from '../../store/projectsStore'
import EndBiddingButton from '../../components/EndBiddingButton'
import { END_BIDDING_SUCCESS } from '../../utils/endBidding'
import { Skeleton } from '../../components/Skeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import EmptyState from '../../components/ui/EmptyState'
import BlockchainTrail, { BlockchainBadge } from '../../components/BlockchainTrail'
import { runAnchorSequence } from '../../blockchain/anchorStore'
import InfoTip from '../../components/ui/InfoTip'
import Thumbnail from '../../components/ui/Thumbnail'
import Lightbox from '../../components/ui/Lightbox'
import DataTable from '../../components/ui/DataTable'
import ActionConfirm from '../../components/ui/ConfirmDialog'
import Countdown from '../../components/ui/Countdown'
import ProcurementStepper from '../../components/ui/ProcurementStepper'
import { prefetchRecord } from '../../components/ProcurementRecord'
import SecureImg from '../../components/ui/SecureImg'
import PreviewButton from '../../components/ui/FilePreview'
import {
  ConfirmDialog, Info2, RefCode, Toast, fmtDate, initFlagsFrom, peso, workspaceRole,
} from './shared'

// Declaration fields in display order: [serializer key, badge label].
const BID_DECLARATIONS = [
  ['terms_accepted', 'Terms and Conditions Accepted'],
  ['interest_declared', 'Declaration of Interest Confirmed'],
  ['scm_declared', 'Past SCM Practices Declared'],
  ['accuracy_confirmed', 'Accuracy of Information Confirmed'],
  ['specification_confirmed', 'Specification Match Confirmed'],
]
// Flatten every uploaded file on a bid into { label, name, url } rows.
function collectBidFiles(b) {
  // Stored names are random; the original upload name comes from the API.
  const names = b.file_names || {}
  const base = (_url, key) => names[key] || ''
  const out = []
  if (b.quotation_document_url) out.push({ label: 'Quotation', name: base(b.quotation_document_url, 'quotation_document'), url: b.quotation_document_url })
  if (b.technical_document_url) out.push({ label: 'Technical Proposal', name: base(b.technical_document_url, 'technical_document'), url: b.technical_document_url })
  if (b.supplier_product_image_url) out.push({ label: 'Product Image', name: base(b.supplier_product_image_url, 'supplier_product_image'), url: b.supplier_product_image_url })
  if (b.supplier_datasheet_url) out.push({ label: 'Datasheet', name: base(b.supplier_datasheet_url, 'supplier_datasheet'), url: b.supplier_datasheet_url })
  if (b.supplier_compliance_doc_url) out.push({ label: 'Compliance', name: base(b.supplier_compliance_doc_url, 'supplier_compliance_doc'), url: b.supplier_compliance_doc_url })
  ;(b.attachments || []).forEach(a => out.push({ label: 'Other', name: a.file_name, url: a.url }))
  return out
}
const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const isImageFile = (name) => IMAGE_FILE_RE.test(name || '')
const fmtDateTime = (v) => v ? new Date(v).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
}) : null
// Decision label shown per bidder in the merged Bids & Evaluation table.
const BID_DECISION_LABEL = {
  under_review: 'Pending Review', qualified: 'Qualified',
  disqualified: 'Disqualified', winner: 'Qualified',
}
// Builds the full procurement timeline (one entry per lifecycle milestone) from
// whatever timestamps the project/bids currently have — works for any project,
// at any stage, not just one hard-coded case. "Bids Received" and "Evaluation"
// are merged into a single per-supplier table (one row each) instead of two
// separate lists, so the same supplier name doesn't repeat and the modal stays
// readable no matter how many suppliers bid.
function buildProjectTimeline(project, bids) {
  const bySubmit = [...bids].sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at))
  const rejected = project.status === 'rejected'
  const winner = bids.find(b => b.status === 'winner')

  return [
    { key: 'created', label: 'Bid Created', at: project.created_at, status: 'done' },
    { key: 'submitted', label: 'Submitted for Approval', at: project.created_at, status: 'done' },
    rejected
      ? { key: 'reviewed', label: 'Rejected by Head', at: project.reviewed_at, status: 'rejected', note: project.reject_reason }
      : { key: 'reviewed', label: 'Approved by Head', at: project.reviewed_at, status: project.reviewed_at ? 'done' : 'pending' },
    { key: 'published', label: 'Bid Published', at: project.published_at, status: project.published_at ? 'done' : 'pending' },
    {
      key: 'bids', label: 'Bids & Evaluation', at: bySubmit[0]?.submitted_at || null,
      status: bySubmit.length ? 'done' : 'pending',
      table: bySubmit.map(b => ({
        supplier: b.supplier_name,
        submittedAt: b.submitted_at,
        decision: BID_DECISION_LABEL[b.status] || b.status,
        decisionAt: b.reviewed_at,
        decisionTone: b.status === 'disqualified' ? 'red' : (b.status === 'qualified' || b.status === 'winner') ? 'green' : 'gray',
      })),
    },
    {
      key: 'awarded',
      label: project.status === 'awarded' ? `Awarded to ${winner?.supplier_name || '—'}` : 'Awarded',
      at: project.awarded_at, status: project.status === 'awarded' ? 'done' : 'pending',
    },
  ]
}
// How many bidder rows to show before collapsing behind "Show all" — keeps the
// modal short whether one supplier bid or fifty did.
const BID_TABLE_PREVIEW_COUNT = 3
// One row of the merged Bids & Evaluation table: supplier, amount, submitted
// time, and the qualify/disqualify decision + its time (if decided yet).
function BidTimelineRow({ row }) {
  return (
    <div className="ad-timeline-bidrow">
      <div className="ad-timeline-bidrow-main">
        <span className="ad-bold">{row.supplier}</span>
      </div>
      <div className="ad-timeline-bidrow-meta">
        <span className="ad-muted ad-small">Submitted {fmtDateTime(row.submittedAt)}</span>
        <StatusBadge
          tone={row.decisionTone === 'gray' ? 'neutral' : row.decisionTone === 'red' ? 'danger' : 'success'}
          label={`${row.decision}${row.decisionAt ? ` · ${fmtDateTime(row.decisionAt)}` : ''}`}
        />
      </div>
    </div>
  )
}
// Modal showing the full timestamped lifecycle of a procurement — when it was
// created, approved, published, every bid received + its evaluation decision,
// and the award. Built from live project/bid data, so it's the same component
// for every procurement, not specific to any one of them.
function TimelineModal({ project, bids, onClose }) {
  const groups = buildProjectTimeline(project, bids)
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="ad-modal-overlay" onClick={onClose}>
      <div className="ad-modal ad-timeline-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-header">
          <div>
            <h3>Procurement Timeline</h3>
            <div className="ad-ref-line">
              <RefCode code={project.code} />
              <span className="ad-muted ad-small">{project.name}</span>
            </div>
          </div>
          <button className="ad-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="ad-modal-body">
          <div className="ad-timeline">
            {groups.map(g => {
              const rows = g.table && !expanded ? g.table.slice(0, BID_TABLE_PREVIEW_COUNT) : g.table
              return (
                <div className={`ad-timeline-row ad-timeline-${g.status}`} key={g.key}>
                  <div className="ad-timeline-dot" />
                  <div className="ad-timeline-content">
                    <div className="ad-timeline-label">
                      {g.label}{g.table && g.table.length > 0 && <span className="ad-timeline-count"> ({g.table.length})</span>}
                    </div>
                    <div className="ad-timeline-time">{fmtDateTime(g.at) || 'Not reached yet'}</div>
                    {g.note && <div className="ad-timeline-note">Reason: {g.note}</div>}
                    {rows && rows.length > 0 && (
                      <div className="ad-timeline-bidtable">
                        {rows.map((row, i) => <BidTimelineRow row={row} key={i} />)}
                        {g.table.length > BID_TABLE_PREVIEW_COUNT && (
                          <button className="ad-timeline-showmore" onClick={() => setExpanded(e => !e)}>
                            {expanded ? 'Show less' : `Show all ${g.table.length} bids`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <div className="ad-modal-footer">
          <button className="ad-btn-cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
// Enlarged view of one product image, inside the bid modal. Esc, the close
// button, or a click on the backdrop closes it; arrows step through the set.
function ImageLightbox({ images, index, onIndex, onClose }) {
  const img = images[index]
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1)
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, images.length, onIndex, onClose])
  if (!img) return null
  return (
    <div className="ad-lightbox" role="dialog" aria-modal="true" aria-label="Product image" onClick={onClose}>
      <div className="ad-lightbox-inner" onClick={e => e.stopPropagation()}>
        <button className="ad-lightbox-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <SecureImg src={img.url} alt={img.caption || `Product image ${index + 1}`} />
        <div className="ad-lightbox-bar">
          <button disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Previous image">‹</button>
          <span>
            {img.caption || <span className="ad-muted">No caption</span>}
            <span className="ad-muted ad-small"> · {index + 1} / {images.length}</span>
          </span>
          <button disabled={index === images.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next image">›</button>
        </div>
        <a className="ad-lightbox-open" href={img.url} target="_blank" rel="noreferrer">
          <ExternalLink size={12} /> Open original
        </a>
      </div>
    </div>
  )
}
// Supplier's product photos on a bid — thumbnail gallery, click to enlarge.
function BidProductGallery({ bid }) {
  const images = bid.product_images || []
  const [open, setOpen] = useState(null)
  if (images.length === 0) {
    return bid.project_requires_product_images
      ? <p className="ad-muted ad-small">No product images on this bid.</p>
      : null
  }
  return (
    <>
      <div className="ad-img-grid">
        {images.map((img, i) => (
          <button type="button" key={img.id} className="ad-img-card ad-img-card-btn" onClick={() => setOpen(i)}
            title={img.caption || 'View larger'}>
            <SecureImg src={img.url} alt={img.caption || `Product image ${i + 1}`} loading="lazy" />
            <span className="ad-img-cap">{img.caption || `Image ${i + 1}`}</span>
          </button>
        ))}
      </div>
      {open !== null && (
        <ImageLightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
    </>
  )
}
// Full bid detail modal (admin evaluation) — opened by clicking a supplier's row.
// Shows every field, with images previewed inline so the admin doesn't have to
// download each one to check it.
function BidDetailModal({ bid, awarded, readOnly = false, busyId, projectName, onQualify, onDisqualify, onMarkWinner, onRequestRevision, confirm, onConfirmWinner, onCancelConfirm, onClose }) {
  const files = collectBidFiles(bid)
  const images = files.filter(f => isImageFile(f.name))
  const docs = files.filter(f => !isImageFile(f.name))

  // Per-document review flags — same { key: { checked, note } } shape and
  // initFlagsFrom() helper the Supplier document review modal uses.
  const [flags, setFlags] = useState(() => initFlagsFrom(bid))
  const toggleFlag = (key) =>
    setFlags(f => ({ ...f, [key]: { checked: !f[key]?.checked, note: f[key]?.note || '' } }))
  const setFlagNote = (key, val) =>
    setFlags(f => ({ ...f, [key]: { checked: f[key]?.checked ?? true, note: val } }))
  const flaggedDocs = () => {
    const out = {}
    Object.entries(flags).forEach(([k, v]) => { if (v.checked) out[k] = v.note || '' })
    return out
  }
  const hasFlaggedDocs = (bid.documents || []).some(d => d.review_status === 'needs_revision')
  // readOnly: the BAC workflow is on, so the committee evaluates and the Head
  // awards (pages/BacDashboard.jsx, pages/head/AwardApprovalsPage.jsx).
  const canDecide = bid.status !== 'winner' && !awarded && !readOnly

  return (
    <div className="ad-modal-overlay" onClick={onClose}>
      <div className="ad-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-header">
          <div>
            <h3>{bid.supplier_name}</h3>
            <p className="ad-muted ad-small">{peso(bid.amount)} · Submitted {fmtDate(bid.submitted_at)}</p>
          </div>
          <button className="ad-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="ad-modal-body">
          <div className="ad-modal-badges">
            {bid.status === 'winner'
              ? <StatusBadge tone="success" icon={Award} label="Winning Bidder" />
              : <StatusBadge domain="bid" status={bid.status} />}
            <BlockchainBadge anchors={bid.anchors} />
          </div>

          <div className="ad-info-grid">
            <Info2 label="Delivery Timeline" value={bid.delivery_timeline} />
            {bid.brand_name && <Info2 label="Brand Name" value={bid.brand_name} />}
            {bid.model_number && <Info2 label="Model Number" value={bid.model_number} />}
            {bid.warranty_period && <Info2 label="Warranty Period" value={bid.warranty_period} />}
            {bid.additional_comments && <Info2 label="Additional Comments" value={bid.additional_comments} full />}
          </div>

          {((bid.product_images || []).length > 0 || bid.project_requires_product_images) && (
            <div className="ad-bid-details-sec">
              <div className="ad-bid-details-title">
                <ImageIcon size={13} /> Product Images
                {bid.project_requires_product_images && <span className="ad-req-tag" style={{ marginLeft: 6 }}>Required</span>}
              </div>
              <BidProductGallery bid={bid} />
            </div>
          )}

          {images.length > 0 && (
            <div className="ad-bid-details-sec">
              <div className="ad-bid-details-title"><ImageIcon size={13} /> Submitted Images</div>
              <div className="ad-img-grid">
                {images.map((f, i) => (
                  <a key={i} className="ad-img-card" href={f.url} target="_blank" rel="noreferrer" title={f.name}>
                    <SecureImg src={f.url} alt={f.name} loading="lazy" />
                    <span className="ad-img-cap">{f.label}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="ad-bid-details-sec">
            <div className="ad-bid-details-title">Submitted Documents</div>
            {docs.length === 0 ? (
              <p className="ad-muted ad-small">No additional documents submitted.</p>
            ) : (
              <div className="ad-doc-list">
                {docs.map((f, i) => (
                  <a key={i} className="ad-doc-link-row" href={f.url} target="_blank" rel="noreferrer">
                    <span className="ad-doc-check"><Check size={12} /></span>
                    <span className="ad-doc-name" title={f.name}>{f.name}</span>
                    <span className="ad-doc-tag-mini">{f.label}</span>
                    <span className="ad-doc-view"><ExternalLink size={12} /> View</span>
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* This bid's own on-chain record: submission and evaluation result,
              each bound to the quotation document that was on file at the time. */}
          <div className="ad-bid-details-sec">
            <BlockchainTrail
              anchors={bid.anchors}
              title="Blockchain Record for this Bid"
              entityRef={bid.project_code}
            />
          </div>

          <div className="ad-bid-details-sec">
            <div className="ad-bid-details-title">Document Review</div>
            {canDecide && (
              <div className="ad-docs-hint">
                <Info size={15} />
                <span>
                  <strong>Tick</strong> a document with a problem, add a note, then click
                  <strong> Request Revision</strong>. The bid stays in this bidding.
                </span>
              </div>
            )}
            <div className="ad-docs-list">
              {(bid.documents || []).map(d => {
                const checked = !!flags[d.key]?.checked
                const rs = d.review_status
                const rowCls = checked ? ' flagged' : rs === 'resubmitted' ? ' resubmitted' : ''
                return (
                  <div className={`ad-doc-row${rowCls}`} key={d.key}>
                    <div className="ad-doc-main">
                      {canDecide && (
                        <label className="ad-doc-check">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!d.url}
                            onChange={() => toggleFlag(d.key)}
                          />
                        </label>
                      )}
                      <div className="ad-doc-name">
                        <span className="ad-bold">{d.label}{d.count ? ` (${d.count})` : ''}</span>
                        <span className={d.required ? 'ad-req-tag' : 'ad-opt-tag'}>{d.required ? 'Required' : 'Optional'}</span>
                        {checked
                          ? <span className="ad-doc-status ad-doc-flag">Flagged for revision</span>
                          : rs === 'resubmitted'
                            ? <span className="ad-doc-status ad-doc-resub">Resubmitted — please review</span>
                            : rs === 'approved'
                              ? <span className="ad-doc-status ad-doc-ok"><Check size={11} /> Reviewed</span>
                              : null}
                      </div>
                      {d.url
                        ? <span className="ad-doc-actions"><PreviewButton url={d.url} name={d.label} className="ad-doc-view" /><a className="ad-doc-view" href={d.url} target="_blank" rel="noreferrer"><Download size={13} /> Download</a></span>
                        : <span className="ad-doc-missing">Not uploaded</span>}
                    </div>
                    {!checked && rs === 'resubmitted' && d.review_note && (
                      <div className="ad-doc-prevnote">Previously flagged: “{d.review_note}”</div>
                    )}
                    {checked && (
                      <input
                        className="ad-doc-note"
                        placeholder="What needs fixing? (e.g. wrong file, illegible scan)"
                        value={flags[d.key]?.note || ''}
                        onChange={e => setFlagNote(d.key, e.target.value)}
                      />
                    )}
                  </div>
                )
              })}
            </div>
            {hasFlaggedDocs && (
              <p className="ad-muted ad-small" style={{ marginTop: 8 }}>
                This bid can't be selected as the winner until the flagged document(s) above are fixed.
              </p>
            )}
          </div>

          <div className="ad-bid-details-sec">
            <div className="ad-bid-details-title">Declarations</div>
            <div className="ad-decl-badges">
              {BID_DECLARATIONS.map(([key, label]) => (
                <div className={`ad-decl-badge${bid[key] ? '' : ' ad-decl-badge-no'}`} key={key}>
                  {bid[key] ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="ad-modal-footer">
          <button className="ad-btn-cancel" onClick={onClose}>Close</button>
          {canDecide && (
            <div className="ad-modal-footer-actions">
              <button
                className="ad-btn-revision"
                disabled={busyId === bid.id || Object.keys(flaggedDocs()).length === 0}
                onClick={() => onRequestRevision(bid, flaggedDocs())}
              >
                <AlertTriangle size={14} /> {busyId === bid.id ? 'Working…' : 'Request Revision'}
              </button>
              {bid.status !== 'qualified' && (
                <button className="ad-btn-approve" disabled={busyId === bid.id} onClick={() => onQualify(bid)}>
                  <Check size={14} /> {busyId === bid.id ? 'Working…' : 'Qualify'}
                </button>
              )}
              {bid.status !== 'disqualified' && (
                <button className="ad-btn-reject" disabled={busyId === bid.id} onClick={() => onDisqualify(bid)}>
                  <XCircle size={14} /> {busyId === bid.id ? 'Working…' : 'Disqualify'}
                </button>
              )}
              {bid.status === 'qualified' && !hasFlaggedDocs && (
                <button className="ad-btn-publish" disabled={busyId === bid.id} onClick={() => onMarkWinner(bid)}>
                  <Award size={14} /> {busyId === bid.id ? 'Working…' : 'Mark as Winner'}
                </button>
              )}
            </div>
          )}
        </div>

        {confirm && confirm.bid.id === bid.id && (
          <ConfirmDialog
            title="Select winning bidder?"
            message={`Award "${projectName}" to ${bid.supplier_name} for ${peso(bid.amount)}? This marks the procurement as Awarded and notifies the bidders.`}
            tone="green"
            confirmLabel="Confirm Winner"
            busy={busyId === bid.id}
            onConfirm={onConfirmWinner}
            onCancel={onCancelConfirm}
          />
        )}
      </div>
    </div>
  )
}
// ── Bid evaluation detail page (admin) — /admin/bids/:id ───────────────────────

// Every product photo on a bid: the legacy single image first, then the gallery.
function bidImages(b) {
  const out = []
  if (b.supplier_product_image_url) out.push({ url: b.supplier_product_image_url, caption: 'Product image' })
  ;(b.product_images || []).forEach((img, i) => out.push({ url: img.url, caption: img.caption || `Product image ${i + 1}` }))
  return out
}
// Documents column: flagged > missing required > complete.
function bidDocState(b) {
  const docs = b.documents || []
  const flagged = docs.filter(d => d.review_status === 'needs_revision').length
  if (flagged) return { tone: 'warning', label: `${flagged} flagged` }
  const missing = docs.filter(d => d.required && !d.url).length
  if (missing) return { tone: 'danger', label: `${missing} missing` }
  return { tone: 'success', label: 'Complete' }
}
export default function BidEvaluationPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { workflow_enabled: workflowOn } = useBacStatus()
  const [project, setProject] = useState(null)
  const [bids, setBids] = useState([])
  const [award, setAward] = useState(null)       // for the post-award stepper stages
  // Loaded independently — the project header and the bids table are
  // unrelated requests, so one being slow shouldn't hold the other back.
  const [loadingProject, setLoadingProject] = useState(true)
  const [loadingBids, setLoadingBids] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [pending, setPending] = useState(null)   // { type, bid, docs? } awaiting confirmation
  const [toast, setToast] = useState(null)
  const [viewBid, setViewBid] = useState(null)   // bid shown in the detail modal
  const [showTimeline, setShowTimeline] = useState(false)
  const [gallery, setGallery] = useState(null)   // { images, index, title, reference }

  const loadProject = () => {
    setLoadingProject(true)
    // The award is asked for at the same time as the project (and the bids),
    // not after it, and only this project's award, not the whole list.
    const awardRequest = apiListAwards({ project: id }).catch(() => null)
    apiGetProject(id)
      .then(p => {
        setProject(p)
        if (p.status === 'awarded') {
          awardRequest.then(list => { if (list) setAward(list.find(a => a.project === p.id) || null) })
        }
      })
      .catch(() => setToast({ type: 'error', message: 'Could not load this procurement.' }))
      .finally(() => setLoadingProject(false))
  }
  const loadBidsList = () => {
    setLoadingBids(true)
    apiListProjectBids(id)
      .then(setBids)
      .catch(() => setToast({ type: 'error', message: 'Could not load the bids for this procurement.' }))
      .finally(() => setLoadingBids(false))
  }
  // Only used where both genuinely need to refresh together (selecting a
  // winner changes the project's own status, not just a bid's).
  const load = () => { loadProject(); loadBidsList() }
  useEffect(load, [id])

  // Keep the open detail modal in sync with the bid's latest status after an action.
  useEffect(() => {
    if (!viewBid) return
    const updated = bids.find(b => b.id === viewBid.id)
    if (updated && updated !== viewBid) setViewBid(updated)
  }, [bids])

  const awarded = project?.status === 'awarded'
  const abc = Number(project?.budget || 0)
  // "Lowest bid" is a label on the data, among bids still in the running.
  const inRunning = bids.filter(b => b.status !== 'disqualified')
  const lowest = inRunning.length > 1 ? Math.min(...inRunning.map(b => Number(b.amount))) : null

  // Qualify/disqualify only change the bid's own status — refetch just the
  // bids table, not the project header too. Individual evaluation decisions are
  // NOT anchored (that would publish every bidder's outcome one by one); they
  // are database records, audit-logged, and committed to the chain together
  // when the winner is selected.
  const act = async (bid, fn, errMsg, okMsg) => {
    setBusyId(bid.id)
    try {
      await fn(bid.id)
      loadBidsList()
      setToast({ type: 'success', message: okMsg })
    }
    catch (e) { setToast({ type: 'error', message: e.message || errMsg }) }
    finally { setBusyId(null) }
  }

  const requestRevision = async (bid, documents) => {
    setBusyId(bid.id)
    try {
      await apiBidRequestRevision(bid.id, { documents })
      loadBidsList()
      // Close the modal — its checkbox/note UI reflects local clicks, not the
      // server's confirmed state, so leaving it open after a successful submit
      // looks like nothing happened.
      setViewBid(null)
      setToast({ type: 'success', message: 'Revision request sent to the supplier.' })
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Could not request revision.' })
    } finally {
      setBusyId(null)
    }
  }

  const confirmWinner = async (bid) => {
    setBusyId(bid.id)
    try {
      const result = await apiSelectWinner(bid.id)
      await load()
      refreshProjects()  // the project is now Awarded — refresh the shared store
      setToast({ type: 'success', message: `${bid.supplier_name} selected as the winning bidder.` })
      // Awarding produces several anchors (the winning bid, the award…). Sign
      // them in order, one wallet prompt at a time. Not awaited: the award is
      // already saved, the on-chain writes are follow-ups that can be retried.
      const sequence = result?.anchor_sequence || (result?.anchor ? [result.anchor] : [])
      runAnchorSequence(sequence.map(a => ({
        anchor: a, label: `${project?.code || ''} · ${a.stage_label || a.stage}`,
      })))
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Could not select winner.' })
    } finally {
      setBusyId(null)
    }
  }

  // What each action will do, shown in the confirmation dialog before it runs.
  const CONFIRM = {
    qualify: (b) => ({
      title: `Qualify ${b.supplier_name}?`, tone: 'primary', confirmLabel: 'Qualify bid',
      points: [`The ${peso(b.amount)} bid is marked Qualified for ${project.code}.`, 'The supplier is notified.',
        'It can then be selected as the winner.',
        'Saved as an audit-logged database record, not written to the blockchain on its own.'],
      run: () => act(b, apiQualifyBid, 'Could not qualify.', `${b.supplier_name}'s bid qualified.`),
    }),
    disqualify: (b) => ({
      title: `Disqualify ${b.supplier_name}?`, tone: 'danger', confirmLabel: 'Disqualify bid',
      points: [`The ${peso(b.amount)} bid is marked Disqualified for ${project.code}.`, 'The supplier is notified.',
        'It cannot be selected as the winner.',
        'Saved as an audit-logged database record, not written to the blockchain on its own.'],
      run: () => act(b, apiDisqualifyBid, 'Could not disqualify.', `${b.supplier_name}'s bid disqualified.`),
    }),
    revision: (b, docs) => ({
      title: 'Request a document revision?', tone: 'warning', confirmLabel: 'Send request',
      points: [`${b.supplier_name} is asked to re-upload ${Object.keys(docs).length} flagged document(s).`,
        'The bid stays in this bidding, not disqualified.', 'It cannot win until the files are fixed.'],
      run: () => requestRevision(b, docs),
    }),
    winner: (b) => ({
      title: 'Select the winning bidder?', tone: 'primary', confirmLabel: 'Award contract', onChain: true,
      points: [`${project.name} (${project.code}) is awarded to ${b.supplier_name} for ${peso(b.amount)}.`,
        'The procurement becomes Awarded and every bidder is notified.',
        'Fingerprints of the evaluation, winning bid and award go on Sepolia, never amounts or names.',
        'You then issue the BAC Resolution, NOA and NTP from Awards.'],
      run: () => confirmWinner(b),
    }),
  }
  const dialog = pending && project ? CONFIRM[pending.type](pending.bid, pending.docs) : null
  const ask = (type, bid, docs) => setPending({ type, bid, docs })

  const reference = project?.reference_image_url
    ? { url: project.reference_image_url, caption: `${project.code} · ${project.name}` } : null
  const openGallery = (b) => {
    const images = bidImages(b)
    if (images.length) setGallery({ images, index: 0, title: `${b.supplier_name} · product images`, reference })
  }

  const columns = project ? [
    {
      key: 'product', header: <span className="sr-only">Product image</span>,
      render: b => {
        const imgs = bidImages(b)
        return (
          <Thumbnail src={imgs[0]?.url} size={48} category={project.category}
            alt={`Product image from ${b.supplier_name}`} badge={imgs.length > 1 ? `+${imgs.length - 1}` : null}
            onOpen={() => openGallery(b)} />
        )
      },
    },
    {
      key: 'supplier', header: 'Supplier', mobileLabel: false, sortValue: b => b.supplier_name,
      render: b => (
        <div className="rf-cell-title" style={{ minWidth: 180 }}>
          <div>
            <strong>{b.supplier_name}</strong>
            <small>
              {Number(b.amount) === lowest && (
                <span className="ui-badge ui-badge--success" title="Lowest amount among bids that are not disqualified">Lowest bid</span>
              )}
              {[b.brand_name, b.model_number].filter(Boolean).join(' ') || `Submitted ${fmtDate(b.submitted_at)}`}
            </small>
          </div>
        </div>
      ),
    },
    {
      key: 'amount', header: 'Bid amount', align: 'right', sortValue: b => Number(b.amount),
      render: b => <span className="rf-amount">{peso(b.amount)}</span>,
    },
    {
      key: 'abc', header: 'vs ABC', align: 'right', sortValue: b => Number(b.amount) - abc,
      render: b => {
        const diff = Number(b.amount) - abc
        const pct = abc ? (diff / abc) * 100 : 0
        return diff > 0 ? (
          <span className="rf-diff is-over" title="Bids above the Approved Budget for the Contract are flagged">
            <AlertTriangle size={11} aria-hidden="true" /> Above ABC +{peso(diff)} ({pct.toFixed(1)}%)
          </span>
        ) : (
          <span className="rf-diff is-under">−{peso(-diff)} ({Math.abs(pct).toFixed(1)}%)</span>
        )
      },
    },
    {
      key: 'docs', header: 'Documents', sortValue: b => bidDocState(b).label,
      render: b => { const d = bidDocState(b); return <StatusBadge tone={d.tone} label={d.label} /> },
    },
    { key: 'delivery', header: 'Delivery', hideBelow: 'md', render: b => b.delivery_timeline || <span className="rf-muted">—</span> },
    {
      key: 'status', header: 'Status', sortValue: b => b.status,
      render: b => b.status === 'winner'
        ? <StatusBadge tone="success" icon={Award} label="Winning Bidder" />
        : <StatusBadge domain="bid" status={b.status} />,
    },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right',
      render: b => {
        const busy = busyId === b.id
        const flagged = (b.documents || []).some(d => d.review_status === 'needs_revision')
        return (
          <div className="rf-row-actions" onClick={e => e.stopPropagation()}>
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setViewBid(b)}>
              <Eye size={13} /> Review
            </button>
            {!awarded && !workflowOn && b.status !== 'winner' && (
              <>
                {b.status !== 'qualified' && (
                  <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy} onClick={() => ask('qualify', b)}>
                    <Check size={13} /> Qualify
                  </button>
                )}
                {b.status !== 'disqualified' && (
                  <button type="button" className="ui-btn ui-btn--danger-outline ui-btn--sm" disabled={busy} onClick={() => ask('disqualify', b)}>
                    <XCircle size={13} /> Disqualify
                  </button>
                )}
                {b.status === 'qualified' && !flagged && (
                  <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy} onClick={() => ask('winner', b)}>
                    <Award size={13} /> Select winner
                  </button>
                )}
              </>
            )}
          </div>
        )
      },
    },
  ] : []

  // A procurement can be awarded, or have its bidding force-ended, before its
  // deadline — "closed" with a future date would be false, so say what
  // actually happened.
  const deadlinePassed = project?.deadline && new Date(project.deadline) < new Date(new Date().toDateString())
  const closedLabel = project && project.status !== 'published' && project.deadline
    ? (project.bidding_closed_at
      ? `Bidding ended early ${fmtDate(project.bidding_closed_at)} (deadline was ${fmtDate(project.deadline)})`
      : deadlinePassed ? `Bidding closed ${fmtDate(project.deadline)}` : `Awarded before the ${fmtDate(project.deadline)} deadline`)
    : null
  const closedTip = project?.bidding_closed_at
    ? `Ended by ${project.bidding_closed_by_name || 'the procurement office'}: ${project.bidding_close_reason}`
    : undefined

  return (
    <div className="ad-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}

      <button className="ad-back-link" onClick={() => navigate(ws('/bids'))}>
        <ArrowLeft size={14} /> Back to bid evaluation
      </button>

      {loadingProject && !project ? (
        <div className="ad-card" style={{ padding: '20px 24px' }}>
          <Skeleton width="40%" height={20} />
          <Skeleton width="60%" style={{ marginTop: 10 }} />
          <div style={{ display: 'flex', gap: 24, marginTop: 24 }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, flex: 1 }}>
                <Skeleton width={28} height={28} radius={14} />
                <Skeleton width="80%" height={9} />
              </div>
            ))}
          </div>
        </div>
      ) : !project ? (
        <div className="ad-card">
          <EmptyState icon={Search} title="Procurement not found"
            description="It may have been removed, or the link is incorrect."
            action={<button className="ad-btn-cancel" onClick={() => navigate(ws('/projects'))}><ArrowLeft size={14} /> Back to projects</button>} />
        </div>
      ) : (
        <>
          <section className="rf-card" aria-labelledby="eval-title">
            <div className="rf-card-body rf-eval-head">
              <Thumbnail src={project.reference_image_url} size={72} category={project.category}
                alt={`Reference image for ${project.code} ${project.name}`}
                onOpen={() => setGallery({ images: [reference], index: 0, title: 'Project reference image' })} />
              <div style={{ minWidth: 0 }}>
                <div className="ad-eval-title-row">
                  <h2 className="ad-eval-title" id="eval-title">{project.name}</h2>
                  <StatusBadge domain="project" status={project.status} />
                  {project.bidding_phase && project.status !== 'awarded' && (
                    <StatusBadge domain="bidding" status={project.bidding_phase} />
                  )}
                </div>
                <div className="ad-ref-line" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  <RefCode code={project.code} size="lg" />
                  <span className="ad-muted ad-small">{project.category || '—'}</span>
                  <span className="ad-muted ad-small">ABC <strong className="ad-eval-abc">{peso(project.budget)}</strong></span>
                  {project.status === 'published' && project.deadline && <Countdown deadline={project.deadline} />}
                  {closedLabel && <span title={closedTip}><StatusBadge tone="neutral" icon={Clock} label={closedLabel} /></span>}
                </div>
              </div>
              <div className="ad-eval-head-actions">
                <EndBiddingButton project={project} role={workspaceRole()} className="ad-btn-timeline"
                  onEnded={() => {
                    setToast({ type: 'success', message: END_BIDDING_SUCCESS })
                    load()
                  }} />
                <BlockchainBadge anchors={project.anchors} />
                <button className="ad-btn-timeline" onClick={() => setShowTimeline(true)}>
                  <Clock size={14} /> View Timeline
                </button>
                <button className="ad-btn-timeline" onMouseEnter={() => prefetchRecord(project.id)} onClick={() => navigate(`${ws('')}/record/${project.id}`)}
                  title="The whole procurement, with blockchain evidence for each step">
                  <ShieldCheck size={14} /> Procurement record
                </button>
              </div>
            </div>
            <div style={{ padding: '0 20px 16px' }}>
              <ProcurementStepper project={project} award={award} />
            </div>
          </section>

          {workflowOn && (
            <div className="ad-card ad-bac-note" role="note">
              <Landmark size={16} aria-hidden="true" />
              <div>
                <strong>Evaluated by the BAC Committee</strong>
                <p className="ad-muted ad-small" style={{ margin: '2px 0 0' }}>
                  Each of the five members evaluates every bid; a bid qualifies when three of them pass it.
                  The committee then post-qualifies the lowest bid and votes on a resolution, and the Head approves the award.
                  {workspaceRole() === 'staff' ? ' Draft the resolution from BAC Meetings once a bid passes post-qualification.' : ''}
                </p>
              </div>
            </div>
          )}
          <section aria-labelledby="bids-h" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="rf-greeting">
              <div>
                <h3 id="bids-h" style={{ margin: 0, fontSize: 'var(--fs-section-title)', color: 'var(--text-strong)' }}>Bid comparison</h3>
                <p>
                  {bids.length} bid{bids.length === 1 ? '' : 's'} against the ABC of {peso(project.budget)}.{' '}
                  <InfoTip label="About the lowest bid label" text="“Lowest bid” labels the data only. It is not an automatic ranking." />
                </p>
              </div>
            </div>
            <DataTable
              caption={`Bids for ${project.code}`}
              columns={columns}
              rows={bids}
              loading={loadingBids}
              initialSort={{ key: 'amount', dir: 'asc' }}
              search={b => `${b.supplier_name} ${b.brand_name || ''} ${b.model_number || ''}`}
              searchPlaceholder="Search suppliers"
              filters={[
                { key: 'all', label: 'All', test: () => true },
                { key: 'under_review', label: 'Under review', test: b => b.status === 'under_review' },
                { key: 'qualified', label: 'Qualified', test: b => b.status === 'qualified' || b.status === 'winner' },
                { key: 'disqualified', label: 'Disqualified', test: b => b.status === 'disqualified' },
              ]}
              onRowClick={b => setViewBid(b)}
              empty={{
                icon: FileText, title: 'No bids submitted yet',
                description: project.status === 'published'
                  ? 'New bids appear here until the deadline.'
                  : 'Bids open once this procurement is published.',
              }}
            />
          </section>

          {/* The whole procurement's on-chain trail: submission, Head decision,
              publication, every bid, and the award. Anything not yet anchored
              can be signed from here. */}
          <div className="ad-card" style={{ padding: 0, overflow: 'hidden' }}>
            <BlockchainTrail anchors={project.anchors} entityRef={project.code} projectId={project.id} />
          </div>
        </>
      )}

      {viewBid && (
        <BidDetailModal
          bid={viewBid}
          awarded={awarded}
          readOnly={workflowOn}
          busyId={busyId}
          projectName={project.name}
          onQualify={(b) => { setViewBid(null); ask('qualify', b) }}
          onDisqualify={(b) => { setViewBid(null); ask('disqualify', b) }}
          onMarkWinner={(b) => { setViewBid(null); ask('winner', b) }}
          onRequestRevision={(b, docs) => ask('revision', b, docs)}
          confirm={null}
          onConfirmWinner={() => {}}
          onCancelConfirm={() => {}}
          onClose={() => setViewBid(null)}
        />
      )}

      {dialog && (
        <ActionConfirm
          title={dialog.title} points={dialog.points} tone={dialog.tone}
          confirmLabel={dialog.confirmLabel} onChain={dialog.onChain === true}
          busy={busyId === pending.bid.id}
          onCancel={() => setPending(null)}
          onConfirm={async () => { const run = dialog.run; setPending(null); await run() }}
        />
      )}

      {gallery && (
        <Lightbox images={gallery.images} index={gallery.index} title={gallery.title} reference={gallery.reference}
          onIndex={(i) => setGallery(g => ({ ...g, index: i }))} onClose={() => setGallery(null)} />
      )}

      {showTimeline && project && (
        <TimelineModal project={project} bids={bids} onClose={() => setShowTimeline(false)} />
      )}
    </div>
  )
}
