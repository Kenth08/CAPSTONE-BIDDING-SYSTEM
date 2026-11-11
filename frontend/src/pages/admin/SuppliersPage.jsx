import { useState, useEffect, useMemo } from 'react'
import { useDebouncedValue } from '../../utils/useDebouncedValue'
import { statementYearOptions } from '../../utils/statementYears'
import {
  Users, Search, ChevronRight, Plus, FileText, Info, Eye, X, AlertTriangle, XCircle, Check, ArrowLeft, Loader2, Download,
} from 'lucide-react'
import {
  apiListSuppliers, apiGetSupplier, apiSupplierApprove, apiSupplierReject, apiSupplierRequestRevision, apiSupplierAcceptDocuments, apiAdminRegisterSupplier, apiSupplierApproveCategories, apiSupplierRejectCategories, apiUnlockAccount,
} from '../../api'
import { useCategories } from '../../store/categoriesStore'
import CategoryDocumentFields, { appendCategoryDocs, categoryDocsProblem, pastExpiryProblem, todayIso, useCategoryDocState, useCategoryRequirements } from '../../components/CategoryDocuments'
import { dropCached, getCached, loadCached } from '../../utils/sessionCache'
import StatusBadge from '../../components/ui/StatusBadge'
import { TableEmpty } from '../../components/ui/EmptyState'
import Stepper from '../../components/ui/Stepper'
import PreviewButton from '../../components/ui/FilePreview'
import {
  SUPPLIERS_CACHE, ConfirmDialog, DocUploader, Info2, Toast, checkDoc, fmtDate, initFlagsFrom,
} from './shared'

