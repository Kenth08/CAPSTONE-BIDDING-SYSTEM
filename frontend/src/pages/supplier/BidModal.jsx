import { useState, useEffect, useRef } from 'react'
import {
  X, Send, Upload, Camera, Check, Plus, Loader2,
} from 'lucide-react'
import SecureImg from '../../components/ui/SecureImg'
import { deliveryLabel, warrantyLabel } from '../../utils/bidTerms'
import { LocalPreviewButton } from '../../components/ui/FilePreview'
import {
  MAX_MB, MAX_PRODUCT_IMAGES, ProductImagePicker, UPLOAD_RULES, appendProductImages, profileBusinessTypes, validateBidFile,
} from './shared'

const parseAmount = (s) => Number(String(s).replace(/[^\d.]/g, '')) || 0
// ─── Bid submit modal — building blocks ──────────────────────────────────────

// Checklist row shown after a file is selected: filled emerald check + name + X.
function BidFileRow({ name, file, onRemove }) {
  return (
    <div className="sd-file-row">
      <span className="sd-file-check"><Check size={12} /></span>
      <span className="sd-file-rowname" title={name}>{name}</span>
      {/* Check the picked file before it is submitted. */}
      <LocalPreviewButton file={file} className="sd-file-preview" />
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
        <BidFileRow name={file.name} file={file} onRemove={onRemove} />
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
export default function BidModal({ project, profile, onClose, onSubmit }) {
  const hasRef = !!project.referenceImage
  const needImages = project.requireProductImages
  const [step, setStep] = useState(0)
  const [amount, setAmount] = useState('')
  const [deliveryTimeline, setDeliveryTimeline] = useState('')
  const [deliveryDays, setDeliveryDays] = useState('')       // when the project lists choices
  const [warrantyMonths, setWarrantyMonths] = useState('')
  const deliveryChoices = project.deliveryOptions || []
  const warrantyChoices = project.warrantyOptions || []
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
      if (deliveryChoices.length ? !deliveryDays : !deliveryTimeline.trim()) {
        errs.deliveryTimeline = deliveryChoices.length ? 'Choose your delivery timeline.' : 'Please specify your delivery timeline.'
      }
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
    if (deliveryChoices.length) fd.append('delivery_days', deliveryDays)
    else fd.append('delivery_timeline', deliveryTimeline.trim())
    fd.append('notes', notes.trim())
    fd.append('additional_comments', additionalComments.trim())
    fd.append('brand_name', brandName.trim())
    fd.append('model_number', modelNumber.trim())
    if (warrantyChoices.length) { if (warrantyMonths) fd.append('warranty_months', warrantyMonths) }
    else fd.append('warranty_period', warrantyPeriod.trim())
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
    // No click-outside-to-close: this is a long multi-step form with uploads, and
    // a stray click (or a text selection released over the backdrop) used to
    // discard everything. Only X and Cancel close it.
    <div className="sd-modal-overlay">
      <form className="sd-modal sd-modal-lg" onSubmit={handleSubmit}>
        <div className="sd-modal-header">
          <div>
            <h3>Submit Bid</h3>
            <p className="sd-muted sd-small">{project.id} · {project.name}</p>
          </div>
          <button type="button" className="sd-modal-close" onClick={onClose} disabled={submitting} aria-label="Close"><X size={18} /></button>
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
              <SecureImg src={project.referenceImage} alt="Required product reference" className="sd-refimg-cover" />
              <p className="sd-refimg-note">
                This image shows the exact product specification required by the procuring entity.
                Your bid must match this specification.
              </p>
            </div>
          )}
          <div className="sd-modal-meta">
            <div><span>Budget</span><strong>{project.budget}</strong></div>
            <div><span>Deadline</span><strong>{project.deadline}</strong></div>
            <div><span>Category</span><strong>{project.category}{project.categoryOther ? ` · ${project.categoryOther}` : ''}</strong></div>
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
                  {deliveryChoices.length ? (
                    <select value={deliveryDays}
                      onChange={e => { setDeliveryDays(e.target.value); setErrors(x => ({ ...x, deliveryTimeline: '' })) }}>
                      <option value="">Select delivery timeline</option>
                      {deliveryChoices.map(d => <option key={d} value={d}>{deliveryLabel(d)}</option>)}
                    </select>
                  ) : (
                    <input type="text" placeholder="e.g. 30 days or 6 weeks" value={deliveryTimeline}
                      onChange={e => { setDeliveryTimeline(e.target.value); setErrors(x => ({ ...x, deliveryTimeline: '' })) }} />
                  )}
                  <span className="sd-upload-hint">
                    {deliveryChoices.length ? 'Calendar days from the Notice to Proceed to full delivery, as allowed for this procurement.'
                      : 'Days or weeks from contract signing to full delivery.'}
                  </span>
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
                <p className="sd-bid-section-hint">If you are offering a specific branded product.</p>
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
                  {warrantyChoices.length ? (
                    <select value={warrantyMonths} onChange={e => setWarrantyMonths(e.target.value)}>
                      <option value="">No warranty offered</option>
                      {warrantyChoices.map(m => <option key={m} value={m}>{warrantyLabel(m)}</option>)}
                    </select>
                  ) : (
                    <input type="text" placeholder="e.g. 1 year parts and labor" value={warrantyPeriod}
                      onChange={e => setWarrantyPeriod(e.target.value)} />
                  )}
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
                      ? 'Photos of the exact product you are offering are required. Add its documents if you have them.'
                      : hasRef
                      ? 'Upload files showing your matching product and confirm your product meets the specification.'
                      : 'Add photos and documents of a specific product. This does not affect your eligibility.'}
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
                      <BidFileRow key={i} name={f.name} file={f}
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
                    <textarea rows={3} placeholder="Anything else for the evaluator"
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
                      Your registered documents on file, including your Business Permit, BIR Certificate
                      and PhilGEPS Certificate, are used for eligibility verification.
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
