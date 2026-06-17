import { useState, useEffect, useRef } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, FileText, Clock, CheckCircle2,
  Building2, Bell, Search, ChevronDown, ChevronRight, LogOut, Settings,
  Eye, ArrowRight, Shield, User, X, Send, Trophy, Trash2,
  AlertTriangle, Upload, Lock, Menu, Camera, Check, Plus, Loader2, XCircle
} from 'lucide-react'
import {
  clearSession, apiGetMySupplier, apiResubmitDocuments,
  apiListProjects, apiListMyBids, apiSubmitBid, apiWithdrawBid,
  apiListNotifications, apiMarkNotificationsRead,
} from '../api'
import { TableSkeleton, ListSkeleton } from '../components/Skeleton'
import '../style/SupplierDashboard.css'

// API → UI mapping (backend uses code/decimal/ISO; the UI shows ₱ + dates).
const fmtDate = (v) => v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
const fmtPeso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH')
const parseAmount = (s) => Number(String(s).replace(/[^\d.]/g, '')) || 0
const mapProject = (p) => ({
  id: p.code, pk: p.id, name: p.name, budget: fmtPeso(p.budget),
  budgetRaw: Number(p.budget || 0),  // numeric ABC for the live budget comparison
  deadline: fmtDate(p.deadline), category: p.category, description: p.description,
  referenceImage: p.reference_image_url || '',  // optional required-product reference
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
  id: b.id, project: b.project_name, projectId: b.project_code,
  amount: fmtPeso(b.amount), submitted: fmtDate(b.submitted_at), status: b.status, notes: b.notes,
  deliveryTimeline: b.delivery_timeline || '',
  brandName: b.brand_name || '', modelNumber: b.model_number || '',
  additionalComments: b.additional_comments || '',
  files: collectBidFiles(b),
  declarations: BID_DECLARATIONS.map(([key, label]) => ({ label, ok: !!b[key] })),
})