// ── Assisted Registration (admin fills the supplier's form for a walk-in
// applicant who brought physical documents) ─────────────────────────────────
const ASSISTED_EMPTY = {
  first_name: '', middle_name: '', last_name: '', email: '', password: '', confirm_password: '',
  company_name: '', company_address: '', phone_number: '', tin: '',
  representative_name: '', mayors_permit_expiry: '', tax_clearance_expiry: '',
  financial_statement_year: '', track_record_description: '',
  declaration_accepted: false,
}
const ASSISTED_REQUIRED_DOCS = [
  { key: 'sec_dti_certificate', label: 'SEC or DTI Certificate' },
  { key: 'mayors_permit', label: "Mayor's Permit / Business Permit" },
  { key: 'philgeps_certificate', label: 'PhilGEPS Registration Certificate' },
  { key: 'valid_id', label: 'Valid ID (Government-issued)' },
  { key: 'tax_clearance_certificate', label: 'Tax Clearance Certificate' },
  { key: 'audited_financial_statements', label: 'Audited Financial Statements' },
  { key: 'bank_reference_letter', label: 'Bank Reference Letter' },
  { key: 'authorization_letter', label: 'Authorization Letter / SPA' },
]
const ASSISTED_OPTIONAL_DOCS = [
  { key: 'performance_certificates', label: 'Performance Certificates / ISO' },
  { key: 'past_contracts', label: 'Past Contracts / Purchase Orders' },
]
// Cached: the supplier list survives navigating away and back, so returning to
// this page shows data instantly instead of a full "Loading…" pass.
// Placeholder row shown while the supplier list loads (matches the 8 columns).
function SupplierRowSkeleton() {
  const widths = ['70%', '60%', '80%', '50%', '65%', '55%', '60%', '40%']
  return (
    <tr>
      {widths.map((w, i) => (
        <td key={i}><span className="ad-skel" style={{ width: w }} /></td>
      ))}
    </tr>
  )
}
export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState(() => getCached(SUPPLIERS_CACHE) || [])
  // Only show the loader on the very first load (when we have nothing cached yet).
  const [loading, setLoading] = useState(() => getCached(SUPPLIERS_CACHE) === undefined)
  const [error, setError] = useState('')
  const [filterTab, setFilterTab] = useState('All')
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search)
  const [viewId, setViewId] = useState(null)
  const [toast, setToast] = useState(null) // { type, message }
  const TABS = ['All', 'Pending', 'Approved', 'Rejected']

  // ── Assisted Registration (walk-in supplier) ────────────────────────────────
  const [showRegisterForm, setShowRegisterForm] = useState(false)
  const [regForm, setRegForm] = useState(ASSISTED_EMPTY)
  const [regTypes, setRegTypes] = useState([])
  const [regFiles, setRegFiles] = useState({})
  const [regErr, setRegErr] = useState('')
  const [regSubmitting, setRegSubmitting] = useState(false)
  const setReg = (k, v) => setRegForm(f => ({ ...f, [k]: v }))
  const toggleRegType = (t) =>
    setRegTypes(list => list.includes(t) ? list.filter(x => x !== t) : [...list, t])
  const onRegDoc = (key, file) => {
    if (!file) return
    const msg = checkDoc(file)
    if (msg) { setRegErr(`${key.replace(/_/g, ' ')}: ${msg}`); return }
    setRegErr('')
    setRegFiles(f => ({ ...f, [key]: file }))
  }
  const removeRegFile = (key) => setRegFiles(f => { const n = { ...f }; delete n[key]; return n })
  // Extra licenses the picked categories require (rules come from the server).
  const regCatReq = useCategoryRequirements(regTypes)
  const regCatDocs = useCategoryDocState()
  const resetRegForm = () => {
    setRegForm(ASSISTED_EMPTY); setRegTypes([]); setRegFiles({}); setRegErr(''); setShowRegisterForm(false)
    regCatDocs.reset()
  }
  const handleRegSubmit = async (e) => {
    e.preventDefault()
    if (regForm.password !== regForm.confirm_password) { setRegErr('Passwords do not match.'); return }
    if (regTypes.length === 0) { setRegErr('Select at least one business type.'); return }
    const missing = ASSISTED_REQUIRED_DOCS.filter(d => !regFiles[d.key])
    if (missing.length) { setRegErr(`Upload all required documents (${missing.length} missing).`); return }
    const catProblem = categoryDocsProblem(regCatReq.docs, regCatDocs.files, regCatDocs.expiries)
    if (catProblem) { setRegErr(catProblem); return }
    if (!regForm.declaration_accepted) { setRegErr('Confirm the declaration before submitting.'); return }
    setRegErr(''); setRegSubmitting(true)
    try {
      const fd = new FormData()
      Object.entries(regForm).forEach(([k, v]) => { if (v !== '' && v !== false) fd.append(k, v) })
      fd.append('declaration_accepted', regForm.declaration_accepted)
      fd.append('business_types', JSON.stringify(regTypes))
      Object.entries(regFiles).forEach(([k, file]) => fd.append(k, file))
      appendCategoryDocs(fd, regCatReq.docs, regCatDocs.files, regCatDocs.expiries)
      const result = await apiAdminRegisterSupplier(fd)
      resetRegForm()
      if (result?.verification_email_sent === false) {
        showToast('error', "Supplier registered, but the verification email couldn't be sent. They can sign in and resend it from their dashboard.")
      } else {
        showToast('success', 'Supplier registered. They must open the emailed verification link before you can approve them.')
      }
      load({ background: true })
    } catch (err) {
      setRegErr(err.message || 'Could not register the supplier. Please try again.')
    } finally {
      setRegSubmitting(false)
    }
  }

  // `background` = refresh silently without blanking the table (used on revisit
  // and after a review action, since we already have data to show).
  const load = ({ background = false } = {}) => {
    if (!background) setLoading(true)
    loadCached(SUPPLIERS_CACHE, apiListSuppliers)
      .then(data => { setSuppliers(data); setError('') })
      // A failed background refresh must NOT wipe data we're already showing —
      // only surface the error when the table is empty (i.e. the first load).
      .catch(err => { if (getCached(SUPPLIERS_CACHE) === undefined) setError(err.message) })
      .finally(() => setLoading(false))
  }
  // First visit: show the loader. Revisit (cache present): refresh in background.
  useEffect(() => { load({ background: getCached(SUPPLIERS_CACHE) !== undefined }) }, [])

  const showToast = (type, message) => setToast({ type, message })

  const filtered = useMemo(() => suppliers.filter(s => {
    const q = query.toLowerCase()
    const matchSearch = !q ||
      (s.company || '').toLowerCase().includes(q) ||
      (s.contact || '').toLowerCase().includes(q) ||
      (s.full_name || '').toLowerCase().includes(q)
    const qs = s.qualification_status
    const matchTab =
      filterTab === 'All'      ? true :
      filterTab === 'Pending'  ? (qs === 'waiting_admin_approval' || qs === 'needs_revision') :
      filterTab === 'Approved' ? qs === 'verified' :
      filterTab === 'Rejected' ? qs === 'rejected' : true
    return matchSearch && matchTab
  }), [suppliers, query, filterTab])

  return (
    <div className="ad-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      {viewId !== null && (
        <SupplierDetailModal
          supplierId={viewId}
          onClose={() => setViewId(null)}
          onReviewed={(message) => { showToast('success', message); load({ background: true }) }}
        />
      )}

      <div className="ad-card">
        <div className="ad-card-header ad-toolbar-row">
          <div className="ad-filter-pills ad-filter-pills-inline" role="tablist" aria-label="Filter suppliers">
            {TABS.map(t => (
              <button key={t} role="tab" aria-selected={filterTab === t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
            ))}
          </div>
          <div className="ad-toolbar">
            <label className="ad-search-inline">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search suppliers</span>
              <input placeholder="Search by company or name" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
            <button className="ad-btn-primary" onClick={() => setShowRegisterForm(true)}>
              <Plus size={14} /> Register Supplier
            </button>
          </div>
        </div>

        {showRegisterForm && (
          <AssistedRegisterModal
            form={regForm} set={setReg} types={regTypes} toggleType={toggleRegType}
            files={regFiles} onFile={onRegDoc} removeFile={removeRegFile}
            error={regErr} setError={setRegErr} submitting={regSubmitting}
            onSubmit={handleRegSubmit} onClose={resetRegForm}
            catReq={regCatReq} catDocs={regCatDocs}
          />
        )}

        <div className="ad-table-scroll ad-x-scroll">
        <table className="ad-table">
          <thead>
            <tr>
              <th>Company</th><th>Contact</th><th>Business Type</th><th>Status</th>
              <th>Qualification Status</th><th>Email Verified</th><th>Registered</th><th className="ad-actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }).map((_, i) => <SupplierRowSkeleton key={i} />)
              : error
              ? <TableEmpty colSpan={8} icon={AlertTriangle} title="Could not load suppliers" description={error} />
              : filtered.length === 0
              ? <TableEmpty colSpan={8} icon={Users}
                  title={search || filterTab !== 'All' ? 'No suppliers match your filters' : 'No suppliers yet'}
                  description={search || filterTab !== 'All'
                    ? 'Try a different search or filter.'
                    : 'Suppliers appear here when they self-register or you register one in person.'} />
              : filtered.map(s => (
                <tr key={s.id}>
                  <td className="ad-bold">{s.company}</td>
                  <td>{s.contact || s.full_name}</td>
                  <td className="ad-muted" style={{ maxWidth: 200, wordBreak: 'break-word', fontSize: 12 }}>{s.business_type}</td>
                  <td><StatusBadge domain="supplier" status={s.status} /></td>
                  <td>
                    <div className="ad-badge-stack">
                      <StatusBadge domain="qualification" status={s.qualification_status} />
                      {s.documents_complete === false && (
                        <StatusBadge tone="danger" dot={false} label="Documents incomplete or expired"
                          title="A required document is missing or expired, or a document expires within 30 days. Open View for details." />
                      )}
                      {s.documents_to_review > 0 && (
                        <StatusBadge tone="warning" dot={false} label={`${s.documents_to_review} renewal${s.documents_to_review === 1 ? '' : 's'} to review`}
                          title="The supplier uploaded a renewed document. Open View to accept or flag it." />
                      )}
                      {s.category_request_status === 'pending' && (
                        <StatusBadge tone="warning" dot={false} label="Category change"
                          title="This supplier asked to change their business categories" />
                      )}
                    </div>
                  </td>
                  <td><StatusBadge domain="email" status={!!s.email_verified} /></td>
                  <td className="ad-muted ad-nowrap">{fmtDate(s.registered)}</td>
                  <td className="ad-actions-col">
                    <button className="ad-btn-view-sm" onClick={() => setViewId(s.id)}>
                      <Eye size={13} /> View
                    </button>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}
// Walk-in supplier registration, filled out by the Admin on the supplier's
// behalf. Same fields/validation as the public self-registration form — only
// who fills it in differs. Opens as a modal so it never pushes the table down.
// Label + input pair with a proper htmlFor link, required marker and hint.
// Module-level (not inside the modal) so inputs keep focus while typing.
function FormField({ id, label, required = true, hint, full, children }) {
  return (
    <div className={`ad-form-group${full ? ' ad-form-full' : ''}`}>
      <label htmlFor={id}>
        {label}{required && <span className="ui-req" aria-hidden="true">*</span>}
      </label>
      {children}
      {hint && <span className="ui-hint">{hint}</span>}
    </div>
  )
}
const ASSISTED_STEPS = ['Basic Info', 'Documents', 'Declaration', 'Review']
function AssistedRegisterModal({ form, set, types, toggleType, files, onFile, removeFile, error, setError, submitting, onSubmit, onClose, catReq, catDocs }) {
  const [step, setStep] = useState(0)
  const categories = useCategories()

  const validateStep = () => {
    if (step === 0) {
      const need = ['first_name', 'last_name', 'email', 'company_name', 'company_address',
        'phone_number', 'tin', 'representative_name']
      if (need.some(k => !form[k].trim())) return 'Please fill in all required fields.'
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return 'Enter a valid email address.'
      if (!/^\d+$/.test(form.phone_number)) return 'Phone number must contain digits only.'
      if (!/^[\d-]+$/.test(form.tin)) return 'TIN must contain digits only.'
      if (form.password.length < 8) return 'Password must be at least 8 characters.'
      if (form.password !== form.confirm_password) return 'Passwords do not match.'
      if (types.length === 0) return 'Select at least one business type.'
    }
    if (step === 1) {
      const missing = ASSISTED_REQUIRED_DOCS.filter(d => !files[d.key])
      if (missing.length) return `Upload all required documents (${missing.length} missing).`
      const baseExpiry = pastExpiryProblem("Mayor's Permit", form.mayors_permit_expiry)
        || pastExpiryProblem('Tax Clearance Certificate', form.tax_clearance_expiry)
      if (baseExpiry) return baseExpiry
      if (catReq.loading) return 'Still checking which documents the categories need. Try again in a moment.'
      if (catReq.error) return 'Could not load the category documents. Use "Try again" in that section.'
      const catProblem = categoryDocsProblem(catReq.docs, catDocs.files, catDocs.expiries)
      if (catProblem) return catProblem
    }
    if (step === 2 && !form.declaration_accepted) {
      return 'Confirm the declaration before continuing.'
    }
    return ''
  }

  const next = () => {
    const msg = validateStep()
    if (msg) { setError(msg); return }
    setError('')
    setStep(s => Math.min(s + 1, ASSISTED_STEPS.length - 1))
  }
  const back = () => { setError(''); setStep(s => Math.max(s - 1, 0)) }

  const requiredUploaded = ASSISTED_REQUIRED_DOCS.filter(d => files[d.key]).length
  const optionalUploaded = ASSISTED_OPTIONAL_DOCS.filter(d => files[d.key]).length
  const catRequired = catReq.docs.filter(d => d.required)
  const catRequiredDone = catRequired.filter(d => catDocs.files[d.key]).length

  return (
    // No click-outside-to-close: onClose resets the whole registration form, so a
    // stray click on the backdrop used to wipe everything typed and uploaded.
    <div className="ad-modal-overlay">
      <div
        className="ad-modal ad-modal-wizard"
        style={{ maxWidth: 720 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="assisted-reg-title"
      >
        <div className="ad-modal-header">
          <div>
            <h3 id="assisted-reg-title">Assisted Supplier Registration</h3>
            <p className="ad-muted ad-small" style={{ marginTop: 4, maxWidth: 560 }}>
              For a supplier applying in person. The account still needs your approval before they can bid.
            </p>
          </div>
          <button type="button" className="ad-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="ad-wizard-steps">
          <Stepper steps={ASSISTED_STEPS} current={step} label="Registration steps" />
        </div>

        <div className="ad-modal-body">
          {error && <div className="ad-modal-error" role="alert"><AlertTriangle size={15} /> {error}</div>}

          {step === 0 && (
            <div>
              <section className="ui-form-section">
                <div className="ui-form-section-title">Account login</div>
                <div className="ad-form-grid">
                  <FormField id="ar-first-name" label="First Name">
                    <input id="ar-first-name" autoComplete="off" value={form.first_name} onChange={e => set('first_name', e.target.value)} />
                  </FormField>
                  <FormField id="ar-middle-name" label="Middle Name" required={false} hint="Optional">
                    <input id="ar-middle-name" autoComplete="off" value={form.middle_name} onChange={e => set('middle_name', e.target.value)} />
                  </FormField>
                  <FormField id="ar-last-name" label="Last Name">
                    <input id="ar-last-name" autoComplete="off" value={form.last_name} onChange={e => set('last_name', e.target.value)} />
                  </FormField>
                  <FormField id="ar-email" label="Email Address" hint="Used to sign in and receive the verification link.">
                    <input id="ar-email" type="email" autoComplete="off" inputMode="email" value={form.email} onChange={e => set('email', e.target.value)} />
                  </FormField>
                  <FormField id="ar-password" label="Password" hint="At least 8 characters.">
                    <input id="ar-password" type="password" autoComplete="new-password" value={form.password} onChange={e => set('password', e.target.value)} />
                  </FormField>
                  <FormField id="ar-confirm" label="Confirm Password">
                    <input id="ar-confirm" type="password" autoComplete="new-password" value={form.confirm_password} onChange={e => set('confirm_password', e.target.value)} />
                  </FormField>
                </div>
              </section>

              <section className="ui-form-section">
                <div className="ui-form-section-title">Company details</div>
                <div className="ad-form-grid">
                  <FormField id="ar-company" label="Company Name" full>
                    <input id="ar-company" autoComplete="off" value={form.company_name} onChange={e => set('company_name', e.target.value)} />
                  </FormField>
                  <FormField id="ar-address" label="Company Address" full>
                    <input id="ar-address" autoComplete="off" value={form.company_address} onChange={e => set('company_address', e.target.value)} />
                  </FormField>
                  <FormField id="ar-phone" label="Phone Number" hint="Digits only.">
                    <input id="ar-phone" autoComplete="off" inputMode="numeric" value={form.phone_number} onChange={e => set('phone_number', e.target.value.replace(/[^\d]/g, ''))} />
                  </FormField>
                  <FormField id="ar-tin" label="TIN" hint="Digits and dashes only.">
                    <input id="ar-tin" autoComplete="off" inputMode="numeric" value={form.tin} onChange={e => set('tin', e.target.value.replace(/[^\d-]/g, ''))} />
                  </FormField>
                  <FormField id="ar-rep" label="Representative Name" full>
                    <input id="ar-rep" autoComplete="off" value={form.representative_name} onChange={e => set('representative_name', e.target.value)} />
                  </FormField>
                </div>
              </section>

              <section className="ui-form-section">
                <div className="ui-form-section-title">
                  Business type<span className="ui-req" aria-hidden="true">*</span>
                </div>
                <p className="ui-hint" style={{ marginTop: -6, marginBottom: 10 }}>
                  Select at least one category the supplier can bid on.
                </p>
                <div className="ad-checks" role="group" aria-label="Business type">
                  {categories.map(t => (
                    <label key={t} className={types.includes(t) ? 'on' : ''}>
                      <input type="checkbox" checked={types.includes(t)} onChange={() => toggleType(t)} />
                      {t}
                    </label>
                  ))}
                </div>
              </section>
            </div>
          )}

          {step === 1 && (
            <div>
              <section className="ui-form-section">
                <div className="ui-form-section-title ad-section-title-row">
                  <span>Required documents<span className="ui-req" aria-hidden="true">*</span></span>
                  <StatusBadge
                    tone={requiredUploaded === ASSISTED_REQUIRED_DOCS.length ? 'success' : 'neutral'}
                    label={`${requiredUploaded} / ${ASSISTED_REQUIRED_DOCS.length} uploaded`}
                  />
                </div>
                <p className="ui-hint" style={{ marginTop: -6, marginBottom: 12 }}>
                  A clear, fully readable scan or photo. PDF, JPG or PNG, max 5 MB each.
                </p>
                <div className="ad-doc-grid">
                  {ASSISTED_REQUIRED_DOCS.map(d => (
                    <DocUploader key={d.key} doc={d} file={files[d.key]} onFile={onFile}
                      onRemove={() => removeFile(d.key)} />
                  ))}
                </div>
              </section>

              <section className="ui-form-section">
                <div className="ui-form-section-title">Validity &amp; financials</div>
                <div className="ad-form-grid">
                  <FormField id="ar-mp-exp" label="Mayor's Permit Expiry" required={false}>
                    <input id="ar-mp-exp" type="date" min={todayIso()} value={form.mayors_permit_expiry} onChange={e => set('mayors_permit_expiry', e.target.value)} />
                  </FormField>
                  <FormField id="ar-tc-exp" label="Tax Clearance Expiry" required={false}>
                    <input id="ar-tc-exp" type="date" min={todayIso()} value={form.tax_clearance_expiry} onChange={e => set('tax_clearance_expiry', e.target.value)} />
                  </FormField>
                  <FormField id="ar-fs-year" label="Financial Statement Year" required={false} hint="Year of the Audited Financial Statements.">
                    <select id="ar-fs-year" value={form.financial_statement_year}
                      onChange={e => set('financial_statement_year', e.target.value)}>
                      <option value="">Select year</option>
                      {statementYearOptions().map(y => <option key={y} value={y}>{y}</option>)}
                    </select>
                  </FormField>
                </div>
              </section>

              {(catReq.loading || catReq.error || catReq.docs.length > 0) && (
                <section className="ui-form-section">
                  <div className="ui-form-section-title ad-section-title-row">
                    <span>Category documents</span>
                    {catRequired.length > 0 && (
                      <StatusBadge
                        tone={catRequiredDone === catRequired.length ? 'success' : 'neutral'}
                        label={`${catRequiredDone} / ${catRequired.length} required uploaded`}
                      />
                    )}
                  </div>
                  <p className="ui-hint" style={{ marginTop: -6, marginBottom: 12 }}>
                    Required by the selected categories. Enter each expiry date.
                  </p>
                  <CategoryDocumentFields req={catReq} state={catDocs} onError={setError} idPrefix="ar-catdoc" />
                </section>
              )}

              <section className="ui-form-section">
                <div className="ui-form-section-title">Optional documents</div>
                <div className="ad-doc-grid">
                  {ASSISTED_OPTIONAL_DOCS.map(d => (
                    <DocUploader key={d.key} doc={d} file={files[d.key]} onFile={onFile}
                      onRemove={() => removeFile(d.key)} optional />
                  ))}
                </div>
                <div className="ad-form-grid" style={{ marginTop: 14 }}>
                  <FormField id="ar-track" label="Track Record Description" required={false} full>
                    <textarea id="ar-track" rows={2} value={form.track_record_description}
                      onChange={e => set('track_record_description', e.target.value)}
                      placeholder="Brief description of similar projects" />
                  </FormField>
                </div>
              </section>
            </div>
          )}

          {step === 2 && (
            <section className="ui-form-section">
              <div className="ui-form-section-title">Declaration</div>
              <p className="ad-small" style={{ lineHeight: 1.6, color: 'var(--text-body)' }}>
                Confirm with the supplier, in person, that everything provided is true, accurate and authentic.
                Any false statement or falsified document is grounds for disqualification.
              </p>
              <label className={`ad-declare${form.declaration_accepted ? ' on' : ''}`}>
                <input type="checkbox" checked={form.declaration_accepted}
                  onChange={e => set('declaration_accepted', e.target.checked)} />
                <span>The supplier confirms the information and documents provided are true, accurate, and authentic to the best of their knowledge.<span className="ui-req" aria-hidden="true">*</span></span>
              </label>
            </section>
          )}

          {step === 3 && (
            <section className="ui-form-section">
              <div className="ui-form-section-title">Review before submitting</div>
              <div className="ad-info-grid">
                <Info2 label="Company" value={form.company_name} />
                <Info2 label="Representative" value={form.representative_name} />
                <Info2 label="Email" value={form.email} />
                <Info2 label="Phone" value={form.phone_number} />
                <Info2 label="Required Docs Uploaded" value={`${requiredUploaded}/${ASSISTED_REQUIRED_DOCS.length}`} />
                <Info2 label="Optional Docs Uploaded" value={`${optionalUploaded}`} />
                {catReq.docs.length > 0 && (
                  <Info2 label="Category Docs Uploaded"
                    value={`${catReq.docs.filter(d => catDocs.files[d.key]).length}/${catReq.docs.length}`
                      + (catRequired.length ? ` (${catRequiredDone}/${catRequired.length} required)` : '')} />
                )}
                <Info2 label="Status After Submission" value="Pending Verification" />
              </div>
              <div className="ui-callout ui-callout--neutral" style={{ marginTop: 12 }}>
                <Info size={16} className="ui-callout-icon" />
                <span>
                  The account is created now. Approve it from the Suppliers list before they can bid.
                </span>
              </div>
            </section>
          )}
        </div>

        <div className="ad-modal-footer">
          <button type="button" className="ui-btn ui-btn--ghost" onClick={onClose}>Cancel</button>
          <div className="ad-modal-footer-actions">
            {step > 0 && (
              <button type="button" className="ad-btn-cancel" onClick={back}>
                <ArrowLeft size={14} /> Back
              </button>
            )}
            {step < ASSISTED_STEPS.length - 1
              ? <button type="button" className="ad-btn-primary" onClick={next}>Continue <ChevronRight size={14} /></button>
              : <button type="button" className="ad-btn-primary" disabled={submitting} onClick={onSubmit}>
                  {submitting ? <><Loader2 size={14} className="ui-spin" /> Registering…</> : <><Check size={14} /> Register Supplier</>}
                </button>}
          </div>
        </div>
      </div>
    </div>
  )
}
// ── Supplier detail / review modal ────────────────────────────────────────────

// Per-supplier detail cache so reopening the same supplier's profile is instant.
const supplierDetailCache = (id) => `admin:supplier:${id}`
// Placeholder layout shown while a supplier's profile loads in the modal.
function SupplierDetailSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <span className="ad-skel" style={{ width: 90, height: 22, borderRadius: 12 }} />
        <span className="ad-skel" style={{ width: 120, height: 22, borderRadius: 12 }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="ad-skel" style={{ width: '40%', height: 10 }} />
            <span className="ad-skel" style={{ width: '75%' }} />
          </div>
        ))}
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <span key={i} className="ad-skel" style={{ width: '100%', height: 40, borderRadius: 8 }} />
      ))}
    </div>
  )
}
// Missing / Expired (red), "Expires in X days" (orange, within 30 days) or the
// plain expiry date. Expired documents block NEW approvals only; a supplier
// who is already verified keeps bidding, so this is how the Admin notices.
function DocExpiryBadges({ doc }) {
  if (doc.expired) {
    return (
      <span className="cd-badge cd-badge-missing" title="Expired documents count as missing for approval.">
        Expired {fmtDate(doc.expiry_date)}
      </span>
    )
  }
  return (
    <>
      {doc.missing && (
        <span className="cd-badge cd-badge-missing"
          title={doc.url ? 'The file is no longer in storage — ask the supplier to upload it again.' : 'Not uploaded yet'}>
          Missing
        </span>
      )}
      {doc.expiring_soon
        ? <span className="cd-badge cd-badge-warn">Expires in {doc.days_left} day{doc.days_left === 1 ? '' : 's'}</span>
        : doc.expiry_date && !doc.missing && <span className="ad-doc-expiry">Expires {fmtDate(doc.expiry_date)}</span>}
    </>
  )
}
// "View" for a supplier document — only when there's really a file to open.
// The backend sets `present: false` when a document was never uploaded OR its
// file is gone from storage (e.g. lost on an old Render restart); in the
// second case `url` still exists but opening it only returns a 404 page, so
// show a clear message instead of a link that goes nowhere.
function SupplierDocView({ doc }) {
  if (!doc.url) {
    return <span className="ad-doc-nofile" title="The supplier hasn't uploaded this document."><FileText size={13} aria-hidden="true" /> No file uploaded</span>
  }
  if (doc.present === false) {
    return (
      <span className="ad-doc-nofile ad-doc-nofile-lost"
        title="This document is on record, but its file is no longer in storage. Flag it and request a revision so the supplier uploads it again.">
        <AlertTriangle size={13} aria-hidden="true" /> File not available
      </span>
    )
  }
  return (
    <span className="ad-doc-actions">
      <PreviewButton url={doc.url} name={doc.label} className="ad-doc-view" />
      <a className="ad-doc-view" href={doc.url} target="_blank" rel="noreferrer"><Download size={13} /> Download</a>
    </span>
  )
}
// Base documents first, then one group per business category (its extra
// licenses). `pending` marks a category that is only in a change request.
function supplierDocGroups(documents = []) {
  const groups = [{ key: 'base', title: null, pending: false, docs: documents.filter(d => d.source !== 'category') }]
  const byCategory = {}
  documents.filter(d => d.source === 'category').forEach(d => {
    if (!byCategory[d.category]) {
      byCategory[d.category] = { key: d.category, title: d.category, pending: !!d.pending_category, docs: [] }
    }
    byCategory[d.category].docs.push(d)
  })
  return [...groups, ...Object.values(byCategory)]
}
// Supplier review starts from "everything checked": a document is flagged only
// if it is already waiting for a revision, or a required file is missing or
// no longer in storage (it can't be accepted, so it is always in the request).
// The reviewer unticks what has a problem; the unticked ones are sent back.
const isMissingFile = (d) => !d.url || d.present === false
const initSupplierFlags = (data) => {
  const initial = initFlagsFrom(data)
  const undecided = !['verified', 'rejected'].includes(data?.qualification_status)
  ;(data?.documents || []).forEach(d => {
    if (undecided && d.required && isMissingFile(d) && !initial[d.key]) {
      initial[d.key] = { checked: true, note: d.url ? 'The file is no longer in storage. Please upload it again.' : 'Not uploaded yet.' }
    }
  })
  return initial
}
function SupplierDetailModal({ supplierId, onClose, onReviewed }) {
  const cached = getCached(supplierDetailCache(supplierId))
  const [supplier, setSupplier] = useState(cached || null)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState('')
  // Seed the editable fields from cache so a reopened modal is fully populated.
  // flags[key].checked = flagged for revision (shown UNticked: a tick means "checked, OK").
  const [flags, setFlags] = useState(() => initSupplierFlags(cached))   // { key: { checked, note } }
  const [note, setNote] = useState(cached?.admin_notes || '')        // overall message
  const [confirm, setConfirm] = useState(null) // { title, message, tone, onConfirm }
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const key = supplierDetailCache(supplierId)
    const hadCache = getCached(key) !== undefined
    if (!hadCache) setLoading(true)
    loadCached(key, () => apiGetSupplier(supplierId))
      .then(data => {
        setSupplier(data)
        // Only seed the editable fields on the first load — don't overwrite the
        // admin's in-progress edits when a background refresh resolves.
        if (!hadCache) {
          setNote(data.admin_notes || '')
          setFlags(initSupplierFlags(data))
        }
      })
      // A failed background refresh keeps the cached profile on screen.
      .catch(err => { if (getCached(key) === undefined) setError(err.message) })
      .finally(() => setLoading(false))
  }, [supplierId])

  const toggleFlag = (key) =>
    setFlags(f => ({ ...f, [key]: { checked: !f[key]?.checked, note: f[key]?.note || '' } }))
  const setFlagNote = (key, val) =>
    setFlags(f => ({ ...f, [key]: { checked: f[key]?.checked ?? true, note: val } }))

  const flaggedDocs = () => {
    const out = {}
    Object.entries(flags).forEach(([k, v]) => { if (v.checked) out[k] = v.note || '' })
    return out
  }

  const runAction = async (fn, successMsg) => {
    setBusy(true)
    try {
      await fn()
      // The action changed this supplier — drop the stale detail cache so a
      // reopen reloads fresh (the list refresh is handled by onReviewed).
      dropCached(supplierDetailCache(supplierId))
      onReviewed(successMsg)
      onClose()
    } catch (err) {
      setError(err.message)
      setConfirm(null)
    } finally {
      setBusy(false)
    }
  }

  const handleApprove = () => setConfirm({
    title: 'Approve supplier?',
    message: `${supplier.company} will be marked Verified and allowed to submit bids.`,
    tone: 'green',
    confirmLabel: 'Approve',
    onConfirm: () => runAction(() => apiSupplierApprove(supplierId), 'Supplier approved.'),
  })

  const handleRequestRevision = () => {
    const docs = flaggedDocs()
    if (Object.keys(docs).length === 0) {
      setError('Untick at least one document that needs fixing. Every ticked document is accepted as it is.')
      return
    }
    setConfirm({
      title: 'Request revision?',
      message: decided && flagsRenewal
        ? `The supplier will be asked to re-upload ${Object.keys(docs).length} document(s). Their account goes back to Needs Revision, so they can't bid until you approve them again.`
        : decided
        ? `The supplier will be asked to re-upload ${Object.keys(docs).length} license(s) for the requested categories. They stay verified and keep bidding in their current categories.`
        : `The supplier will be notified to re-upload ${Object.keys(docs).length} document(s). They cannot bid until re-approved.`,
      tone: 'orange',
      confirmLabel: 'Send Revision Request',
      onConfirm: () => runAction(
        () => apiSupplierRequestRevision(supplierId, { note, documents: docs }),
        'Revision request sent to supplier.'
      ),
    })
  }

  const handleReject = () => setConfirm({
    title: 'Reject supplier?',
    message: `${supplier.company} will be marked Rejected. Add a reason below so they understand why.`,
    tone: 'red',
    confirmLabel: 'Reject',
    onConfirm: () => runAction(() => apiSupplierReject(supplierId, note), 'Supplier rejected.'),
  })

  // Once a supplier has been approved (or rejected), the modal becomes a
  // read-only profile view — no checkboxes, no decision footer.
  const decided = supplier?.qualification_status === 'verified' || supplier?.qualification_status === 'rejected'
  // A verified supplier's profile is read-only, except the licenses of a
  // pending category request: the Admin can flag those without un-verifying them.
  // A verified supplier can still have documents to look at: licenses for a
  // requested category, and renewals they uploaded for expired permits.
  const isVerified = supplier?.qualification_status === 'verified'
  const canFlag = (d) => !decided || (isVerified && (d.pending_category || d.review_status === 'renewed'))
  const pendingFlagCount = (supplier?.documents || [])
    .filter(d => canFlag(d) && flags[d.key]?.checked).length
  const flagsRenewal = (supplier?.documents || [])
    .some(d => d.review_status === 'renewed' && flags[d.key]?.checked)

  return (
    <div className="ad-modal-overlay" onClick={onClose}>
      <div className="ad-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-header">
          <div>
            {loading
              ? <span className="ad-skel" style={{ width: 180, height: 18 }} />
              : <h3>{supplier?.company}</h3>}
            {!loading && supplier && (
              <p className="ad-muted ad-small">{supplier.full_name || supplier.contact} · {supplier.email}</p>
            )}
          </div>
          <button className="ad-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {loading ? (
          <div className="ad-modal-body"><SupplierDetailSkeleton /></div>
        ) : !supplier ? (
          <div className="ad-modal-body" style={{ padding: 40, textAlign: 'center' }}>{error || 'Could not load supplier.'}</div>
        ) : (
          <>
            <div className="ad-modal-body">
              {error && <div className="ad-modal-error"><AlertTriangle size={15} /> {error}</div>}
              {!decided && !supplier.email_verified && (
                <div className="ad-modal-error" role="status">
                  <AlertTriangle size={15} /> Email not verified yet — this supplier can't be approved
                  until they open the verification link sent to {supplier.email}. If they didn't get it, they can
                  sign in and select Resend Email on their dashboard.
                </div>
              )}

              {supplier.account_locked_until && (
                <div className="ad-modal-error" role="status">
                  <AlertTriangle size={15} /> Sign-in locked after repeated wrong passwords, until{' '}
                  {new Date(supplier.account_locked_until).toLocaleTimeString()}.
                  <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" style={{ marginLeft: 'auto' }} disabled={busy}
                    onClick={() => runAction(() => apiUnlockAccount(supplier.user_id), 'Account unlocked.')}>
                    Unlock account
                  </button>
                </div>
              )}

              <div className="ad-modal-badges">
                <StatusBadge domain="supplier" status={supplier.status} />
                <StatusBadge domain="qualification" status={supplier.qualification_status} />
                <StatusBadge domain="email" status={!!supplier.email_verified} label={supplier.email_verified ? 'Email Verified' : 'Email Unverified'} />
              </div>

              <div className="ad-info-grid">
                <Info2 label="Representative" value={supplier.representative_name || supplier.contact} />
                <Info2 label="Email" value={supplier.email} />
                <Info2 label="Phone" value={supplier.phone_number} />
                <Info2 label="TIN" value={supplier.tin} />
                <Info2 label="Address" value={supplier.company_address} full />
                <BusinessTypesInfo supplier={supplier} />
                <Info2 label="Registered" value={fmtDate(supplier.registered)} />
                <Info2 label="Financial Year" value={supplier.financial_statement_year} />
              </div>

              <CategoryRequestPanel
                supplier={supplier}
                busy={busy}
                onApprove={() => setConfirm({
                  title: 'Approve category change?',
                  message: `${supplier.company} will be able to see and bid on procurements in the requested categories.`,
                  tone: 'green',
                  confirmLabel: 'Approve change',
                  onConfirm: () => runAction(() => apiSupplierApproveCategories(supplierId), 'Category change approved.'),
                })}
                onReject={(reason) => setConfirm({
                  title: 'Decline category change?',
                  message: `${supplier.company} keeps their current categories.`,
                  tone: 'red',
                  confirmLabel: 'Decline change',
                  onConfirm: () => runAction(() => apiSupplierRejectCategories(supplierId, reason), 'Category change declined.'),
                })}
              />

              <div className="ad-docs-head">
                <FileText size={15} /> Uploaded Documents
              </div>
              {!decided && (
                <div className="ad-docs-hint">
                  <Info size={15} />
                  <span>
                    Every uploaded document starts <strong>ticked</strong>. Open each one with <strong>Preview</strong>, <strong>untick</strong> any with a problem and say what to fix, then click <strong>Request Revision</strong>. Missing required files are included automatically.
                  </span>
                </div>
              )}
              {supplierDocGroups(supplier.documents).map(group => (
              <div className="ad-doc-group" key={group.key}>
              {group.title && (
                <div className="ad-doc-group-head">
                  <span>{group.title} licenses</span>
                  {group.pending && <span className="cd-badge cd-badge-warn">Requested category</span>}
                </div>
              )}
              <div className="ad-docs-list">
                {group.docs.map(d => {
                  const checked = !!flags[d.key]?.checked
                  const rs = d.review_status
                  const rowCls = checked ? ' flagged' : rs === 'resubmitted' ? ' resubmitted' : ''
                  return (
                    <div className={`ad-doc-row${rowCls}`} key={d.key}>
                      <div className="ad-doc-main">
                        {canFlag(d) && (
                          <label className="ad-doc-check" title={isMissingFile(d) ? 'No file to accept' : checked ? 'Tick when this document is acceptable' : 'Untick if this document has a problem'}>
                            <input
                              type="checkbox"
                              checked={!checked && !isMissingFile(d)}
                              disabled={isMissingFile(d)}
                              aria-label={`${d.label} is acceptable`}
                              onChange={() => toggleFlag(d.key)}
                            />
                          </label>
                        )}
                        <div className="ad-doc-name">
                          <span className="ad-bold">{d.label}</span>
                          <span className={d.required ? 'ad-req-tag' : 'ad-opt-tag'}>{d.required ? 'Required' : 'Optional'}</span>
                          <DocExpiryBadges doc={d} />
                          {/* Review state at a glance — the admin can still re-check any doc to double-check it. */}
                          {checked
                            ? <span className="ad-doc-status ad-doc-flag">Flagged for revision</span>
                            : rs === 'resubmitted'
                              ? <span className="ad-doc-status ad-doc-resub">Resubmitted — please review</span>
                              : rs === 'renewed'
                                ? <span className="ad-doc-status ad-doc-resub">Renewed — please review</span>
                                : rs === 'approved'
                                  ? <span className="ad-doc-status ad-doc-ok"><Check size={11} /> Reviewed</span>
                                  : null}
                        </div>
                        <SupplierDocView doc={d} />
                        {rs === 'renewed' && !checked && (
                          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy}
                            onClick={() => runAction(() => apiSupplierAcceptDocuments(supplierId, [d.key]),
                              `${d.label} accepted. The supplier was notified.`)}>
                            <Check size={13} /> Accept
                          </button>
                        )}
                      </div>
                      {rs === 'renewed' && !checked && (
                        <div className="ad-doc-prevnote">
                          New copy uploaded by the supplier{d.previous_expiry ? ` to replace one that expired ${fmtDate(d.previous_expiry)}` : ''}.
                          Open it, then Accept, or untick it and Flag it with a note.
                        </div>
                      )}
                      {/* Remind the admin why this doc was sent back, now that it's been re-uploaded. */}
                      {!checked && rs === 'resubmitted' && d.review_note && (
                        <div className="ad-doc-prevnote">Previously flagged: “{d.review_note}”</div>
                      )}
                      {checked && (
                        <input
                          className="ad-doc-note"
                          placeholder="What needs fixing? (e.g. blurry scan, expired)"
                          value={flags[d.key]?.note || ''}
                          onChange={e => setFlagNote(d.key, e.target.value)}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
              </div>
              ))}

              {decided ? (
                supplier.admin_notes ? (
                  <div className="ad-field">
                    <label>Message to supplier</label>
                    <p className="ad-muted ad-small" style={{ margin: 0 }}>{supplier.admin_notes}</p>
                  </div>
                ) : null
              ) : (
                <div className="ad-field">
                  <label>Message to supplier (overall note)</label>
                  <textarea
                    rows={2}
                    placeholder="Optional message shown to the supplier with your decision…"
                    value={note}
                    onChange={e => setNote(e.target.value)}
                  />
                </div>
              )}
            </div>

            <div className="ad-modal-footer">
              <button className="ad-btn-cancel" onClick={onClose}>Close</button>
              {!decided && (
                <div className="ad-modal-footer-actions">
                  <button className="ad-btn-reject" disabled={busy} onClick={handleReject}>
                    <XCircle size={14} /> {busy ? 'Working…' : 'Reject'}
                  </button>
                  <button className="ad-btn-revision" disabled={busy} onClick={handleRequestRevision}>
                    <AlertTriangle size={14} /> {busy ? 'Working…' : 'Request Revision'}
                  </button>
                  {/* The server refuses this too (SupplierViewSet.approve); the
                      disabled state just explains why before the Admin tries. */}
                  <button
                    className="ad-btn-approve"
                    disabled={busy || !supplier.email_verified || pendingFlagCount > 0}
                    title={!supplier.email_verified ? 'The supplier must verify their email address before approval.'
                      : pendingFlagCount > 0 ? `${pendingFlagCount} document(s) are unticked. Request a revision, or tick them if they are acceptable.` : undefined}
                    onClick={handleApprove}
                  >
                    <Check size={14} /> {busy ? 'Working…' : 'Approve'}
                  </button>
                </div>
              )}
              {decided && pendingFlagCount > 0 && (
                <div className="ad-modal-footer-actions">
                  <button className="ad-btn-revision" disabled={busy} onClick={handleRequestRevision}>
                    <AlertTriangle size={14} /> {busy ? 'Working…' : `Flag ${pendingFlagCount} document(s)`}
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {confirm && (
          <ConfirmDialog
            {...confirm}
            busy={busy}
            onCancel={() => setConfirm(null)}
          />
        )}
      </div>
    </div>
  )
}
// Normalize a supplier's business types into a list (the JSON list is the source
// of truth; fall back to splitting the legacy comma-joined string).
function supplierBusinessTypes(supplier) {
  if (Array.isArray(supplier?.business_types) && supplier.business_types.length) {
    return supplier.business_types
  }
  return (supplier?.business_type || '')
    .split(',').map(s => s.trim()).filter(Boolean)
}
// Shows every category the supplier is APPROVED for as chips (handles many).
function BusinessTypesInfo({ supplier }) {
  const types = supplierBusinessTypes(supplier)
  return (
    <div className="ad-info-item ad-info-full">
      <span className="ad-info-label">Business Types{supplier?.category_request_status === 'pending' ? ' (approved)' : ''}</span>
      {types.length === 0 ? (
        <span className="ad-info-value">—</span>
      ) : (
        <div className="ad-chips">
          {types.map(t => <span className="ad-chip" key={t}>{t}</span>)}
        </div>
      )}
    </div>
  )
}
// A verified supplier's pending category change: only an Admin decision here
// changes which procurements they can bid on (enforced server-side by
// approve-categories / reject-categories). Rendered whether or not the
// supplier's registration has already been decided — category requests come
// from VERIFIED suppliers.
function CategoryRequestPanel({ supplier, busy, onApprove, onReject }) {
  const [reason, setReason] = useState('')
  if (supplier?.category_request_status !== 'pending') return null
  const approved = supplierBusinessTypes(supplier)
  const requested = supplier.pending_business_types || []
  const added = requested.filter(c => !approved.includes(c))
  const removed = approved.filter(c => !requested.includes(c))
  // Licenses the NEW categories need. approve-categories refuses while a
  // required one is missing or flagged, so say so before the Admin clicks.
  const newDocs = (supplier.documents || []).filter(d => d.source === 'category' && added.includes(d.category))
  const blocking = newDocs.filter(d => d.missing || d.review_status === 'needs_revision')
  return (
    <div className="ad-field">
      <label>Category change request</label>
      <div className="ad-docs-hint">
        <Info size={15} />
        <span>
          Requested {supplier.category_requested_at ? new Date(supplier.category_requested_at).toLocaleDateString() : ''}.
          {' '}They keep bidding only in their approved categories until you decide.
        </span>
      </div>
      {added.length > 0 && (
        <div className="ad-chips" aria-label="Categories to add">
          {added.map(t => <span className="ad-chip" key={`add-${t}`}>+ {t}</span>)}
        </div>
      )}
      {removed.length > 0 && (
        <div className="ad-chips" aria-label="Categories to remove">
          {removed.map(t => <span className="ad-chip" key={`rm-${t}`}>− {t}</span>)}
        </div>
      )}
      {newDocs.length > 0 && (
        <ul className="ad-catreq-docs" aria-label="Licenses for the requested categories">
          {newDocs.map(d => (
            <li key={d.key}>
              <span className="ad-catreq-doc-name">
                {d.label}
                <span className={d.required ? 'ad-req-tag' : 'ad-opt-tag'}>{d.required ? 'Required' : 'Optional'}</span>
              </span>
              <span className="ad-catreq-doc-state">
                {d.review_status === 'needs_revision'
                  ? <span className="cd-badge cd-badge-warn">Flagged</span>
                  : <DocExpiryBadges doc={d} />}
                {d.url
                  ? <span className="ad-doc-actions"><PreviewButton url={d.url} name={d.label} className="ad-doc-view" /><a className="ad-doc-view" href={d.url} target="_blank" rel="noreferrer"><Download size={13} /> Download</a></span>
                  : <span className="ad-doc-missing">Not uploaded</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {blocking.length > 0 && (
        <div className="ad-modal-error" role="status">
          <AlertTriangle size={15} />
          {' '}Can't approve yet: {blocking.map(d => `${d.label} (${
            d.review_status === 'needs_revision' ? 'flagged' : d.expired ? `expired ${d.expiry_date}` : d.reason || 'missing'
          })`).join(', ')}.
        </div>
      )}
      <textarea
        rows={2}
        placeholder="Reason (shown to the supplier if you decline)…"
        value={reason}
        onChange={e => setReason(e.target.value)}
      />
      <div className="ad-modal-footer-actions">
        <button className="ad-btn-reject" disabled={busy} onClick={() => onReject(reason)}>
          <XCircle size={14} /> Decline change
        </button>
        <button className="ad-btn-approve" disabled={busy} onClick={onApprove}>
          <Check size={14} /> Approve change
        </button>
      </div>
    </div>
  )
}
