import { useState, useEffect, useRef } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, FileText, Clock, CheckCircle2,
  Building2, Bell, Search, ChevronDown, LogOut, Settings,
  Eye, ArrowRight, Shield, User, X, Send, Trophy, Trash2, BarChart2,
  AlertTriangle, Upload, Lock, Menu, Camera, Check, Plus, Loader2, XCircle
} from 'lucide-react'
import {
  apiLogout, apiGetMySupplier, apiResubmitDocuments,
  apiListProjects, apiListMyBids, apiSubmitBid, apiWithdrawBid, apiResubmitBidDocuments,
  apiUploadBidImages, apiDeleteBidImage,
  apiListNotifications, apiMarkNotificationsRead, apiListAwards,
  apiUpdateMySupplier, apiChangePassword, apiResendVerification,
} from '../api'
import { CATEGORIES } from '../constants/categories'
import { TableSkeleton, ListSkeleton } from '../components/Skeleton'
import AnchorActivity from '../components/AnchorActivity'
import AppSidebar from '../components/shell/AppSidebar'
import AppHeader, { storedUser } from '../components/shell/AppHeader'
import StatusBadge from '../components/ui/StatusBadge'
import EmptyState, { TableEmpty } from '../components/ui/EmptyState'
import { deadlineMeta } from '../utils/format'
import BlockchainTrail, { BlockchainBadge } from '../components/BlockchainTrail'
import { runAnchor } from '../blockchain/anchorStore'
import { exportReportCSV, exportReportPDF } from '../utils/exportReport'
import '../style/SupplierDashboard.css'

// API → UI mapping (backend uses code/decimal/ISO; the UI shows ₱ + dates).
const fmtDate = (v) => v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
const fmtPeso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH')
const parseAmount = (s) => Number(String(s).replace(/[^\d.]/g, '')) || 0
// Backend deadline is an ISO date (YYYY-MM-DD) — plain string comparison
// against today's ISO date is enough and avoids timezone-conversion bugs.
const todayISO = () => new Date().toISOString().slice(0, 10)
const mapProject = (p) => ({
  id: p.code, pk: p.id, name: p.name, budget: fmtPeso(p.budget),
  budgetRaw: Number(p.budget || 0),  // numeric ABC for the live budget comparison
  deadline: fmtDate(p.deadline), category: p.category, description: p.description,
  referenceImage: p.reference_image_url || '',  // optional required-product reference
  // Whether bidders must attach product photos, plus the Admin's guidance.
  requireProductImages: !!p.require_product_images,
  productImageInstructions: p.product_image_instructions || '',
  isExpired: !!p.deadline && p.deadline < todayISO(),
})

// Declaration fields in display order: [serializer key, badge label].
const BID_DECLARATIONS = [
  ['terms_accepted', 'Terms and Conditions Accepted'],
  ['interest_declared', 'Declaration of Interest Confirmed'],
  ['scm_declared', 'Past SCM Practices Declared'],
  ['accuracy_confirmed', 'Accuracy of Information Confirmed'],
  ['specification_confirmed', 'Specification Match Confirmed'],
]

// Collect every uploaded file on a bid (raw serializer object) into a flat list
// of { label, name, url } rows for the read-only checklist views.
function collectBidFiles(b) {
  const base = (url) => (url ? decodeURIComponent(url.split('/').pop()) : '')
  const out = []
  if (b.quotation_document_url) out.push({ label: 'Quotation Document', name: base(b.quotation_document_url), url: b.quotation_document_url })
  if (b.technical_document_url) out.push({ label: 'Technical Proposal', name: base(b.technical_document_url), url: b.technical_document_url })
  if (b.supplier_product_image_url) out.push({ label: 'Product Image', name: base(b.supplier_product_image_url), url: b.supplier_product_image_url })
  if (b.supplier_datasheet_url) out.push({ label: 'Product Datasheet', name: base(b.supplier_datasheet_url), url: b.supplier_datasheet_url })
  if (b.supplier_compliance_doc_url) out.push({ label: 'Compliance Document', name: base(b.supplier_compliance_doc_url), url: b.supplier_compliance_doc_url })
  ;(b.attachments || []).forEach(a => out.push({ label: 'Other Attachment', name: a.file_name, url: a.url }))
  return out
}

const mapBid = (b) => ({
  id: b.id, project: b.project_name, projectId: b.project_code, category: b.project_category,
  amount: fmtPeso(b.amount), amountRaw: Number(b.amount || 0),
  submitted: fmtDate(b.submitted_at), submittedAt: b.submitted_at, status: b.status, notes: b.notes,
  deliveryTimeline: b.delivery_timeline || '',
  brandName: b.brand_name || '', modelNumber: b.model_number || '',
  additionalComments: b.additional_comments || '',
  files: collectBidFiles(b),
  documents: b.documents || [],  // per-document review state (flag/approve/resubmit)
  // Blockchain anchors for THIS bid (submitted / qualified / disqualified) — the
  // supplier's own tamper-evident proof of what they submitted and when.
  anchors: b.anchors || [],
  declarations: BID_DECLARATIONS.map(([key, label]) => ({ label, ok: !!b[key] })),
  // Product photos (up to 5) and the project rules that decide whether they
  // can still be changed (open + before deadline) and whether one is required.
  productImages: (b.product_images || []).map(mapProductImage),
  projectStatus: b.project_status || '',
  projectDeadline: b.project_deadline || null,
  requiresProductImages: !!b.project_requires_product_images,
  productImageInstructions: b.project_product_image_instructions || '',
})
const mapProductImage = (i) => ({ id: i.id, url: i.url, caption: i.caption || '' })

// ── Bid document upload rules (per-field types; shared 5 MB cap) ──────────────
const MAX_MB = 5
// accept: the <input accept> attribute; exts: allowed extensions; text: shown in the box.
const UPLOAD_RULES = {
  productImages: { accept: '.jpg,.jpeg,.png,.webp', exts: ['jpg', 'jpeg', 'png', 'webp'], text: 'JPG, PNG or WebP' },
  datasheet:     { accept: '.pdf,.docx,.xlsx', exts: ['pdf', 'docx', 'xlsx'], text: 'PDF, DOCX or XLSX' },
  compliance:    { accept: '.pdf', exts: ['pdf'], text: 'PDF only' },
  quotation:     { accept: '.pdf,.doc,.docx', exts: ['pdf', 'doc', 'docx'], text: 'PDF, DOC or DOCX' },
  technical:     { accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg', exts: ['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg'], text: 'PDF, DOC, DOCX, PNG or JPG' },
  other:         { accept: '.pdf,.jpg,.jpeg,.png,.docx,.xlsx', exts: ['pdf', 'jpg', 'jpeg', 'png', 'docx', 'xlsx'], text: 'PDF, JPG, PNG, DOCX or XLSX' },
}
// Returns an error string or null. Messages match the spec exactly.
function validateBidFile(file, rule) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (!rule.exts.includes(ext)) return 'Only the accepted file types are allowed.'
  if (file.size > MAX_MB * 1024 * 1024) return 'File must be under 5MB.'
  return null
}

// Legacy validator kept for the document re-submission panel (PDF/JPG/PNG).
const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png']
function validateFile(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (!ALLOWED_EXT.includes(ext)) return `Unsupported type ".${ext}". Use PDF, JPG, or PNG.`
  if (file.size > MAX_MB * 1024 * 1024) return `File is too large (max ${MAX_MB} MB).`
  return null
}

const QUAL_STATUS = {
  waiting_admin_approval: { label: 'Pending Review', tone: 'pending', text: 'Your registration is awaiting admin verification. You can browse projects, but bidding unlocks once approved.' },
  needs_revision:         { label: 'Action Required', tone: 'revision', text: 'The admin needs you to fix the documents below, then resubmit for review.' },
  verified:               { label: 'Approved', tone: 'approved', text: 'Your account is verified. You can submit bids on open projects.' },
  rejected:               { label: 'Rejected', tone: 'rejected', text: 'Your registration was rejected. See the message below.' },
}

const NAV_SECTIONS = [
  { label: 'Overview', items: [
    { icon: LayoutDashboard, label: 'Dashboard', to: '/supplier' },
  ] },
  { label: 'Bidding', items: [
    { icon: FolderOpen, label: 'Bid Opportunities', to: '/supplier/projects' },
    { icon: FileText,   label: 'My Bids',           to: '/supplier/bids' },
    { icon: Clock,      label: 'Status',            to: '/supplier/status' },
  ] },
  { label: 'Insights', items: [
    { icon: BarChart2, label: 'Reports', to: '/supplier/reports' },
  ] },
]

const BID_STATUS = {
  submitted:    'badge-yellow',
  under_review: 'badge-blue',
  shortlisted:  'badge-green',
  qualified:    'badge-green',
  winner:       'badge-purple',
  won:          'badge-purple',
  disqualified: 'badge-red',
  rejected:     'badge-red',
  lost:         'badge-red',
}

// ─── Bid submit modal — building blocks ──────────────────────────────────────

// Checklist row shown after a file is selected: filled emerald check + name + X.
function BidFileRow({ name, onRemove }) {
  return (
    <div className="sd-file-row">
      <span className="sd-file-check"><Check size={12} /></span>
      <span className="sd-file-rowname" title={name}>{name}</span>
      <button type="button" className="sd-file-remove" onClick={onRemove} aria-label="Remove file">
        <X size={14} />
      </button>
    </div>
  )
}

// One upload field: dashed box before upload, checklist row after.
function BidUpload({ label, required, rule, hint, file, error, onPick, onRemove }) {
  const ref = useRef(null)
  const pick = (f) => { if (f) onPick(f) }
  return (
    <div className="sd-upload-field">
      <label className="sd-upload-label">
        {label}{required ? <span className="sd-req"> *</span> : <span className="sd-optional"> (optional)</span>}
      </label>
      {file ? (
        <BidFileRow name={file.name} onRemove={onRemove} />
      ) : (
        <button type="button" className="sd-upload-box" onClick={() => ref.current?.click()}>
          <Upload size={16} />
          <span className="sd-upload-types">{rule.text}</span>
          <span className="sd-upload-size">up to {MAX_MB}MB</span>
        </button>
      )}
      <input ref={ref} type="file" accept={rule.accept} hidden
        onChange={e => { pick(e.target.files[0]); e.target.value = '' }} />
      {hint && <span className="sd-upload-hint">{hint}</span>}
      {error && <span className="sd-field-error">{error}</span>}
    </div>
  )
}