// ── Bid document upload rules (per-field types; shared 5 MB cap) ──────────────
const MAX_MB = 5
// accept: the <input accept> attribute; exts: allowed extensions; text: shown in the box.
const UPLOAD_RULES = {
  productImage:  { accept: '.jpg,.jpeg,.png', exts: ['jpg', 'jpeg', 'png'], text: 'JPG or PNG' },
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

const NAV = [
  { icon: LayoutDashboard, label: 'Dashboard',  to: '/supplier' },
  { icon: FolderOpen,      label: 'Bid Opportunities', to: '/supplier/projects' },
  { icon: FileText,        label: 'My Bids',    to: '/supplier/bids' },
  { icon: Clock,           label: 'Status',     to: '/supplier/status' },
  { icon: Settings,        label: 'Profile',    to: '/supplier/profile' },
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

// ─── Bid submit modal — step-by-step wizard ──────────────────────────────────

const BID_STEPS = ['Bid Details', 'Documents', 'Declarations']

function BidModal({ project, profile, onClose, onSubmit }) {
  const hasRef = !!project.referenceImage
  const [step, setStep] = useState(0)
  const [amount, setAmount] = useState('')
  const [deliveryTimeline, setDeliveryTimeline] = useState('')
  const [notes, setNotes] = useState('')
  const [additionalComments, setAdditionalComments] = useState('')
  // Files
  const [productImage, setProductImage] = useState(null)
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
    fd.append('terms_accepted', terms)
    fd.append('interest_declared', interest)
    fd.append('scm_declared', scm)
    fd.append('accuracy_confirmed', accuracy)
    fd.append('specification_confirmed', specMatch)
    if (quotation) fd.append('quotation_document', quotation)
    if (technical) fd.append('technical_document', technical)
    if (productImage) fd.append('supplier_product_image', productImage)
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

            {/* ── STEP 2 — Documents (product response + supporting docs) ─── */}
            {step === 1 && (
              <>
                {hasRef && (
                  <div className="sd-bid-section">
                    <h4 className="sd-bid-section-label">Your Product Response</h4>
                    <p className="sd-bid-section-hint">Upload files showing your matching product and confirm your product meets the specification.</p>
                    <BidUpload label="Your Product Image" rule={UPLOAD_RULES.productImage}
                      hint="Upload a photo of the exact product you are offering."
                      file={productImage} error={fileErrors.productImage}
                      onPick={pickFile(UPLOAD_RULES.productImage, setProductImage, 'productImage')}
                      onRemove={() => setProductImage(null)} />
                    <BidUpload label="Product Datasheet or Specification Sheet" rule={UPLOAD_RULES.datasheet}
                      hint="Upload your product technical datasheet or specification document."
                      file={datasheet} error={fileErrors.datasheet}
                      onPick={pickFile(UPLOAD_RULES.datasheet, setDatasheet, 'datasheet')}
                      onRemove={() => setDatasheet(null)} />
                    <BidUpload label="Compliance or Certificate Document" rule={UPLOAD_RULES.compliance}
                      hint="Upload any relevant compliance certificate or product authorization document."
                      file={compliance} error={fileErrors.compliance}
                      onPick={pickFile(UPLOAD_RULES.compliance, setCompliance, 'compliance')}
                      onRemove={() => setCompliance(null)} />
                    <div className="sd-decl">
                      <label className="sd-decl-label">
                        <input type="checkbox" checked={specMatch}
                          onChange={e => { setSpecMatch(e.target.checked); setErrors(x => ({ ...x, specMatch: '' })) }} />
                        <span>My offered product matches the required specification shown in the reference image above.</span>
                      </label>
                      {errors.specMatch && <span className="sd-field-error sd-decl-error">{errors.specMatch}</span>}
                    </div>
                  </div>
                )}

                <div className="sd-bid-section">
                  <h4 className="sd-bid-section-label">Supporting Documents</h4>
                  <BidUpload label="Quotation Document" required rule={UPLOAD_RULES.quotation}
                    hint="Upload your formal price quotation with itemized costs and company letterhead. This is SBD 3 of the Philippine Government Procurement process."
                    file={quotation} error={fileErrors.quotation}
                    onPick={pickFile(UPLOAD_RULES.quotation, setQuotation, 'quotation')}
                    onRemove={() => setQuotation(null)} />
                  {errors.quotation && <span className="sd-field-error">{errors.quotation}</span>}
                  <BidUpload label="Technical Proposal Document" rule={UPLOAD_RULES.technical}
                    hint="Optional supporting document with detailed technical specifications or product brochures."
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
                    <span className="sd-upload-hint">Any other relevant documents such as certifications, licenses or additional proposals.</span>
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

function BidDetailModal({ bid, onClose, onWithdraw }) {
  const canWithdraw = bid.status === 'submitted' || bid.status === 'under_review'
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
            <div><span>Status</span><strong><span className={`badge ${BID_STATUS[bid.status] || 'badge-yellow'}`}>{bid.status.replace('_', ' ')}</span></strong></div>
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
    <div className={`sd-verify-banner sd-verify-${info.tone}`}>
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

// ─── Sidebar / Header ────────────────────────────────────────────────────────

function SupplierSidebar({ active, open, onClose, profile }) {
  const navigate = useNavigate()
  const isActive = (to) => to === '/supplier' ? active === '/supplier' : active.startsWith(to)
  const name = profile?.full_name || profile?.contact || 'Supplier User'
  const email = profile?.email || ''
  const initial = (name || 'S').trim().charAt(0).toUpperCase()
  return (
    <aside className={`sd-sidebar${open ? ' open' : ''}`}>
      <div className="sd-sidebar-logo">
        <span className="sd-logo-icon"><Building2 size={16} /></span>
        <div>
          <div className="sd-logo-name">E-Procurement</div>
          <div className="sd-logo-sub">Supplier Workspace</div>
        </div>
      </div>
      <div className="sd-menu-section">
        <span className="sd-menu-label">MENU</span>
        <nav className="sd-sidebar-nav">
          {NAV.map(({ icon: Icon, label, to }) => (
            <Link key={to} to={to} className={`sd-nav-item${isActive(to) ? ' active' : ''}`} onClick={onClose}>
              <Icon size={18} /><span>{label}</span>
              {isActive(to) && <span className="sd-nav-dot" />}
            </Link>
          ))}
        </nav>
      </div>
      <div className="sd-sidebar-footer">
        <div className="sd-sidebar-user">
          <div className="sd-sidebar-avatar">{initial}</div>
          <div className="sd-sidebar-user-info">
            <span className="sd-sidebar-user-name">{name}</span>
            <span className="sd-sidebar-user-email">{email}</span>
          </div>
          <button
            className="sd-sidebar-expand"
            onClick={() => { clearSession(); navigate('/login') }}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </aside>
  )
}

// Bell with unread count + dropdown list. Opening it marks everything read.
function NotificationsBell() {
  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  const load = () => { apiListNotifications().then(setItems).catch(() => {}) }
  useEffect(() => { load() }, [])
  const unread = items.filter(n => !n.is_read).length

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && unread > 0) {
      apiMarkNotificationsRead()
        .then(() => setItems(prev => prev.map(n => ({ ...n, is_read: true }))))
        .catch(() => {})
    }
  }

  return (
    <div className="sd-notif-wrap">
      <button className="sd-notif" onClick={toggle}>
        <Bell size={18} />
        {unread > 0 && <span className="sd-notif-badge">{unread}</span>}
      </button>
      {open && (
        <>
          <div className="sd-dropdown-backdrop" onClick={() => setOpen(false)} />
          <div className="sd-notif-dropdown">
            <div className="sd-notif-head">Notifications</div>
            {items.length === 0 ? (
              <div className="sd-notif-empty">No notifications yet.</div>
            ) : (
              items.map(n => (
                <div key={n.id} className="sd-notif-item">
                  <div className="sd-notif-msg">{n.message}</div>
                  <div className="sd-notif-time">{new Date(n.created_at).toLocaleString()}</div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}

function SupplierHeader({ title, onMenu, profile }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const name = profile?.full_name || profile?.contact || 'Supplier User'
  const company = profile?.company || ''
  const email = profile?.email || ''
  const initial = (name || 'S').trim().charAt(0).toUpperCase()
  return (
    <header className="sd-header">
      <div className="sd-header-left">
        <button className="sd-menu-btn" onClick={onMenu} aria-label="Open menu"><Menu size={20} /></button>
        <div>
          <div className="sd-workspace-label">SUPPLIER WORKSPACE</div>
          <h1 className="sd-page-title">{title}</h1>
        </div>
      </div>
      <div className="sd-header-right">
        <div className="sd-search">
          <Search size={15} />
          <input placeholder="Search projects…" />
        </div>
        <NotificationsBell />
        <div className="sd-user-wrap">
          <div className="sd-user" onClick={() => setOpen(o => !o)}>
            <div className="sd-avatar">{initial}</div>
            <div className="sd-user-info">
              <span>{name}</span>
              <span>{company}</span>
            </div>
            <ChevronDown size={14} color="#64748b" />
          </div>
          {open && (
            <>
              <div className="sd-dropdown-backdrop" onClick={() => setOpen(false)} />
              <div className="sd-dropdown">
                <div className="sd-dropdown-header">
                  <div className="sd-avatar">{initial}</div>
                  <div>
                    <div className="sd-dropdown-name">{name}</div>
                    <div className="sd-dropdown-email">{email}</div>
                  </div>
                </div>
                <div className="sd-dropdown-divider" />
                <button className="sd-dropdown-item" onClick={() => { setOpen(false); navigate('/supplier/profile') }}>
                  <User size={15} /> My Profile
                </button>
                <button className="sd-dropdown-item" onClick={() => { setOpen(false); navigate('/supplier/profile') }}>
                  <Settings size={15} /> Settings
                </button>
                <div className="sd-dropdown-divider" />
                <button className="sd-dropdown-item sd-dropdown-logout" onClick={() => { clearSession(); navigate('/login') }}>
                  <LogOut size={15} /> Log out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

// ─── Pages ───────────────────────────────────────────────────────────────────

function SupplierHome({ projects, bids, onBid, eligible, profile, onResubmitted, setToast, loadingProjects, loadingBids }) {
  const [modal, setModal] = useState(null)
  const alreadyBid = new Set(bids.map(b => b.projectId))
  const available = projects.filter(p => !alreadyBid.has(p.id))
  const approvalLabel = QUAL_STATUS[profile?.qualification_status]?.label || 'Pending'

  return (
    <div className="sd-content">
      {modal && <BidModal project={modal} profile={profile} onClose={() => setModal(null)} onSubmit={onBid} />}

      <VerificationBanner profile={profile} />
      <RevisionPanel profile={profile} onResubmitted={onResubmitted} setToast={setToast} />

      <div className="sd-stats">
        {[
          { label: 'Eligible Projects', value: String(projects.length),                                       icon: FolderOpen,   color: 'blue'   },
          { label: 'My Active Bids',  value: String(bids.length),                                             icon: FileText,     color: 'green'  },
          { label: 'Shortlisted',     value: String(bids.filter(b => b.status === 'shortlisted').length),     icon: CheckCircle2, color: 'purple' },
          { label: 'Approval Status', value: approvalLabel,                                                   icon: Shield,       color: eligible ? 'green' : 'yellow' },
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

      <div className="sd-grid">
        <div className="sd-card sd-card-wide">
          <div className="sd-card-header">
            <div><h2>Bid Opportunities</h2><p>Open procurements matching your business that you can bid on</p></div>
            <Link to="/supplier/projects" className="sd-view-all">View all →</Link>
          </div>
          {loadingProjects && projects.length === 0 ? (
            <div style={{ padding: '12px 24px' }}><ListSkeleton rows={3} height={52} /></div>
          ) : available.length === 0 ? (
            <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--text-gray)', fontSize: 14 }}>
              {projects.length === 0
                ? 'No open procurements match your registered categories yet.'
                : 'You have already submitted bids on all eligible procurements.'}
            </div>
          ) : (
            <div className="sd-projects-list">
              {available.map(p => (
                <div className="sd-project-row" key={p.id}>
                  <div className="sd-proj-icon"><FolderOpen size={16} /></div>
                  <div className="sd-proj-info">
                    <span className="sd-bold">{p.name}</span>
                    <span className="sd-muted">{p.id} · {p.category}</span>
                  </div>
                  <div className="sd-proj-right">
                    <span className="sd-proj-budget">{p.budget}</span>
                    <span className="sd-muted sd-small">Due {p.deadline}</span>
                  </div>
                  {eligible
                    ? <button className="sd-bid-btn" onClick={() => setModal(p)}>Bid <ArrowRight size={13} /></button>
                    : <button className="sd-bid-btn sd-bid-locked" disabled title="Approval required before bidding"><Lock size={12} /> Locked</button>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="sd-card">
          <div className="sd-card-header">
            <div><h2>My Bids</h2><p>Your submitted bids</p></div>
          </div>
          {loadingBids && bids.length === 0 ? (
            <div style={{ padding: '12px 24px' }}><ListSkeleton rows={2} height={48} /></div>
          ) : bids.length === 0 ? (
            <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--text-gray)', fontSize: 14 }}>
              No bids submitted yet.
            </div>
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
                    <span className={`badge ${BID_STATUS[b.status] || 'badge-yellow'}`}>{b.status.replace('_', ' ')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="sd-card sd-status-card">
        <div className="sd-card-header">
          <div><h2>Account Status</h2><p>Your registration and approval details</p></div>
        </div>
        <div className="sd-status-body">
          <div className="sd-status-item">
            <CheckCircle2 size={18} className="sd-check" />
            <div><span className="sd-bold">Account Registered</span><span className="sd-muted">{profile?.registered || '—'}</span></div>
          </div>
          <div className="sd-status-divider" />
          <div className="sd-status-item">
            {eligible ? <CheckCircle2 size={18} className="sd-check" /> : <Clock size={18} className="sd-clock" />}
            <div><span className="sd-bold">Admin Verification</span><span className="sd-muted">{approvalLabel}</span></div>
          </div>
          <div className="sd-status-divider" />
          <div className="sd-status-item">
            {eligible ? <CheckCircle2 size={18} className="sd-check" /> : <Lock size={18} className="sd-clock" />}
            <div><span className="sd-bold">Eligible to Bid</span><span className="sd-muted">{eligible ? 'Active on all open projects' : 'Locked until approved'}</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SupplierProjects({ projects, bids, onBid, eligible, loading, profile }) {
  const [modal, setModal] = useState(null)
  const alreadyBid = new Set(bids.map(b => b.projectId))

  return (
    <div className="sd-content">
      {modal && <BidModal project={modal} profile={profile} onClose={() => setModal(null)} onSubmit={onBid} />}
      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>Bid Opportunities</h2><p>Procurements open for bidding that match your registered business categories</p></div>
        </div>
        {loading && projects.length === 0 ? (
          <table className="sd-table">
            <thead>
              <tr><th>ID</th><th>Project</th><th>Budget</th><th>Category</th><th>Deadline</th><th></th></tr>
            </thead>
            <tbody><TableSkeleton rows={4} cols={6} /></tbody>
          </table>
        ) : projects.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--text-gray)', fontSize: 14 }}>
            No open procurements match your categories right now. Check back later.
          </div>
        ) : (
          <div className="sd-table-scroll">
          <table className="sd-table">
            <thead>
              <tr><th>ID</th><th>Project</th><th>Budget</th><th>Category</th><th>Deadline</th><th></th></tr>
            </thead>
            <tbody>
              {projects.map(p => (
                <tr key={p.id}>
                  <td className="sd-mono">{p.id}</td>
                  <td>
                    <div className="sd-bold">{p.name}</div>
                    <div className="sd-muted sd-small" style={{ maxWidth: 220 }}>{p.description}</div>
                  </td>
                  <td>{p.budget}</td>
                  <td><span className="badge badge-blue">{p.category}</span></td>
                  <td className="sd-muted">{p.deadline}</td>
                  <td>
                    {alreadyBid.has(p.id)
                      ? <span className="badge badge-green">Bid Submitted</span>
                      : eligible
                      ? <button className="sd-bid-btn-table" onClick={() => setModal(p)}>Submit Bid</button>
                      : <span className="badge badge-yellow"><Lock size={11} /> Locked</span>}
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

function SupplierBids({ bids, onWithdraw, loading }) {
  const [detail, setDetail] = useState(null)

  return (
    <div className="sd-content">
      {detail !== null && (
        <BidDetailModal
          bid={bids[detail]}
          onClose={() => setDetail(null)}
          onWithdraw={() => { onWithdraw(bids[detail].id); setDetail(null) }}
        />
      )}
      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>My Bids</h2><p>Track all your submitted bids and their evaluation status</p></div>
        </div>
        {loading && bids.length === 0 ? (
          <table className="sd-table">
            <thead>
              <tr><th>Project</th><th>Amount</th><th>Notes</th><th>Submitted</th><th>Status</th><th></th></tr>
            </thead>
            <tbody><TableSkeleton rows={3} cols={6} /></tbody>
          </table>
        ) : bids.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--text-gray)', fontSize: 14 }}>
            No bids submitted yet. Browse projects to submit your first bid.
          </div>
        ) : (
          <div className="sd-table-scroll">
          <table className="sd-table">
            <thead>
              <tr><th>Project</th><th>Amount</th><th>Notes</th><th>Submitted</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {bids.map((b, i) => (
                <tr key={i}>
                  <td className="sd-bold">{b.project}</td>
                  <td>{b.amount}</td>
                  <td className="sd-muted" style={{ maxWidth: 200, fontSize: 13 }}>{b.notes}</td>
                  <td className="sd-muted">{b.submitted}</td>
                  <td><span className={`badge ${BID_STATUS[b.status] || 'badge-yellow'}`}>{b.status.replace('_', ' ')}</span></td>
                  <td>
                    <button className="sd-btn-view" onClick={() => setDetail(i)}>
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
      date: bids.some(b => b.status === 'shortlisted') ? 'Active' : 'Pending evaluation',
      done: bids.some(b => b.status === 'shortlisted'),
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
          { label: 'Shortlisted',     value: String(bids.filter(b => b.status === 'shortlisted').length),     icon: CheckCircle2, color: 'green'  },
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

function SupplierProfile({ profile, eligible }) {
  if (!profile) {
    return (
      <div className="sd-content">
        <div className="sd-card">
          <div style={{ padding: '40px 24px' }}><ListSkeleton rows={4} height={48} /></div>
        </div>
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
          </div>
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

// ─── Root ─────────────────────────────────────────────────────────────────────

// Module-level cache so the supplier's profile shows instantly on revisit
// instead of flashing empty while it refetches.
let myProfileCache = null

export default function SupplierDashboard() {
  const loc = useLocation()
  const [profile, setProfile] = useState(myProfileCache)
  const [projects, setProjects] = useState([])   // eligible (published + category match)
  const [bids, setBids] = useState([])
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [loadingBids, setLoadingBids] = useState(true)
  const [toast, setToast] = useState(null)
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => { setNavOpen(false) }, [loc.pathname])

  const loadProfile = () => {
    apiGetMySupplier()
      .then(p => { myProfileCache = p; setProfile(p) })
      // Keep showing cached profile if a background refresh fails.
      .catch(() => { if (!myProfileCache) setProfile(null) })
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
  useEffect(() => { loadProfile(); loadProjects(); loadBids() }, [])

  // Verification is the real bidding gate (the admin approve action sets this).
  const eligible = profile?.qualification_status === 'verified'

  // Returns true on success so the modal can close itself (and stay open with the
  // error toast on failure). `formData` is the multipart payload built in BidModal.
  const submitBid = async (project, formData) => {
    try {
      await apiSubmitBid(project.pk, formData)
      loadBids()
      setToast({ type: 'success', message: 'Bid submitted successfully.' })
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
    '/supplier':         'Dashboard',
    '/supplier/projects':'Bid Opportunities',
    '/supplier/bids':    'My Bids',
    '/supplier/status':  'Status',
    '/supplier/profile': 'Profile',
  }
  const title = Object.entries(TITLES).find(([path]) => loc.pathname === path)?.[1] || 'Dashboard'

  return (
    <div className="sd-layout">
      <SupplierSidebar active={loc.pathname} open={navOpen} onClose={() => setNavOpen(false)} profile={profile} />
      {navOpen && <div className="sd-nav-backdrop" onClick={() => setNavOpen(false)} />}
      <div className="sd-main">
        <SupplierHeader title={title} onMenu={() => setNavOpen(true)} profile={profile} />
        {toast && <SupplierToast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
        <div className="sd-body">
          <Routes>
            <Route index element={<SupplierHome projects={projects} bids={bids} onBid={submitBid} eligible={eligible} profile={profile} onResubmitted={loadProfile} setToast={setToast} loadingProjects={loadingProjects} loadingBids={loadingBids} />} />
            <Route path="projects" element={<SupplierProjects projects={projects} bids={bids} onBid={submitBid} eligible={eligible} loading={loadingProjects} profile={profile} />} />
            <Route path="bids"     element={<SupplierBids bids={bids} onWithdraw={withdrawBid} loading={loadingBids} />} />
            <Route path="status"   element={<SupplierStatusPage bids={bids} profile={profile} eligible={eligible} />} />
            <Route path="profile"  element={<SupplierProfile profile={profile} eligible={eligible} />} />
            <Route path="*"        element={<SupplierHome projects={projects} bids={bids} onBid={submitBid} eligible={eligible} profile={profile} onResubmitted={loadProfile} setToast={setToast} loadingProjects={loadingProjects} loadingBids={loadingBids} />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