// A required-declaration checkbox with an inline error when left unchecked.
function BidDeclaration({ checked, onChange, error, children }) {
  return (
    <div className="sd-decl">
      <label className="sd-decl-label">
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
        <span>{children}</span>
      </label>
      {error && <span className="sd-field-error sd-decl-error">This declaration is required.</span>}
    </div>
  )
}

// ─── Product images ──────────────────────────────────────────────────────────
// Up to 5 photos of the offered product, each with an optional caption. The
// backend re-checks everything (real format via Pillow, size, count, deadline);
// these checks only save the supplier a failed round-trip.
const MAX_PRODUCT_IMAGES = 5
const CAPTION_MAX = 150

// Preview of a not-yet-uploaded File. The object URL is revoked on unmount so
// removed or submitted images don't leak memory.
function LocalThumb({ file, alt }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  return url ? <img src={url} alt={alt} /> : null
}

let pickSeq = 0

// Picker for NEW images: thumbnail, caption and remove per image, plus an add
// tile while there is room. `items` is [{ id, file, caption }]; `max` is how many
// more images this bid can take.
function ProductImagePicker({ items, onChange, max, disabled }) {
  const ref = useRef(null)
  const [pickError, setPickError] = useState('')

  const add = (fileList) => {
    const picked = Array.from(fileList || [])
    const next = []
    let err = ''
    for (const f of picked) {
      if (items.length + next.length >= max) { err = `You can attach up to ${MAX_PRODUCT_IMAGES} images per bid.`; break }
      const msg = validateBidFile(f, UPLOAD_RULES.productImages)
      if (msg) { err = `${f.name}: ${msg}`; continue }
      next.push({ id: ++pickSeq, file: f, caption: '' })
    }
    setPickError(err)
    if (next.length) onChange([...items, ...next])
  }
  const setCaption = (id, caption) =>
    onChange(items.map(i => (i.id === id ? { ...i, caption } : i)))
  const remove = (id) => { setPickError(''); onChange(items.filter(i => i.id !== id)) }

  return (
    <>
      <div className="sd-pimg-grid">
        {items.map((item, idx) => (
          <div className="sd-pimg-card" key={item.id}>
            <div className="sd-pimg-thumb">
              <LocalThumb file={item.file} alt={item.caption || `Product image ${idx + 1}`} />
              <button type="button" className="sd-pimg-remove" onClick={() => remove(item.id)}
                disabled={disabled} aria-label={`Remove ${item.file.name}`}>
                <X size={13} />
              </button>
            </div>
            <input className="sd-pimg-caption" type="text" maxLength={CAPTION_MAX}
              placeholder="Caption (optional)" value={item.caption} disabled={disabled}
              aria-label={`Caption for ${item.file.name}`}
              onChange={e => setCaption(item.id, e.target.value)} />
          </div>
        ))}
        {items.length < max && (
          <button type="button" className="sd-pimg-add" onClick={() => ref.current?.click()} disabled={disabled}>
            <Camera size={18} />
            <span>Add image</span>
            <span className="sd-upload-size">{UPLOAD_RULES.productImages.text} · {MAX_MB}MB</span>
          </button>
        )}
      </div>
      <input ref={ref} type="file" accept={UPLOAD_RULES.productImages.accept} multiple hidden
        onChange={e => { add(e.target.files); e.target.value = '' }} />
      {pickError && <span className="sd-field-error">{pickError}</span>}
    </>
  )
}

// Append picked images + their captions (same order) to a FormData.
function appendProductImages(fd, items) {
  items.forEach(i => {
    fd.append('product_images', i.file)
    fd.append('product_image_captions', i.caption.trim())
  })
}

// ─── Bid submit modal — step-by-step wizard ──────────────────────────────────

const BID_STEPS = ['Bid Details', 'Documents', 'Declarations']

function BidModal({ project, profile, onClose, onSubmit }) {
  const hasRef = !!project.referenceImage
  const needImages = project.requireProductImages
  const [step, setStep] = useState(0)
  const [amount, setAmount] = useState('')
  const [deliveryTimeline, setDeliveryTimeline] = useState('')
  const [notes, setNotes] = useState('')
  const [additionalComments, setAdditionalComments] = useState('')
  const [brandName, setBrandName] = useState('')
  const [modelNumber, setModelNumber] = useState('')
  const [warrantyPeriod, setWarrantyPeriod] = useState('')
  // Files
  const [productImages, setProductImages] = useState([])  // [{ id, file, caption }]
  const [datasheet, setDatasheet] = useState(null)
  const [compliance, setCompliance] = useState(null)
  const [quotation, setQuotation] = useState(null)
  const [technical, setTechnical] = useState(null)
  const [others, setOthers] = useState([])  // File[]
  // Checkboxes
  const [specMatch, setSpecMatch] = useState(false)
  const [terms, setTerms] = useState(false)
  const [interest, setInterest] = useState(false)
  const [scm, setScm] = useState(false)
  const [accuracy, setAccuracy] = useState(false)
  // UI state
  const [errors, setErrors] = useState({})
  const [fileErrors, setFileErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const otherRef = useRef(null)
  const scrollRef = useRef(null)

  // Reset the scroll to the top whenever the step changes.
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [step])

  // Live budget comparison.
  const bidValue = parseAmount(amount)
  const overBudget = bidValue > 0 && project.budgetRaw > 0 && bidValue > project.budgetRaw

  const pickFile = (rule, setter, key) => (file) => {
    const msg = validateBidFile(file, rule)
    if (msg) { setFileErrors(f => ({ ...f, [key]: msg })); return }
    setFileErrors(f => ({ ...f, [key]: '' }))
    setter(file)
  }

  const addOthers = (file) => {
    const msg = validateBidFile(file, UPLOAD_RULES.other)
    if (msg) { setFileErrors(f => ({ ...f, other: msg })); return }
    setFileErrors(f => ({ ...f, other: '' }))
    setOthers(list => [...list, file])
  }

  // Per-step validation — returns the errors for just that step (empty = valid).
  const errorsForStep = (s) => {
    const errs = {}
    if (s === 0) {
      if (!(bidValue > 0)) errs.amount = 'Please enter a valid bid amount greater than zero.'
      if (!deliveryTimeline.trim()) errs.deliveryTimeline = 'Please specify your delivery timeline.'
      if (notes.trim().length < 20) errs.notes = 'Please provide a more detailed proposal of at least 20 characters.'
    }
    if (s === 1) {
      if (!quotation) errs.quotation = 'Please upload your quotation document.'
      if (needImages && productImages.length === 0) errs.productImages = 'This procurement requires at least one product image.'
      if (hasRef && !specMatch) errs.specMatch = 'Please confirm your product matches the required specification.'
    }
    if (s === 2) {
      if (!terms) errs.terms = true
      if (!interest) errs.interest = true
      if (!scm) errs.scm = true
      if (!accuracy) errs.accuracy = true
    }
    return errs
  }

  const next = () => {
    const errs = errorsForStep(step)
    setErrors(errs)
    if (Object.keys(errs).length === 0) setStep(s => Math.min(s + 1, BID_STEPS.length - 1))
  }
  const back = () => setStep(s => Math.max(s - 1, 0))

  const handleSubmit = async (e) => {
    e.preventDefault()
    // Validate every step; jump to the first one with a problem if any.
    const all = { ...errorsForStep(0), ...errorsForStep(1), ...errorsForStep(2) }
    setErrors(all)
    if (Object.keys(all).length) {
      const firstBad = [0, 1, 2].find(s => Object.keys(errorsForStep(s)).length)
      if (firstBad !== undefined) setStep(firstBad)
      return
    }

    const fd = new FormData()
    fd.append('amount', bidValue)
    fd.append('delivery_timeline', deliveryTimeline.trim())
    fd.append('notes', notes.trim())
    fd.append('additional_comments', additionalComments.trim())
    fd.append('brand_name', brandName.trim())
    fd.append('model_number', modelNumber.trim())
    fd.append('warranty_period', warrantyPeriod.trim())
    fd.append('terms_accepted', terms)
    fd.append('interest_declared', interest)
    fd.append('scm_declared', scm)
    fd.append('accuracy_confirmed', accuracy)
    fd.append('specification_confirmed', specMatch)
    if (quotation) fd.append('quotation_document', quotation)
    if (technical) fd.append('technical_document', technical)
    appendProductImages(fd, productImages)
    if (datasheet) fd.append('supplier_datasheet', datasheet)
    if (compliance) fd.append('supplier_compliance_doc', compliance)
    others.forEach(f => fd.append('other_attachments', f))

    setSubmitting(true)
    const ok = await onSubmit(project, fd)
    setSubmitting(false)
    if (ok) onClose()
  }

  const companyName = profile?.company || '—'
  const businessType = profile?.business_type || profileBusinessTypes(profile).join(', ') || '—'
  const isLast = step === BID_STEPS.length - 1

  return (
    <div className="sd-modal-overlay" onClick={() => !submitting && onClose()}>
      <form className="sd-modal sd-modal-lg" onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="sd-modal-header">
          <div>
            <h3>Submit Bid</h3>
            <p className="sd-muted sd-small">{project.id} · {project.name}</p>
          </div>
          <button type="button" className="sd-modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        {/* Stepper — same pattern as the supplier registration form */}
        <div className="sd-bid-stepper">
          {BID_STEPS.map((label, i) => (
            <div key={label} className="sd-bid-step-wrap">
              <div className={`sd-bid-step${i < step ? ' done' : ''}${i === step ? ' active' : ''}`}>
                {i < step ? <Check size={15} /> : i + 1}
              </div>
              <span className={i === step ? 'active' : ''}>{label}</span>
              {i < BID_STEPS.length - 1 && <div className={`sd-bid-line${i < step ? ' done' : ''}`} />}
            </div>
          ))}
        </div>

        <div className="sd-bid-scroll" ref={scrollRef}>
          {/* Reference image + metadata give context while pricing and matching */}
          {hasRef && step < 2 && (
            <div className="sd-refimg-section">
              <div className="sd-refimg-label"><Camera size={14} /> Required Product Reference</div>
              <img src={project.referenceImage} alt="Required product reference" className="sd-refimg-cover" />
              <p className="sd-refimg-note">
                This image shows the exact product specification required by the procuring entity.
                Your bid must match this specification.
              </p>
            </div>
          )}
          <div className="sd-modal-meta">
            <div><span>Budget</span><strong>{project.budget}</strong></div>
            <div><span>Deadline</span><strong>{project.deadline}</strong></div>
            <div><span>Category</span><strong>{project.category}</strong></div>
          </div>

          <div className="sd-bid-body">
            {/* ── STEP 1 — Bid details ───────────────────────────────────── */}
            {step === 0 && (
              <div className="sd-bid-section">
                <h4 className="sd-bid-section-label">Required Information</h4>
                <div className="sd-form-group">
                  <label>Your Bid Amount <span className="sd-req">*</span></label>
                  <div className="sd-peso-input">
                    <span className="sd-peso-prefix">₱</span>
                    <input type="number" min="0" placeholder="e.g. 850000" value={amount}
                      onChange={e => { setAmount(e.target.value); setErrors(x => ({ ...x, amount: '' })) }} />
                  </div>
                  {bidValue > 0 && (
                    <span className={overBudget ? 'sd-budget-warn' : 'sd-budget-ok'}>
                      {overBudget ? 'Warning: this bid exceeds the project budget.' : 'Within project budget.'}
                    </span>
                  )}
                  {errors.amount && <span className="sd-field-error">{errors.amount}</span>}
                </div>

                <div className="sd-form-group">
                  <label>Delivery Timeline <span className="sd-req">*</span></label>
                  <input type="text" placeholder="e.g. 30 days or 6 weeks" value={deliveryTimeline}
                    onChange={e => { setDeliveryTimeline(e.target.value); setErrors(x => ({ ...x, deliveryTimeline: '' })) }} />
                  <span className="sd-upload-hint">Specify how many days or weeks from contract signing until full delivery is completed.</span>
                  {errors.deliveryTimeline && <span className="sd-field-error">{errors.deliveryTimeline}</span>}
                </div>

                <div className="sd-form-group">
                  <label>Notes and Proposal Summary <span className="sd-req">*</span></label>
                  <textarea rows={5}
                    placeholder="Briefly describe your approach, timeline, qualifications and how you will fulfill the project requirements."
                    value={notes}
                    onChange={e => { setNotes(e.target.value); setErrors(x => ({ ...x, notes: '' })) }} />
                  <span className={`sd-charcount${notes.trim().length < 20 ? ' sd-charcount-low' : ''}`}>
                    {notes.trim().length} / 20 characters minimum
                  </span>
                  {errors.notes && <span className="sd-field-error">{errors.notes}</span>}
                </div>
              </div>
            )}

            {step === 0 && (
              <div className="sd-bid-section">
                <h4 className="sd-bid-section-label">Product Details <span className="sd-optional">(optional)</span></h4>
                <p className="sd-bid-section-hint">If you are offering a specific branded product, provide its details below.</p>
                <div className="sd-form-group">
                  <label>Brand Name</label>
                  <input type="text" placeholder="e.g. HP, Samsung" value={brandName}
                    onChange={e => setBrandName(e.target.value)} />
                </div>
                <div className="sd-form-group">
                  <label>Model Number</label>
                  <input type="text" placeholder="e.g. ProBook 450 G9" value={modelNumber}
                    onChange={e => setModelNumber(e.target.value)} />
                </div>
                <div className="sd-form-group">
                  <label>Warranty Period</label>
                  <input type="text" placeholder="e.g. 1 year parts and labor" value={warrantyPeriod}
                    onChange={e => setWarrantyPeriod(e.target.value)} />
                </div>
              </div>
            )}

            {/* ── STEP 2 — Documents (product response + supporting docs) ─── */}
            {step === 1 && (
              <>
                {/* Always offered, on every bidding — not just the ones that
                    happen to carry a reference image. A supplier bidding on a
                    specific product is usually the one with the strongest case
                    to make visually, and letting them show it is what puts the
                    Admin in a position to compare offers on the actual goods
                    rather than on price alone. Everything here is optional
                    unless the Admin switched on "Require product images" for
                    this procurement, in which case at least one photo is. The
                    spec-match declaration is conditional too, because it refers
                    to a reference image that may not exist. */}
                <div className="sd-bid-section">
                  <h4 className="sd-bid-section-label">
                    Your Product Response {!needImages && <span className="sd-optional">(optional)</span>}
                  </h4>
                  <p className="sd-bid-section-hint">
                    {needImages
                      ? 'This procurement requires photos of the exact product you are offering. Add its documents too if you have them.'
                      : hasRef
                      ? 'Upload files showing your matching product and confirm your product meets the specification.'
                      : 'Bidding with a specific product? Add photos and its documents so the evaluators can see exactly what you are offering. This is optional and does not affect your eligibility.'}
                  </p>
                  <div className="sd-upload-field">
                    <label className="sd-upload-label">
                      Product Images{needImages ? <span className="sd-req"> *</span> : <span className="sd-optional"> (optional)</span>}
                    </label>
                    {needImages && project.productImageInstructions && (
                      <p className="sd-pimg-instructions"><Camera size={13} /> {project.productImageInstructions}</p>
                    )}
                    <span className="sd-upload-hint">
                      Up to {MAX_PRODUCT_IMAGES} photos, {MAX_MB}MB each. Add a caption such as “Brand X Model Y, front view”.
                    </span>
                    <ProductImagePicker items={productImages} max={MAX_PRODUCT_IMAGES}
                      onChange={v => { setProductImages(v); setErrors(x => ({ ...x, productImages: '' })) }} />
                    {errors.productImages && <span className="sd-field-error">{errors.productImages}</span>}
                  </div>
                  <BidUpload label="Product Datasheet" rule={UPLOAD_RULES.datasheet}
                    file={datasheet} error={fileErrors.datasheet}
                    onPick={pickFile(UPLOAD_RULES.datasheet, setDatasheet, 'datasheet')}
                    onRemove={() => setDatasheet(null)} />
                  <BidUpload label="Compliance / Certificate Document" rule={UPLOAD_RULES.compliance}
                    file={compliance} error={fileErrors.compliance}
                    onPick={pickFile(UPLOAD_RULES.compliance, setCompliance, 'compliance')}
                    onRemove={() => setCompliance(null)} />
                  {hasRef && (
                    <div className="sd-decl">
                      <label className="sd-decl-label">
                        <input type="checkbox" checked={specMatch}
                          onChange={e => { setSpecMatch(e.target.checked); setErrors(x => ({ ...x, specMatch: '' })) }} />
                        <span>My offered product matches the required specification shown in the reference image above.</span>
                      </label>
                      {errors.specMatch && <span className="sd-field-error sd-decl-error">{errors.specMatch}</span>}
                    </div>
                  )}
                </div>

                <div className="sd-bid-section">
                  <h4 className="sd-bid-section-label">Supporting Documents</h4>
                  <BidUpload label="Quotation Document" required rule={UPLOAD_RULES.quotation}
                    file={quotation} error={fileErrors.quotation}
                    onPick={pickFile(UPLOAD_RULES.quotation, setQuotation, 'quotation')}
                    onRemove={() => setQuotation(null)} />
                  {errors.quotation && <span className="sd-field-error">{errors.quotation}</span>}
                  <BidUpload label="Technical Proposal" rule={UPLOAD_RULES.technical}
                    file={technical} error={fileErrors.technical}
                    onPick={pickFile(UPLOAD_RULES.technical, setTechnical, 'technical')}
                    onRemove={() => setTechnical(null)} />

                  <div className="sd-upload-field">
                    <label className="sd-upload-label">Other Attachments <span className="sd-optional"> (optional)</span></label>
                    {others.map((f, i) => (
                      <BidFileRow key={i} name={f.name}
                        onRemove={() => setOthers(list => list.filter((_, idx) => idx !== i))} />
                    ))}
                    {others.length === 0 ? (
                      <button type="button" className="sd-upload-box" onClick={() => otherRef.current?.click()}>
                        <Upload size={16} />
                        <span className="sd-upload-types">{UPLOAD_RULES.other.text}</span>
                        <span className="sd-upload-size">up to {MAX_MB}MB</span>
                      </button>
                    ) : (
                      <button type="button" className="sd-add-file" onClick={() => otherRef.current?.click()}>
                        <Plus size={13} /> Add another file
                      </button>
                    )}
                    <input ref={otherRef} type="file" accept={UPLOAD_RULES.other.accept} hidden
                      onChange={e => { if (e.target.files[0]) addOthers(e.target.files[0]); e.target.value = '' }} />
                    {fileErrors.other && <span className="sd-field-error">{fileErrors.other}</span>}
                  </div>
                </div>
              </>
            )}

            {/* ── STEP 3 — Declarations, comments, company summary ────────── */}
            {step === 2 && (
              <>
                <div className="sd-bid-section">
                  <h4 className="sd-bid-section-label">Declarations and Compliance</h4>
                  <p className="sd-bid-section-hint">All declarations are required by Philippine Government Procurement Law RA 9184 and must be confirmed before submitting your bid.</p>
                  <BidDeclaration checked={terms} error={errors.terms}
                    onChange={v => { setTerms(v); setErrors(x => ({ ...x, terms: false })) }}>
                    I agree to be bound by the terms and conditions of this procurement bid as stated in the Invitation to Bid. This represents SBD 1 acceptance.
                  </BidDeclaration>
                  <BidDeclaration checked={interest} error={errors.interest}
                    onChange={v => { setInterest(v); setErrors(x => ({ ...x, interest: false })) }}>
                    I declare that I have no existing relationship or acquaintance with any member of the Bids and Awards Committee or school administration that could influence this bid. This represents SBD 4 Declaration of Interest.
                  </BidDeclaration>
                  <BidDeclaration checked={scm} error={errors.scm}
                    onChange={v => { setScm(v); setErrors(x => ({ ...x, scm: false })) }}>
                    I declare that I have never been blacklisted, suspended or penalized in any government procurement process in the Philippines. This represents SBD 8 Past Supply Chain Management Practices Declaration.
                  </BidDeclaration>
                  <BidDeclaration checked={accuracy} error={errors.accuracy}
                    onChange={v => { setAccuracy(v); setErrors(x => ({ ...x, accuracy: false })) }}>
                    I confirm that all information and documents submitted in this bid are true, accurate and complete to the best of my knowledge.
                  </BidDeclaration>
                </div>

                <div className="sd-bid-section">
                  <div className="sd-form-group">
                    <label>Additional Comments for the Procuring Entity</label>
                    <textarea rows={3} placeholder="Any additional information you want to share with the evaluator."
                      value={additionalComments} onChange={e => setAdditionalComments(e.target.value)} />
                  </div>
                </div>

                <div className="sd-bid-section">
                  <div className="sd-company-box">
                    <div className="sd-company-fields">
                      <div className="sd-company-field">
                        <span className="sd-profile-label">Company Name</span>
                        <span className="sd-profile-value">{companyName}</span>
                      </div>
                      <div className="sd-company-field">
                        <span className="sd-profile-label">Business Type</span>
                        <span className="sd-profile-value">{businessType}</span>
                      </div>
                    </div>
                    <p className="sd-company-note">
                      Your registered business documents on file will be used for eligibility verification.
                      The documents submitted during registration including your Business Permit, BIR Certificate
                      and PhilGEPS Certificate are already on record.
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Action buttons — always visible, outside the scroll area */}
        <div className="sd-modal-footer sd-bid-footer">
          <button type="button" className="sd-btn-cancel" onClick={onClose} disabled={submitting}>Cancel</button>
          <div className="sd-bid-footer-right">
            {step > 0 && (
              <button type="button" className="sd-btn-back" onClick={back} disabled={submitting}>Back</button>
            )}
            {isLast ? (
              <button type="submit" className="sd-btn-primary" disabled={submitting}>
                {submitting
                  ? <><Loader2 size={14} className="sd-spin" /> Submitting…</>
                  : <><Send size={14} /> Submit Bid</>}
              </button>
            ) : (
              <button type="button" className="sd-btn-primary" onClick={next}>Continue</button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}

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
                <img src={img.url} alt={img.caption || `Product image ${idx + 1}`} loading="lazy" />
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
  const canWithdraw = bid.status === 'submitted' || bid.status === 'under_review'
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
            <div><span>Blockchain</span><strong><BlockchainBadge anchors={bid.anchors} /></strong></div>
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
                  The admin flagged the document(s) below. You're still in this bidding — just
                  re-upload the fixed file(s) and resubmit.
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
                  Official documents issued to you for this contract. Each is recorded on the
                  blockchain — you can verify any of them on the public results page.
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
                      {d.anchored && (
                        <span className="sd-award-doc-chain" title={`Anchored on-chain (tx ${d.tx_hash})`}>
                          <Shield size={11} /> Verified
                        </span>
                      )}
                      <span className="sd-doc-view"><Eye size={13} /> Download</span>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Proof of submission: the hash of this bid + its quotation, and
                the Sepolia transaction that witnesses it. If a step was never
                anchored (MetaMask declined, no wallet at the time), it can be
                anchored from here — the hash is unchanged. */}
            <div className="sd-bid-section">
              <BlockchainTrail
                anchors={bid.anchors}
                title="Blockchain Proof of Submission"
                entityRef={bid.projectId}
              />
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

// ─── Verification banner + revision panel ────────────────────────────────────

function SupplierToast({ type, message, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000)
    return () => clearTimeout(t)
  }, [onClose])
  return (
    <div className={`sd-toast sd-toast-${type}`} role="status">
      {type === 'error' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
      <span>{message}</span>
    </div>
  )
}

function VerificationBanner({ profile }) {
  if (!profile) return null
  const info = QUAL_STATUS[profile.qualification_status]
  if (!info || info.tone === 'approved') return null  // hide when verified
  return (
    <div className={`sd-verify-banner sd-verify-${info.tone}`} role="status">
      <div className="sd-verify-icon">
        {info.tone === 'rejected' ? <X size={18} /> : info.tone === 'revision' ? <AlertTriangle size={18} /> : <Clock size={18} />}
      </div>
      <div className="sd-verify-text">
        <span className="sd-bold">{info.label}</span>
        <span className="sd-muted sd-small">{info.text}</span>
        {profile.admin_notes && <span className="sd-verify-note">“{profile.admin_notes}”</span>}
      </div>
    </div>
  )
}

// Shown until the supplier confirms their email via the link we mailed them
// at registration — independent of qualification_status, so it can appear
// alongside any of those banners.
function EmailVerifyBanner({ profile, setToast }) {
  const [sending, setSending] = useState(false)
  if (!profile || profile.email_verified) return null

  const resend = async () => {
    setSending(true)
    try {
      await apiResendVerification()
      setToast({ type: 'success', message: 'Verification email sent. Check your inbox.' })
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not send the verification email.' })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="sd-verify-banner sd-verify-pending">
      <div className="sd-verify-icon"><Send size={16} /></div>
      <div className="sd-verify-text">
        <span className="sd-bold">Verify your email</span>
        <span className="sd-muted sd-small">
          Confirm your email address so we can reach you with bid results and account updates.
        </span>
      </div>
      <button type="button" className="sd-btn-back" disabled={sending} onClick={resend}>
        {sending ? 'Sending…' : 'Resend Email'}
      </button>
    </div>
  )
}

// Lists the documents the admin flagged and lets the supplier re-upload + resubmit.
function RevisionPanel({ profile, onResubmitted, setToast }) {
  const flagged = (profile?.documents || []).filter(d => d.review_status === 'needs_revision')
  const [files, setFiles] = useState({})  // { key: File }
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const refs = useRef({})

  if (profile?.qualification_status !== 'needs_revision' || flagged.length === 0) return null

  const onFile = (key, file) => {
    if (!file) return
    const msg = validateFile(file)
    if (msg) { setToast({ type: 'error', message: `${key.replace(/_/g, ' ')}: ${msg}` }); return }
    setFiles(f => ({ ...f, [key]: file }))
  }

  const allReplaced = flagged.every(d => files[d.key])

  const doResubmit = async () => {
    setBusy(true)
    try {
      const fd = new FormData()
      Object.entries(files).forEach(([k, file]) => fd.append(k, file))
      await apiResubmitDocuments(fd)
      setToast({ type: 'success', message: 'Documents resubmitted. Your account is pending review again.' })
      setConfirm(false)
      onResubmitted()
    } catch (err) {
      setToast({ type: 'error', message: err.message })
      setConfirm(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sd-card sd-revision-card">
      <div className="sd-card-header">
        <div><h2>Documents Needing Revision</h2><p>Re-upload the flagged documents, then resubmit for review.</p></div>
      </div>
      <div className="sd-revision-list">
        {flagged.map(d => (
          <div className="sd-revision-row" key={d.key}>
            <div className="sd-revision-info">
              <span className="sd-bold">{d.label}</span>
              {d.review_note && <span className="sd-revision-note"><AlertTriangle size={12} /> {d.review_note}</span>}
            </div>
            <div className="sd-revision-action">
              {files[d.key] ? (
                <div className="sd-revision-file">
                  <FileText size={14} /><span className="sd-file-name" title={files[d.key].name}>{files[d.key].name}</span>
                  <button onClick={() => setFiles(f => { const n = { ...f }; delete n[d.key]; return n })}><X size={14} /></button>
                </div>
              ) : (
                <button className="sd-reupload-btn" onClick={() => refs.current[d.key]?.click()}>
                  <Upload size={14} /> Re-upload
                </button>
              )}
              <input ref={el => (refs.current[d.key] = el)} type="file" accept=".pdf,.jpg,.jpeg,.png" hidden
                onChange={e => onFile(d.key, e.target.files[0])} />
            </div>
          </div>
        ))}
      </div>
      <div className="sd-revision-footer">
        <button
          className="sd-btn-primary"
          disabled={!allReplaced || busy}
          onClick={() => setConfirm(true)}
        >
          <Send size={14} /> Resubmit for Review
        </button>
        {!allReplaced && <span className="sd-muted sd-small">Replace all flagged documents to enable resubmission.</span>}
      </div>

      {confirm && (
        <div className="sd-modal-overlay" onClick={() => !busy && setConfirm(false)}>
          <div className="sd-confirm" onClick={e => e.stopPropagation()}>
            <div className="sd-confirm-icon"><Send size={20} /></div>
            <h4>Resubmit documents?</h4>
            <p>Your account will go back to <b>Pending Review</b> until the admin checks your updated documents.</p>
            <div className="sd-confirm-actions">
              <button className="sd-btn-cancel" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
              <button className="sd-btn-primary" onClick={doResubmit} disabled={busy}>{busy ? 'Sending…' : 'Resubmit'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Pages ───────────────────────────────────────────────────────────────────

// Approval state as a tone for the status card / tracker.
const QUAL_TONE = { pending: 'warning', revision: 'warning', approved: 'success', rejected: 'danger' }

// Registered → Admin Verification → Eligible to Bid, with what happens next.
function OnboardingTracker({ profile, eligible }) {
  const qs = profile?.qualification_status
  const info = QUAL_STATUS[qs]
  const verifyState = eligible ? 'done' : qs === 'rejected' ? 'error' : qs === 'needs_revision' ? 'attention' : 'current'
  const steps = [
    { label: 'Registered', desc: profile?.registered ? `Account created ${profile.registered}` : 'Account created', state: 'done', icon: CheckCircle2 },
    {
      label: 'Admin Verification',
      desc: info?.label || 'Pending Review',
      state: verifyState,
      icon: verifyState === 'done' ? CheckCircle2 : verifyState === 'error' ? XCircle : verifyState === 'attention' ? AlertTriangle : Clock,
    },
    {
      label: 'Eligible to Bid',
      desc: eligible ? 'Active on all open projects' : 'Locked until approved',
      state: eligible ? 'done' : 'upcoming',
      icon: eligible ? CheckCircle2 : Lock,
    },
  ]
  const next = eligible
    ? 'You can submit bids on any open procurement that matches your registered categories.'
    : qs === 'needs_revision'
    ? 'Re-upload the flagged documents above and resubmit — the admin will review them again.'
    : qs === 'rejected'
    ? 'Your registration was not approved. Read the admin’s note above for the reason.'
    : 'The procurement office is checking your company details and documents. You’ll be notified by email once a decision is made.'
  return (
    <div className="sd-card sd-onboard">
      <div className="sd-card-header">
        <div><h2>Account Status</h2><p>Your registration and approval details</p></div>
        <StatusBadge tone={QUAL_TONE[info?.tone] || 'warning'} label={info?.label || 'Pending Review'} />
      </div>
      <ol className="sd-onboard-steps">
        {steps.map(({ label, desc, state, icon: Icon }, i) => (
          <li key={label} className={`sd-onboard-step is-${state}`} aria-current={state === 'current' || state === 'attention' ? 'step' : undefined}>
            <span className="sd-onboard-dot" aria-hidden="true"><Icon size={16} /></span>
            <div className="sd-onboard-text">
              <span className="sd-onboard-n">Step {i + 1}</span>
              <span className="sd-bold">{label}</span>
              <span className="sd-muted sd-small">{desc}</span>
            </div>
          </li>
        ))}
      </ol>
      <div className="sd-onboard-next">
        <ArrowRight size={14} aria-hidden="true" />
        <span><strong>What happens next:</strong> {next}</span>
      </div>
    </div>
  )
}

function SupplierHome({ projects, bids, onBid, eligible, profile, onResubmitted, setToast, loadingProjects, loadingBids }) {
  const [modal, setModal] = useState(null)
  const alreadyBid = new Set(bids.map(b => b.projectId))
  const available = projects.filter(p => !alreadyBid.has(p.id))
  const qualInfo = QUAL_STATUS[profile?.qualification_status]
  const approvalLabel = qualInfo?.label || 'Pending'

  return (
    <div className="sd-content">
      {modal && <BidModal project={modal} profile={profile} onClose={() => setModal(null)} onSubmit={onBid} />}

      <VerificationBanner profile={profile} />
      <EmailVerifyBanner profile={profile} setToast={setToast} />
      <RevisionPanel profile={profile} onResubmitted={onResubmitted} setToast={setToast} />

      <div className="sd-stats">
        {[
          { label: 'Eligible Projects', value: String(projects.length),                                 icon: FolderOpen,   color: 'blue',  sub: 'Open and matching your categories' },
          { label: 'My Active Bids',  value: String(bids.length),                                       icon: FileText,     color: 'green', sub: 'Submitted by your company' },
          { label: 'Shortlisted',     value: String(bids.filter(b => b.status === 'qualified').length), icon: CheckCircle2, color: 'green', sub: 'Qualified in evaluation' },
        ].map(({ label, value, icon: Icon, color, sub }) => (
          <div className="sd-stat-card" key={label}>
            <div className="sd-stat-top">
              <span className="sd-stat-label">{label}</span>
              <div className={`sd-stat-icon sd-icon-${color}`} aria-hidden="true"><Icon size={17} /></div>
            </div>
            <div className="sd-stat-value">{(label === 'Eligible Projects' ? loadingProjects : loadingBids) && value === '0' ? <ListSkeleton rows={1} height={26} /> : value}</div>
            <div className="sd-stat-sub">{sub}</div>
          </div>
        ))}
        {/* Approval is a state, not a count — shown as a badge + explanation. */}
        <div className={`sd-stat-card sd-status-tile is-${qualInfo?.tone || 'pending'}`}>
          <div className="sd-stat-top">
            <span className="sd-stat-label">Approval Status</span>
            <div className={`sd-stat-icon sd-icon-${eligible ? 'green' : 'yellow'}`} aria-hidden="true"><Shield size={17} /></div>
          </div>
          <div className="sd-status-tile-badge">
            <StatusBadge size="lg" tone={QUAL_TONE[qualInfo?.tone] || 'warning'} label={approvalLabel} />
          </div>
          <div className="sd-stat-sub">
            {eligible ? 'You can bid on open projects.' : 'Bidding unlocks once the admin approves your account.'}
          </div>
        </div>
      </div>

      <div className="sd-grid">
        <div className="sd-card sd-card-wide">
          <div className="sd-card-header">
            <div><h2>Bid Opportunities</h2><p>Open procurements matching your business that you can bid on</p></div>
            <Link to="/supplier/projects" className="sd-view-all">View all →</Link>
          </div>
          {loadingProjects && projects.length === 0 ? (
            <div style={{ padding: '12px 24px' }}><ListSkeleton rows={3} height={52} /></div>
          ) : available.length === 0 ? (
            projects.length === 0
              ? <EmptyState compact icon={FolderOpen} title="No matching procurements yet"
                  description="No open procurements match your registered categories yet."
                  action={<Link to="/public" className="sd-btn-cancel">View public procurements</Link>} />
              : <EmptyState compact icon={CheckCircle2} title="You're up to date"
                  description="You have already submitted bids on all eligible procurements."
                  action={<Link to="/supplier/bids" className="sd-btn-cancel">Track my bids</Link>} />
          ) : (
            <div className="sd-projects-list">
              {available.map(p => {
                const due = deadlineMeta(p.deadline)
                return (
                  <div className="sd-project-row" key={p.id}>
                    <div className="sd-proj-icon" aria-hidden="true"><FolderOpen size={16} /></div>
                    <div className="sd-proj-info">
                      <span className="sd-bold">{p.name}</span>
                      <span className="sd-proj-sub"><span className="sd-mono">{p.id}</span> {p.category}</span>
                    </div>
                    <div className="sd-proj-right">
                      <span className="sd-proj-budget">{p.budget}</span>
                      <span className="sd-muted sd-small">Due {p.deadline}</span>
                    </div>
                    {p.isExpired
                      ? <StatusBadge tone="danger" label="Deadline Passed" />
                      : <>
                          {due && <StatusBadge tone={due.tone} icon={Clock} label={due.label} />}
                          {eligible
                            ? <button className="sd-bid-btn" onClick={() => setModal(p)}>Bid <ArrowRight size={13} /></button>
                            : <button className="sd-bid-btn sd-bid-locked" disabled title="Approval required before bidding"><Lock size={12} /> Locked</button>}
                        </>}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="sd-card">
          <div className="sd-card-header">
            <div><h2>My Bids</h2><p>Your submitted bids</p></div>
            {bids.length > 0 && <Link to="/supplier/bids" className="sd-view-all">View all →</Link>}
          </div>
          {loadingBids && bids.length === 0 ? (
            <div style={{ padding: '12px 24px' }}><ListSkeleton rows={2} height={48} /></div>
          ) : bids.length === 0 ? (
            <EmptyState compact icon={FileText} title="No bids submitted yet"
              description={eligible ? 'Pick an open procurement and submit your first bid.' : 'Once your account is approved you can start bidding.'}
              action={eligible
                ? <Link to="/supplier/projects" className="sd-btn-primary">Browse opportunities</Link>
                : <Link to="/supplier/profile" className="sd-btn-cancel">Complete your profile</Link>} />
          ) : (
            <div className="sd-bids-list">
              {bids.map((b, i) => (
                <div className="sd-bid-row" key={i}>
                  <div className="sd-bid-info">
                    <span className="sd-bold">{b.project}</span>
                    <span className="sd-muted sd-small">Submitted {b.submitted}</span>
                  </div>
                  <div className="sd-bid-right">
                    <span className="sd-proj-budget">{b.amount}</span>
                    <StatusBadge domain="bid" status={b.status} label={BID_LABEL[b.status]} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <OnboardingTracker profile={profile} eligible={eligible} />
    </div>
  )
}

function SupplierProjects({ projects, bids, onBid, eligible, loading, profile }) {
  const [modal, setModal] = useState(null)
  const [search, setSearch] = useState('')
  const alreadyBid = new Set(bids.map(b => b.projectId))

  const filtered = projects.filter(p => {
    const q = search.trim().toLowerCase()
    return !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)
  })

  return (
    <div className="sd-content">
      {modal && <BidModal project={modal} profile={profile} onClose={() => setModal(null)} onSubmit={onBid} />}
      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>Bid Opportunities</h2><p>Procurements open for bidding that match your registered business categories</p></div>
          {projects.length > 0 && (
            <label className="sd-search-inline">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search projects</span>
              <input placeholder="Search projects" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
          )}
        </div>
        {loading && projects.length === 0 ? (
          <table className="sd-table">
            <thead>
              <tr><th>ID</th><th>Project</th><th>Budget</th><th>Category</th><th>Deadline</th><th></th></tr>
            </thead>
            <tbody><TableSkeleton rows={4} cols={6} /></tbody>
          </table>
        ) : projects.length === 0 ? (
          <EmptyState icon={FolderOpen} title="No open procurements right now"
            description="No open procurements match your categories right now. Check back later."
            action={<>
              <Link to="/public" className="sd-btn-cancel">View public procurements</Link>
              <Link to="/supplier/profile" className="sd-btn-cancel">Review my categories</Link>
            </>} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Search} title="No matching projects" description={`No projects match "${search}".`}
            action={<button className="sd-btn-cancel" onClick={() => setSearch('')}>Clear search</button>} />
        ) : (
          <div className="sd-table-scroll">
          <table className="sd-table">
            <thead>
              <tr><th>ID</th><th>Project</th><th className="sd-num">Budget</th><th>Category</th><th>Deadline</th><th><span className="sr-only">Action</span></th></tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id}>
                  <td className="sd-mono">{p.id}</td>
                  <td>
                    <div className="sd-bold">{p.name}</div>
                    <div className="sd-muted sd-small" style={{ maxWidth: 220 }}>{p.description}</div>
                  </td>
                  <td className="sd-num">{p.budget}</td>
                  <td><span className="ui-badge ui-badge--neutral">{p.category}</span></td>
                  <td>
                    <div className="sd-deadline-cell">
                      <span className="sd-nowrap">{p.deadline}</span>
                      {!p.isExpired && deadlineMeta(p.deadline) && (
                        <StatusBadge tone={deadlineMeta(p.deadline).tone} dot={false} icon={Clock} label={deadlineMeta(p.deadline).label} />
                      )}
                    </div>
                  </td>
                  <td className="sd-action-cell">
                    {alreadyBid.has(p.id)
                      ? <StatusBadge tone="success" icon={CheckCircle2} label="Bid Submitted" />
                      : p.isExpired
                      ? <StatusBadge tone="danger" label="Deadline Passed" />
                      : eligible
                      ? <button className="sd-bid-btn-table" onClick={() => setModal(p)}>Submit Bid</button>
                      : <StatusBadge tone="neutral" icon={Lock} label="Locked" title="Approval required before bidding" />}
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

function SupplierBids({ bids, awards = [], onWithdraw, loading, onResubmitted, setToast }) {
  const [detail, setDetail] = useState(null)
  const [search, setSearch] = useState('')

  const filtered = bids.filter(b => {
    const q = search.trim().toLowerCase()
    return !q || b.project.toLowerCase().includes(q)
  })

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
          <div><h2>My Bids</h2><p>Track all your submitted bids and their evaluation status</p></div>
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
            description="No bids submitted yet. Browse projects to submit your first bid."
            action={<Link to="/supplier/projects" className="sd-btn-primary">Browse bid opportunities</Link>} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Search} title="No matching bids" description={`No bids match "${search}".`}
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

const BID_LABEL = {
  under_review: 'Under Review', qualified: 'Qualified',
  disqualified: 'Disqualified', winner: 'Winner',
}

function SupplierReportsPage({ bids, profile }) {
  const totalBids   = bids.length
  const underReview = bids.filter(b => b.status === 'under_review').length
  const qualified   = bids.filter(b => b.status === 'qualified').length
  const won         = bids.filter(b => b.status === 'winner').length
  const awardedValue = bids.filter(b => b.status === 'winner').reduce((s, b) => s + b.amountRaw, 0)

  const stats = [
    { label: 'TOTAL BIDS',     value: totalBids,            cls: ''             },
    { label: 'UNDER REVIEW',   value: underReview,          cls: 'sd-val-yellow' },
    { label: 'QUALIFIED',      value: qualified,            cls: 'sd-val-blue'   },
    { label: 'WON',            value: won,                  cls: 'sd-val-purple' },
    { label: 'AWARDED VALUE',  value: fmtPeso(awardedValue), cls: 'sd-val-green'  },
  ]

  const categoryCount = bids.reduce((acc, b) => {
    const key = b.category || 'Uncategorized'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})

  const reportShape = {
    title: 'My Bidding Report',
    stats: stats.map(({ label, value }) => ({ label, value })),
    sections: [
      {
        heading: 'By Category',
        columns: ['Category', 'Bids'],
        rows: Object.entries(categoryCount).map(([cat, count]) => [cat, count]),
      },
      {
        heading: 'Bid History',
        columns: ['Project', 'Amount', 'Status', 'Submitted'],
        rows: bids.map(b => [b.project, b.amount, BID_LABEL[b.status] || b.status, b.submitted]),
      },
    ],
  }

  const filename = `my-bidding-report-${new Date().toISOString().slice(0, 10)}`

  return (
    <div className="sd-content">
      <div className="sd-report-bar">
        <div>
          <h2 className="sd-bold" style={{ fontSize: 16 }}>{profile?.company || 'My'} Bidding Report</h2>
          <p className="sd-muted sd-small">A summary of your bid history and performance.</p>
        </div>
        <div className="sd-export-btns">
          <button className="sd-btn-export-csv" onClick={() => exportReportCSV(reportShape, `${filename}.csv`)}>
            <FileText size={14} aria-hidden="true" /> Export CSV
          </button>
          <button className="sd-btn-primary" onClick={() => exportReportPDF(reportShape, `${filename}.pdf`)}>
            <FileText size={14} aria-hidden="true" /> Export PDF
          </button>
        </div>
      </div>

      <div className="sd-report-stats">
        {stats.map(({ label, value, cls }) => (
          <div className="sd-stat-card" key={label}>
            <div className="sd-stat-label">{label}</div>
            <div className="sd-stat-value sd-stat-value-sm">{value}</div>
          </div>
        ))}
      </div>

      <div className="sd-card">
        <div className="sd-card-header"><h2>By Category</h2></div>
        <table className="sd-table">
          <thead><tr><th>CATEGORY</th><th>BIDS</th></tr></thead>
          <tbody>
            {Object.keys(categoryCount).length === 0 ? (
              <TableEmpty colSpan={2} icon={BarChart2} title="No bids yet" description="Your bids will be grouped by category here." />
            ) : Object.entries(categoryCount).map(([cat, count]) => (
              <tr key={cat}><td>{cat}</td><td>{count}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sd-card">
        <div className="sd-card-header"><h2>Bid History</h2></div>
        <table className="sd-table">
          <thead><tr><th>Project</th><th className="sd-num">Amount</th><th>Status</th><th>Submitted</th></tr></thead>
          <tbody>
            {bids.length === 0 ? (
              <TableEmpty colSpan={4} icon={FileText} title="No bids yet" description="Your bid history will appear here."
                action={<Link to="/supplier/projects" className="sd-btn-cancel">Browse bid opportunities</Link>} />
            ) : bids.map(b => (
              <tr key={b.id}>
                <td className="sd-bold">{b.project}</td>
                <td className="sd-num">{b.amount}</td>
                <td><StatusBadge domain="bid" status={b.status} label={BID_LABEL[b.status]} /></td>
                <td className="sd-muted">{b.submitted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SupplierStatusPage({ bids, profile, eligible }) {
  const qs = profile?.qualification_status
  const verifyDate =
    qs === 'verified' ? (profile?.reviewed_at ? new Date(profile.reviewed_at).toLocaleDateString() : 'Approved')
    : qs === 'needs_revision' ? 'Revision requested'
    : qs === 'rejected' ? 'Rejected'
    : 'Pending review'
  const steps = [
    {
      label: 'Account Registered',
      date: profile?.registered || '—',
      done: true,
      desc: 'Your supplier account was created and submitted for review.',
    },
    {
      label: 'Admin Verification',
      date: verifyDate,
      done: qs === 'verified',
      desc: 'Admin reviews your company details and uploaded documents.',
    },
    {
      label: 'Eligible to Bid',
      date: eligible ? 'Active' : 'Locked until approved',
      done: !!eligible,
      desc: 'Once approved, you can submit bids on all published projects.',
    },
    {
      label: 'Bids Submitted',
      date: bids.length > 0 ? `${bids.length} bid${bids.length > 1 ? 's' : ''} total` : 'No bids yet',
      done: bids.length > 0,
      desc: 'Your submitted bids are listed below.',
    },
    {
      label: 'Bid Shortlisted',
      date: bids.some(b => b.status === 'qualified') ? 'Active' : 'Pending evaluation',
      done: bids.some(b => b.status === 'qualified'),
      desc: 'At least one of your bids has been shortlisted for final evaluation.',
    },
    {
      label: 'Contract Awarded',
      date: bids.some(b => b.status === 'winner') ? 'Awarded!' : 'Awaiting decision',
      done: bids.some(b => b.status === 'winner'),
      desc: 'The procurement office has selected a winner for the project.',
    },
  ]

  return (
    <div className="sd-content">
      <div className="sd-stats">
        {[
          { label: 'Bids Submitted',  value: String(bids.length),                                             icon: FileText,     color: 'blue'   },
          { label: 'Under Review',    value: String(bids.filter(b => b.status === 'under_review').length),    icon: Clock,        color: 'yellow' },
          { label: 'Shortlisted',     value: String(bids.filter(b => b.status === 'qualified').length),       icon: CheckCircle2, color: 'green'  },
          { label: 'Won',             value: String(bids.filter(b => b.status === 'winner').length),          icon: Trophy,       color: 'purple' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div className="sd-stat-card" key={label}>
            <div className="sd-stat-top">
              <span className="sd-stat-label">{label}</span>
              <div className={`sd-stat-icon sd-icon-${color}`}><Icon size={17} /></div>
            </div>
            <div className="sd-stat-value">{value}</div>
          </div>
        ))}
      </div>

      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>Account & Bid Timeline</h2><p>Your progress through the procurement process</p></div>
          <StatusBadge tone={steps.every(st => st.done) ? 'success' : 'neutral'} dot={false}
            label={`${steps.filter(st => st.done).length} of ${steps.length} complete`} />
        </div>
        <div className="sd-timeline">
          {steps.map((step, i) => (
            <div className={`sd-timeline-step ${step.done ? 'done' : 'pending'}`} key={i}>
              <div className="sd-tl-left">
                <div className="sd-tl-dot">{step.done ? <CheckCircle2 size={16} /> : <Clock size={16} />}</div>
                {i < steps.length - 1 && <div className="sd-tl-line" />}
              </div>
              <div className="sd-tl-body">
                <div className="sd-tl-title">{step.label}</div>
                <div className="sd-tl-date">{step.date}</div>
                <div className="sd-tl-desc">{step.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Normalize the supplier's registered categories into a list. The JSON list is
// the source of truth; fall back to the legacy comma-joined string.
function profileBusinessTypes(profile) {
  if (Array.isArray(profile?.business_types) && profile.business_types.length) {
    return profile.business_types
  }
  return (profile?.business_type || '')
    .split(',').map(s => s.trim()).filter(Boolean)
}

// A verified supplier's category change is a REQUEST until an Admin approves it
// (the server keeps the approved list in business_types and the request in
// pending_business_types). Shows what is pending — or why it was declined —
// so the supplier knows which categories they can actually bid in today.
function CategoryRequestBanner({ profile, onWithdraw, withdrawing }) {
  const status = profile?.category_request_status
  if (!status) return null
  const approved = profileBusinessTypes(profile)
  const requested = profile.pending_business_types || []
  const added = requested.filter(c => !approved.includes(c))
  const removed = approved.filter(c => !requested.includes(c))
  const changes = [
    added.length ? `add ${added.join(', ')}` : '',
    removed.length ? `remove ${removed.join(', ')}` : '',
  ].filter(Boolean).join('; ')

  if (status === 'rejected') {
    return (
      <div className="sd-verify-banner sd-verify-rejected" role="status">
        <div className="sd-verify-icon"><X size={18} /></div>
        <div className="sd-verify-text">
          <span className="sd-bold">Category change not approved</span>
          <span className="sd-muted sd-small">
            Your request ({changes || 'no change'}) was declined. You can still bid in your approved
            categories, and you can submit a new request below.
          </span>
          {profile.category_request_note && <span className="sd-verify-note">“{profile.category_request_note}”</span>}
        </div>
      </div>
    )
  }
  return (
    <div className="sd-verify-banner sd-verify-pending" role="status">
      <div className="sd-verify-icon"><Clock size={18} /></div>
      <div className="sd-verify-text">
        <span className="sd-bold">Category change awaiting Admin approval</span>
        <span className="sd-muted sd-small">
          Requested: {changes || 'no change'}. Until it's approved you can only see and bid on
          procurements in your current categories: {approved.join(', ') || '—'}.
        </span>
      </div>
      {onWithdraw && (
        <button type="button" className="sd-btn-cancel" disabled={withdrawing} onClick={onWithdraw}>
          {withdrawing ? 'Withdrawing…' : 'Withdraw request'}
        </button>
      )}
    </div>
  )
}

// Maps a document's review state to a badge — "not uploaded" wins over any
// stale review status, since a missing file can't meaningfully be "approved".
function docStatusBadge(doc) {
  if (!doc.url) return { label: 'Not Uploaded', cls: 'badge-gray' }
  if (doc.review_status === 'approved') return { label: 'Approved', cls: 'badge-green' }
  if (doc.review_status === 'needs_revision') return { label: 'Needs Revision', cls: 'badge-red' }
  if (doc.review_status === 'resubmitted') return { label: 'Resubmitted', cls: 'badge-blue' }
  return { label: 'Pending Review', cls: 'badge-yellow' }
}

// Only mayors_permit and tax_clearance_certificate carry an expiry date on the
// Supplier model — every other document type has none.
const DOC_EXPIRY_FIELD = {
  mayors_permit: 'mayors_permit_expiry',
  tax_clearance_certificate: 'tax_clearance_expiry',
}
function docExpiryInfo(doc, profile) {
  const field = DOC_EXPIRY_FIELD[doc.key]
  const raw = field ? profile?.[field] : null
  if (!raw) return null
  const date = new Date(raw)
  const daysLeft = Math.ceil((date - new Date()) / (1000 * 60 * 60 * 24))
  return { date, expired: daysLeft < 0, expiringSoon: daysLeft >= 0 && daysLeft <= 30 }
}

// Shown by Profile/Settings when the profile could not be loaded. Without this
// both pages sat on their loading skeleton indefinitely, which looked like a
// hung page rather than a failed request.
function ProfileLoadError({ message, onRetry, retrying }) {
  // A supplier account with no Supplier profile row is a real, recoverable
  // state (e.g. the account was created outside the registration form), so it
  // gets its own wording instead of a generic failure.
  const missing = /no supplier profile/i.test(message || '')
  return (
    <div className="sd-card">
      <div className="sd-load-error">
        <AlertTriangle size={22} className="sd-load-error-icon" />
        <div className="sd-load-error-text">
          <span className="sd-bold">
            {missing ? 'No supplier profile is linked to this account' : 'Could not load your profile'}
          </span>
          <span className="sd-muted">
            {missing
              ? 'Your sign-in works, but there is no company profile attached to it. Please contact the procuring entity’s administrator so they can link or re-create your supplier registration.'
              : message || 'Something went wrong while loading your profile.'}
          </span>
        </div>
        {!missing && (
          <button className="sd-btn-primary" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
      </div>
    </div>
  )
}

function SupplierProfile({ profile, eligible, loading, error, onRetry }) {
  if (!profile) {
    return (
      <div className="sd-content">
        {error && !loading
          ? <ProfileLoadError message={error} onRetry={onRetry} retrying={loading} />
          : (
            <div className="sd-card">
              <div style={{ padding: '40px 24px' }}><ListSkeleton rows={4} height={48} /></div>
            </div>
          )}
      </div>
    )
  }

  const businessTypes = profileBusinessTypes(profile)
  const fields = [
    { label: 'Full Name',        value: profile.full_name || profile.contact },
    { label: 'Company Name',     value: profile.company },
    { label: 'Email Address',    value: profile.email },
    { label: 'Phone Number',     value: profile.phone_number },
    { label: 'Business Address', value: profile.company_address },
    { label: 'TIN Number',       value: profile.tin },
  ]

  const qs = profile.qualification_status
  const verifyDate = qs === 'verified'
    ? (profile.reviewed_at ? new Date(profile.reviewed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Approved')
    : QUAL_STATUS[qs]?.label || 'Pending review'

  return (
    <div className="sd-content">
      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>My Profile</h2><p>Your company and account information</p></div>
        </div>

        <div className="sd-profile-grid">
          {fields.map(({ label, value }) => (
            <div className="sd-profile-field" key={label}>
              <span className="sd-profile-label">{label}</span>
              <span className="sd-profile-value">{value || '—'}</span>
            </div>
          ))}
          {/* All registered categories — a supplier can pick several at sign-up. */}
          <div className="sd-profile-field sd-profile-field-full">
            <span className="sd-profile-label">Business Types</span>
            {businessTypes.length === 0 ? (
              <span className="sd-profile-value">—</span>
            ) : (
              <div className="sd-chips">
                {businessTypes.map(t => <span className="sd-chip" key={t}>{t}</span>)}
              </div>
            )}
            <CategoryRequestBanner profile={profile} />
          </div>
        </div>
      </div>

      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>My Documents</h2><p>Registration documents on file with the procuring entity</p></div>
        </div>
        <div className="sd-doc-list" style={{ padding: '8px 24px 20px' }}>
          {(profile.documents || []).map(d => {
            const badge = docStatusBadge(d)
            const expiry = docExpiryInfo(d, profile)
            const labelEl = (
              <span className="sd-file-rowname">
                {d.label}{!d.required && <span className="sd-optional"> (optional)</span>}
              </span>
            )
            const expiryEl = expiry && (
              <span className={`sd-doc-expiry${expiry.expired || expiry.expiringSoon ? ' sd-doc-expiry-warn' : ''}`}>
                {expiry.expired ? 'Expired ' : 'Expires '}{expiry.date.toLocaleDateString()}
              </span>
            )
            return d.url ? (
              <a key={d.key} className="sd-doc-row" href={d.url} target="_blank" rel="noreferrer">
                {labelEl}
                <span className={`ui-badge ${badge.cls}`}><span className="ui-badge-dot" aria-hidden="true" />{badge.label}</span>
                {expiryEl}
                <span className="sd-doc-view"><Eye size={13} /> View</span>
              </a>
            ) : (
              <div key={d.key} className="sd-doc-row sd-doc-row-missing">
                {labelEl}
                <span className={`ui-badge ${badge.cls}`}><span className="ui-badge-dot" aria-hidden="true" />{badge.label}</span>
                {expiryEl}
              </div>
            )
          })}
        </div>
      </div>

      <div className="sd-card sd-status-card">
        <div className="sd-card-header">
          <div><h2>Account Status</h2><p>Verification and eligibility</p></div>
        </div>
        <div className="sd-status-body">
          <div className="sd-status-item">
            <CheckCircle2 size={18} className="sd-check" />
            <div><span className="sd-bold">Account Registered</span><span className="sd-muted">{profile.registered || '—'}</span></div>
          </div>
          <div className="sd-status-divider" />
          <div className="sd-status-item">
            {eligible ? <CheckCircle2 size={18} className="sd-check" /> : <Clock size={18} className="sd-clock" />}
            <div><span className="sd-bold">Admin Verification</span><span className="sd-muted">{verifyDate}</span></div>
          </div>
          <div className="sd-status-divider" />
          <div className="sd-status-item">
            {eligible ? <CheckCircle2 size={18} className="sd-check" /> : <Lock size={18} className="sd-clock" />}
            <div><span className="sd-bold">Eligible to Bid</span><span className="sd-muted">{eligible ? 'Active on all matching projects' : 'Locked until approved'}</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SupplierSettings({ profile, setToast, onUpdated, loading, error, onRetry }) {
  const [fullName, setFullName] = useState('')
  const [repName, setRepName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [businessTypes, setBusinessTypes] = useState([])
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState('')

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)

  const [withdrawing, setWithdrawing] = useState(false)
  const isVerified = profile?.qualification_status === 'verified'

  useEffect(() => {
    if (!profile) return
    setFullName(profile.full_name || profile.contact || '')
    setRepName(profile.representative_name || '')
    setPhone(profile.phone_number || '')
    setAddress(profile.company_address || '')
    // Show the pending request's selection while it awaits approval, so the
    // supplier edits their request rather than silently reverting it.
    setBusinessTypes(
      profile.category_request_status === 'pending' && Array.isArray(profile.pending_business_types)
        ? profile.pending_business_types
        : profileBusinessTypes(profile)
    )
  }, [profile])

  // Re-sending the approved list withdraws a pending request (server-side rule).
  const withdrawRequest = async () => {
    setWithdrawing(true)
    try {
      await apiUpdateMySupplier({ business_types: profileBusinessTypes(profile) })
      await onUpdated()
      setToast({ type: 'success', message: 'Category change request withdrawn.' })
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not withdraw the request.' })
    } finally {
      setWithdrawing(false)
    }
  }

  const toggleBusinessType = (t) =>
    setBusinessTypes(list => list.includes(t) ? list.filter(x => x !== t) : [...list, t])

  const saveProfile = async (e) => {
    e.preventDefault()
    setProfileError('')
    if (businessTypes.length === 0) {
      setProfileError('Select at least one business type.')
      return
    }
    setSavingProfile(true)
    try {
      const before = profile?.category_request_status || ''
      const saved = await apiUpdateMySupplier({
        full_name: fullName.trim(),
        representative_name: repName.trim(),
        phone_number: phone.trim(),
        company_address: address.trim(),
        business_types: businessTypes,
      })
      await onUpdated()
      const filedRequest = saved?.category_request_status === 'pending' &&
        (before !== 'pending' || saved?.category_requested_at !== profile?.category_requested_at)
      setToast({
        type: 'success',
        message: filedRequest
          ? 'Profile saved. Your category change was sent to the Admin for approval.'
          : 'Profile updated successfully.',
      })
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not update your profile.' })
    } finally {
      setSavingProfile(false)
    }
  }

  const savePassword = async (e) => {
    e.preventDefault()
    setPasswordError('')
    if (newPassword !== confirmPassword) { setPasswordError('New password and confirmation do not match.'); return }
    setSavingPassword(true)
    try {
      await apiChangePassword(currentPassword, newPassword)
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
      setToast({ type: 'success', message: 'Password changed successfully.' })
    } catch (err) {
      setPasswordError(err.message || 'Could not change your password.')
    } finally {
      setSavingPassword(false)
    }
  }

  // Changing your password only needs an account, not a company profile — so it
  // stays available even when the profile failed to load. Previously the whole
  // page was behind a `if (!profile) return <skeleton>` guard, which locked a
  // supplier out of their own password form whenever this request failed.
  const profileCard = !profile ? (
    error && !loading
      ? <ProfileLoadError message={error} onRetry={onRetry} retrying={loading} />
      : <div className="sd-card"><div style={{ padding: '40px 24px' }}><ListSkeleton rows={4} height={48} /></div></div>
  ) : (
    <div className="sd-card">
      <div className="sd-card-header">
        <div><h2>Edit Profile</h2><p>Update your contact details on file</p></div>
      </div>
      <form className="sd-profile-form" onSubmit={saveProfile}>
        <div className="sd-form-group">
          <label>Full Name</label>
          <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} />
        </div>
        <div className="sd-form-group">
          <label>Representative Name</label>
          <input type="text" value={repName} onChange={e => setRepName(e.target.value)} />
        </div>
        <div className="sd-form-group">
          <label>Phone Number</label>
          <input type="text" value={phone} onChange={e => setPhone(e.target.value)} />
        </div>
        <div className="sd-form-group">
          <label>Business Address</label>
          <input type="text" value={address} onChange={e => setAddress(e.target.value)} />
        </div>
        <div className="sd-form-group sd-profile-field-full">
          <label>Business Types</label>
          <span className="sd-muted sd-small" style={{ marginBottom: 6 }}>
            {isVerified
              ? 'Controls which procurement categories you see and can bid on. Changes are sent to the Admin for approval; your current categories stay active until then.'
              : 'Controls which procurement categories you see and can bid on. They are reviewed together with your registration.'}
          </span>
          <CategoryRequestBanner profile={profile} onWithdraw={withdrawRequest} withdrawing={withdrawing} />
          <div className="sd-chips">
            {CATEGORIES.map(t => (
              <button
                type="button"
                key={t}
                className={`sd-chip sd-chip-toggle${businessTypes.includes(t) ? ' on' : ''}`}
                onClick={() => toggleBusinessType(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        {profileError && <span className="sd-field-error sd-profile-field-full">{profileError}</span>}
        <div className="sd-profile-actions">
          <button type="submit" className="sd-btn-primary" disabled={savingProfile}>
            {savingProfile ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  )

  return (
    <div className="sd-content">
      {profileCard}

      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>Change Password</h2><p>Use a strong password that you don't reuse elsewhere</p></div>
        </div>
        <form className="sd-profile-form" onSubmit={savePassword}>
          <div className="sd-form-group sd-profile-field-full">
            <label>Current Password</label>
            <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required />
          </div>
          <div className="sd-form-group">
            <label>New Password</label>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
          </div>
          <div className="sd-form-group">
            <label>Confirm New Password</label>
            <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required />
          </div>
          {passwordError && <span className="sd-field-error sd-profile-field-full">{passwordError}</span>}
          <div className="sd-profile-actions">
            <button type="submit" className="sd-btn-primary" disabled={savingPassword}>
              {savingPassword ? 'Updating…' : 'Update Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

// Module-level cache so the supplier's profile shows instantly on revisit
// instead of flashing empty while it refetches.
let myProfileCache = null

export default function SupplierDashboard() {
  const loc = useLocation()
  const navigate = useNavigate()
  const [profile, setProfile] = useState(myProfileCache)
  const [profileError, setProfileError] = useState('')
  const [loadingProfile, setLoadingProfile] = useState(!myProfileCache)
  const [projects, setProjects] = useState([])   // eligible (published + category match)
  const [bids, setBids] = useState([])
  const [awards, setAwards] = useState([])       // this supplier's own awards only
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [loadingBids, setLoadingBids] = useState(true)
  const [toast, setToast] = useState(null)
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => { setNavOpen(false) }, [loc.pathname])

  // Loads the supplier's own profile. The error is KEPT, not swallowed: with no
  // profile the Profile/Settings pages have nothing to render, and silently
  // leaving `profile` null made them show their loading skeleton forever with no
  // message and no way out. Now a failure is surfaced with a Retry button.
  const loadProfile = () => {
    setProfileError('')
    setLoadingProfile(true)
    return apiGetMySupplier()
      .then(p => { myProfileCache = p; setProfile(p) })
      .catch(err => {
        // Keep showing the cached profile if a background refresh fails; only
        // report the error when there is nothing to fall back on.
        if (!myProfileCache) {
          setProfile(null)
          setProfileError(err?.message || 'Could not load your profile.')
        }
      })
      .finally(() => setLoadingProfile(false))
  }
  // Backend returns only the projects this supplier is eligible for.
  const loadProjects = () => {
    setLoadingProjects(true)
    apiListProjects().then(d => setProjects(d.map(mapProject))).catch(() => {}).finally(() => setLoadingProjects(false))
  }
  const loadBids = () => {
    setLoadingBids(true)
    apiListMyBids().then(d => setBids(d.map(mapBid))).catch(() => {}).finally(() => setLoadingBids(false))
  }
  // The supplier's OWN awards (scoped server-side) — this is how the winner
  // receives the Notice of Award addressed to them, along with the BAC
  // Resolution and Notice to Proceed. Silently ignored on failure: a supplier
  // who has never won simply has none.
  const loadAwards = () => {
    apiListAwards().then(setAwards).catch(() => setAwards([]))
  }
  useEffect(() => { loadProfile(); loadProjects(); loadBids(); loadAwards() }, [])

  // The email-verify link opens in its own tab, so this dashboard's `profile`
  // state never hears about it. Refetch just the profile when the user comes
  // back to this tab — cheap (one request) and catches that case, instead of
  // polling continuously or requiring a manual page refresh.
  useEffect(() => {
    const onFocus = () => loadProfile()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Verification is the real bidding gate (the admin approve action sets this).
  const eligible = profile?.qualification_status === 'verified'

  // Returns true on success so the modal can close itself (and stay open with the
  // error toast on failure). `formData` is the multipart payload built in BidModal.
  const submitBid = async (project, formData) => {
    try {
      const created = await apiSubmitBid(project.pk, formData)
      loadBids()
      setToast({ type: 'success', message: 'Bid submitted successfully.' })
      // The bid is saved at this point. Anchoring it on Sepolia is the optional
      // follow-up: it hashes the bid + the quotation document, so the supplier
      // gets tamper-evident proof of what they submitted and when. Not awaited —
      // declining the MetaMask prompt must not look like a failed submission.
      if (created?.anchor) {
        runAnchor(created.anchor, { label: `${project.id} · Bid submitted` })
      }
      return true
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not submit your bid.' })
      return false
    }
  }

  const withdrawBid = async (bidId) => {
    try {
      await apiWithdrawBid(bidId)
      loadBids()
      setToast({ type: 'success', message: 'Bid withdrawn.' })
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not withdraw the bid.' })
    }
  }

  const TITLES = {
    '/supplier':          'Dashboard',
    '/supplier/projects': 'Bid Opportunities',
    '/supplier/bids':     'My Bids',
    '/supplier/status':   'Status',
    '/supplier/reports':  'Reports',
    '/supplier/profile':  'Profile',
    '/supplier/settings': 'Settings',
  }
  const title = Object.entries(TITLES).find(([path]) => loc.pathname === path)?.[1] || 'Dashboard'

  return (
    <div className="sd-layout">
      <AppSidebar
        workspace="Supplier Workspace"
        logoIcon={Building2}
        sections={NAV_SECTIONS}
        isActive={(to) => to === '/supplier' ? loc.pathname === '/supplier' : loc.pathname.startsWith(to)}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />
      {navOpen && <div className="sd-nav-backdrop" onClick={() => setNavOpen(false)} />}
      <div className="sd-main">
        <AppHeader
          title={title}
          breadcrumbs={[{ label: 'Supplier', to: '/supplier' }, { label: title }]}
          onMenu={() => setNavOpen(true)}
          user={{
            name: profile?.full_name || profile?.contact || storedUser().full_name || 'Supplier User',
            email: profile?.email || storedUser().email || '',
            role: profile?.company || 'Supplier',
          }}
          menu={[
            { icon: User, label: 'My Profile', onClick: () => navigate('/supplier/profile') },
            { icon: Settings, label: 'Settings', onClick: () => navigate('/supplier/settings') },
            { divider: true },
            { icon: LogOut, label: 'Log out', danger: true, onClick: () => { apiLogout(); navigate('/login') } },
          ]}
        />
        {toast && <SupplierToast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
        <div className="sd-body">
          <Routes>
            <Route index element={<SupplierHome projects={projects} bids={bids} onBid={submitBid} eligible={eligible} profile={profile} onResubmitted={loadProfile} setToast={setToast} loadingProjects={loadingProjects} loadingBids={loadingBids} />} />
            <Route path="projects" element={<SupplierProjects projects={projects} bids={bids} onBid={submitBid} eligible={eligible} loading={loadingProjects} profile={profile} />} />
            <Route path="bids"     element={<SupplierBids bids={bids} awards={awards} onWithdraw={withdrawBid} loading={loadingBids} onResubmitted={loadBids} setToast={setToast} />} />
            <Route path="status"   element={<SupplierStatusPage bids={bids} profile={profile} eligible={eligible} />} />
            <Route path="reports"  element={<SupplierReportsPage bids={bids} profile={profile} />} />
            <Route path="profile"  element={<SupplierProfile profile={profile} eligible={eligible} loading={loadingProfile} error={profileError} onRetry={loadProfile} />} />
            <Route path="settings" element={<SupplierSettings profile={profile} setToast={setToast} onUpdated={() => Promise.all([loadProfile(), loadProjects()])} loading={loadingProfile} error={profileError} onRetry={loadProfile} />} />
            <Route path="*"        element={<SupplierHome projects={projects} bids={bids} onBid={submitBid} eligible={eligible} profile={profile} onResubmitted={loadProfile} setToast={setToast} loadingProjects={loadingProjects} loadingBids={loadingBids} />} />
          </Routes>
        </div>
      </div>
      {/* Anchoring feedback for the supplier's own bid submissions. At the
          layout root so it survives navigation while MetaMask is open. */}
      <AnchorActivity />
    </div>
  )
}
