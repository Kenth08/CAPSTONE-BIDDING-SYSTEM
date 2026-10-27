import { Children, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, CloudUpload, Eye, EyeOff,
  FileText, Info, Loader2, Pencil, RefreshCw, Shield, Trash2, X,
} from 'lucide-react'
import { apiRegisterSupplier } from '../api'
import { CATEGORIES } from '../constants/categories'
import {
  appendCategoryDocs, checkDocFile, pastExpiryProblem, todayIso,
  useCategoryDocState, useCategoryRequirements,
} from '../components/CategoryDocuments'
import '../style/SupplierRegister.css'

// ── Static config ─────────────────────────────────────────────────────────────
const STEPS = [
  { label: 'Basic Info', title: 'Basic information', desc: 'Your sign-in details, company profile and the categories you supply.' },
  { label: 'Documents', title: 'Company documents', desc: 'Upload scanned copies for admin verification. Files are sent only when you submit on the last step.' },
  { label: 'Declaration', title: 'Declaration', desc: 'Read and confirm the statements below before reviewing your registration.' },
  { label: 'Review & Submit', title: 'Review and submit', desc: 'Check everything below. You can go back to any step to make changes.' },
]

// Shared with the procurement category list so eligibility matching lines up.
const BUSINESS_TYPES = CATEGORIES

// key = backend field name, required = must upload to register.
// `expiry` / `extra` place a related form field inside the document's card.
const LEGAL_DOCS = [
  { key: 'sec_dti_certificate', label: 'SEC or DTI Certificate', required: true },
  { key: 'mayors_permit', label: "Mayor's Permit / Business Permit", required: true, expiry: 'mayors_permit_expiry' },
  { key: 'philgeps_certificate', label: 'PhilGEPS Registration Certificate', required: true },
  { key: 'valid_id', label: 'Valid ID (Government-issued)', required: true, help: 'ID of the authorized representative.' },
]
const FINANCIAL_DOCS = [
  { key: 'tax_clearance_certificate', label: 'Tax Clearance Certificate', required: true, expiry: 'tax_clearance_expiry' },
  { key: 'audited_financial_statements', label: 'Audited Financial Statements', required: true, extra: 'financial_statement_year' },
  { key: 'bank_reference_letter', label: 'Bank Reference Letter', required: true },
]
const AUTH_DOCS = [
  { key: 'authorization_letter', label: 'Authorization Letter / SPA', required: true },
]
const OPTIONAL_DOCS = [
  { key: 'performance_certificates', label: 'Performance Certificates / ISO', required: false },
  { key: 'past_contracts', label: 'Past Contracts / Purchase Orders', required: false },
]
const DOC_GROUPS = [
  { id: 'legal', title: 'Legal and business documents', docs: LEGAL_DOCS },
  { id: 'financial', title: 'Financial documents', docs: FINANCIAL_DOCS },
  { id: 'auth', title: 'Representative authorization', docs: AUTH_DOCS },
]
const REQUIRED_KEYS = [...LEGAL_DOCS, ...FINANCIAL_DOCS, ...AUTH_DOCS].map(d => d.key)
const ALL_DOC_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_DOCS.map(d => d.key)]

const FILE_HINT = 'PDF, JPG or PNG · max 5 MB'

// Which step owns each server-side field, so a rejected submission sends the
// user straight to the field that needs fixing.
const STEP0_FIELDS = [
  'full_name', 'email', 'password', 'confirm_password', 'company_name', 'company_address',
  'phone_number', 'tin', 'representative_name', 'business_types',
]
const STEP1_FIELDS = [
  ...ALL_DOC_KEYS, 'mayors_permit_expiry', 'tax_clearance_expiry',
  'financial_statement_year', 'track_record_description',
]
function stepOfField(key) {
  if (STEP0_FIELDS.includes(key)) return 0
  if (STEP1_FIELDS.includes(key) || key.startsWith('catdoc_')) return 1
  if (key === 'declaration_accepted') return 2
  return null
}

// ── Validation helpers ────────────────────────────────────────────────────────
const PASSWORD_RULES = [
  { label: 'At least 8 characters', test: p => p.length >= 8 },
  { label: 'One uppercase letter', test: p => /[A-Z]/.test(p) },
  { label: 'One lowercase letter', test: p => /[a-z]/.test(p) },
  { label: 'One number', test: p => /[0-9]/.test(p) },
  { label: 'One symbol', test: p => /[^A-Za-z0-9]/.test(p) },
]
const passwordValid = (pw) => PASSWORD_RULES.every(r => r.test(pw))

const fmtSize = (bytes) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Props that tie an input to its label, hint and error message.
const describe = (id, error, hint) => ({
  id,
  'aria-invalid': error ? true : undefined,
  'aria-describedby': error ? `${id}-err` : hint ? `${id}-hint` : undefined,
})

export default function SupplierRegister() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [showPass, setShowPass] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState('')
  const [errNonce, setErrNonce] = useState(0) // re-triggers the toast even on a repeat message
  const [loading, setLoading] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [done, setDone] = useState(false)
  const submittingRef = useRef(false)
  const headingRef = useRef(null)

  // Floating toast: a short summary, visible regardless of scroll position.
  const showError = (msg) => { setError(msg); setErrNonce(n => n + 1) }
  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(''), 6000)
    return () => clearTimeout(t)
  }, [error, errNonce])

  const [form, setForm] = useState({
    full_name: '', email: '', password: '', confirm_password: '',
    company_name: '', company_address: '', phone_number: '', tin: '',
    representative_name: '', mayors_permit_expiry: '', tax_clearance_expiry: '',
    financial_statement_year: '', track_record_description: '',
    declaration_accepted: false,
  })
  const [businessTypes, setBusinessTypes] = useState([])
  const [files, setFiles] = useState({}) // { key: File } — held in memory until submit
  // Extra licenses the chosen categories require (rules come from the server).
  const catReq = useCategoryRequirements(businessTypes)
  const catDocs = useCategoryDocState()

  // Per-field problems from the last Continue / submit: { fieldKey: message }.
  // A field's error clears as soon as the user changes it.
  const [fieldErrors, setFieldErrors] = useState({})
  const clearErr = (...keys) => setFieldErrors(e => {
    if (!keys.some(k => k in e)) return e
    const n = { ...e }
    keys.forEach(k => delete n[k])
    return n
  })

  const set = (k, v) => {
    setForm(f => ({ ...f, [k]: v }))
    clearErr(k, ...(k === 'password' ? ['confirm_password'] : []))
  }

  const toggleType = (t) => {
    setBusinessTypes(list => list.includes(t) ? list.filter(x => x !== t) : [...list, t])
    clearErr('business_types')
  }

  // Same type/size rules for every upload; a bad file is flagged on its own card.
  const onFile = (key, file) => {
    if (!file) return
    const msg = checkDocFile(file)
    if (msg) { setFieldErrors(e => ({ ...e, [key]: msg })); return }
    clearErr(key)
    setFiles(f => ({ ...f, [key]: file }))
  }
  const removeFile = (key) => setFiles(f => { const n = { ...f }; delete n[key]; return n })

  const onCatFile = (key, file) => {
    if (!file) return
    const msg = checkDocFile(file)
    if (msg) { setFieldErrors(e => ({ ...e, [`catdoc_${key}`]: msg })); return }
    clearErr(`catdoc_${key}`)
    catDocs.setFile(key, file)
  }
  const onCatRemove = (key) => { catDocs.removeFile(key); clearErr(`catdoc_${key}_expiry`) }
  const onCatExpiry = (key, v) => { catDocs.setExpiry(key, v); clearErr(`catdoc_${key}_expiry`) }

  // ── Per-step gate ───────────────────────────────────────────────────────────
  // Collects EVERY problem on a step (not just the first), so the user sees all
  // the fields to fix at once. `_general` holds problems not tied to one field.
  const collectErrors = (s) => {
    const errs = {}
    if (s === 0) {
      const need = {
        full_name: 'Enter your full name.', email: 'Enter your email address.',
        company_name: 'Enter your company name.', company_address: 'Enter your company address.',
        phone_number: 'Enter your phone number.', tin: 'Enter your TIN.',
        representative_name: 'Enter the representative’s name.',
      }
      Object.entries(need).forEach(([k, msg]) => { if (!form[k].trim()) errs[k] = msg })
      if (!errs.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = 'Enter a valid email address, e.g. you@company.com.'
      if (!errs.phone_number && !/^\d+$/.test(form.phone_number)) errs.phone_number = 'Use digits only.'
      if (!errs.tin && !/^[\d-]+$/.test(form.tin)) errs.tin = 'Use digits only.'
      if (!passwordValid(form.password)) errs.password = 'Your password doesn’t meet all the requirements below yet.'
      if (!form.confirm_password) errs.confirm_password = 'Type your password again.'
      else if (form.password !== form.confirm_password) errs.confirm_password = 'Passwords do not match.'
      if (businessTypes.length === 0) errs.business_types = 'Select at least one business category.'
    }
    if (s === 1) {
      REQUIRED_KEYS.forEach(k => { if (!files[k]) errs[k] = 'Upload this document.' })
      const mp = pastExpiryProblem("Mayor's Permit", form.mayors_permit_expiry)
      if (mp) errs.mayors_permit_expiry = mp
      const tc = pastExpiryProblem('Tax Clearance Certificate', form.tax_clearance_expiry)
      if (tc) errs.tax_clearance_expiry = tc
      if (catReq.loading) errs._general = 'Still checking which licenses your categories need. Try again in a moment.'
      else if (catReq.error) errs._general = 'Could not load the licenses your categories need. Use "Try again" in the Category-specific licenses section.'
      catReq.docs.forEach(d => {
        const file = catDocs.files[d.key]
        const expiry = catDocs.expiries[d.key]
        if (d.required && !file) errs[`catdoc_${d.key}`] = 'Upload this license.'
        if (file && d.has_expiry) {
          if (!expiry) errs[`catdoc_${d.key}_expiry`] = 'Enter the expiry date.'
          else {
            const past = pastExpiryProblem(d.label, expiry)
            if (past) errs[`catdoc_${d.key}_expiry`] = past
          }
        }
      })
    }
    if (s === 2 && !form.declaration_accepted) {
      errs.declaration_accepted = 'Tick the box to accept the declaration.'
    }
    return errs
  }

  // Once every flagged field is fixed, the summary toast has nothing left to say.
  useEffect(() => { if (Object.keys(fieldErrors).length === 0) setError('') }, [fieldErrors])

  // Scroll to (and focus) the first flagged field after it renders.
  useEffect(() => {
    if (Object.keys(fieldErrors).length === 0) return
    const el = document.querySelector('.sr-main .has-error')
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const target = el.querySelector('[aria-invalid="true"]')
      || el.querySelector('input:not([type=file]), textarea, button')
    target?.focus({ preventScroll: true })
  }, [fieldErrors])

  // Move to a step: top of the page, focus on its heading for screen readers.
  // `scroll` is false when errors follow: then the error effect does the scrolling.
  const goTo = (s, scroll = true) => {
    setStep(s)
    setError('')
    if (scroll) requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' })
      headingRef.current?.focus({ preventScroll: true })
    })
  }

  const flag = (errs) => {
    setFieldErrors(errs)
    const keys = Object.keys(errs)
    const fieldCount = keys.filter(k => k !== '_general').length
    showError(
      errs._general && fieldCount === 0 ? errs._general
        : fieldCount === 1 ? errs[keys.find(k => k !== '_general')]
        : `Please fix the ${fieldCount} highlighted fields.`
    )
  }

  const next = () => {
    const errs = collectErrors(step)
    if (Object.keys(errs).length) { flag(errs); return }
    setFieldErrors({})
    goTo(Math.min(step + 1, STEPS.length - 1))
  }
  const back = () => {
    setFieldErrors({})
    goTo(Math.max(step - 1, 0))
  }
  // Only earlier steps can be revisited directly; moving forward always validates.
  const edit = (s) => { if (s < step && !loading) { setFieldErrors({}); goTo(s) } }

  const submit = async () => {
    if (submittingRef.current) return // no double submissions
    // Re-check every step in case something changed since it was passed.
    for (let s = 0; s < STEPS.length - 1; s++) {
      const errs = collectErrors(s)
      if (Object.keys(errs).length) { goTo(s, false); flag(errs); return }
    }
    submittingRef.current = true
    setError(''); setSubmitError(''); setLoading(true)
    try {
      const fd = new FormData()
      Object.entries(form).forEach(([k, v]) => {
        if (v !== '' && v !== false) fd.append(k, v)
      })
      fd.append('declaration_accepted', form.declaration_accepted)
      fd.append('business_types', JSON.stringify(businessTypes))
      Object.entries(files).forEach(([k, file]) => fd.append(k, file))
      appendCategoryDocs(fd, catReq.docs, catDocs.files, catDocs.expiries)
      await apiRegisterSupplier(fd)
      setDone(true)
      window.scrollTo({ top: 0 })
    } catch (err) {
      // Put each server message beside its field and open the first step with one.
      const mapped = {}
      let firstStep = null
      Object.entries(err.fields || {}).forEach(([k, v]) => {
        const s = stepOfField(k)
        if (s === null) return
        mapped[k] = Array.isArray(v) ? v.join(' ') : String(v)
        firstStep = firstStep === null ? s : Math.min(firstStep, s)
      })
      if (firstStep !== null) {
        goTo(firstStep, false)
        flag(mapped)
      } else {
        const fields = err.fields || {}
        const general = fields.detail || fields.non_field_errors
        const msg = general ? (Array.isArray(general) ? general.join(' ') : String(general)) : err.message
        setSubmitError(msg)
        showError(msg)
      }
    } finally {
      submittingRef.current = false
      setLoading(false)
    }
  }

  if (done) return <SuccessScreen onContinue={() => navigate('/login')} />

  const current = STEPS[step]
  const isLast = step === STEPS.length - 1

  return (
    <div className="sr-page">
      {/* Branding panel (compact top bar on small screens) */}
      <aside className="sr-aside">
        <div className="sr-aside-top">
          <Link to="/login" className="sr-back"><ArrowLeft size={16} aria-hidden="true" /> Back to Login</Link>
          <div className="sr-logo">
            <span className="sr-logo-icon"><Shield size={18} aria-hidden="true" /></span>
            <span>E-Procurement</span>
          </div>
        </div>
        <div className="sr-aside-mid">
          <h1>Join as a<br />Supplier</h1>
          <p>Register your company and start bidding on procurement projects with full transparency.</p>
          <ul className="sr-perks">
            <li><Check size={15} aria-hidden="true" /> Fair evaluation process</li>
            <li><Check size={15} aria-hidden="true" /> Blockchain-verified results</li>
            <li><Check size={15} aria-hidden="true" /> Secure bid submission</li>
          </ul>
        </div>
        <div className="sr-aside-foot">Your data is encrypted and only used for admin verification.</div>
      </aside>

      <main className="sr-main">
        <div className="sr-main-inner">
          <header className="sr-header">
            <p className="sr-eyebrow">Supplier Registration</p>
            <h2 ref={headingRef} tabIndex={-1}>{current.title}</h2>
            <p className="sr-sub">{current.desc}</p>
          </header>

          <Stepper step={step} onSelect={edit} disabled={loading} />

          <div className="sr-step-body">
            {step === 0 && <StepBasic form={form} set={set} businessTypes={businessTypes}
              toggleType={toggleType} showPass={showPass} setShowPass={setShowPass}
              showConfirm={showConfirm} setShowConfirm={setShowConfirm} errors={fieldErrors}
              catReq={catReq} />}
            {step === 1 && <StepDocuments form={form} set={set} files={files}
              onFile={onFile} removeFile={removeFile} businessTypes={businessTypes}
              catReq={catReq} catDocs={catDocs} onCatFile={onCatFile} onCatRemove={onCatRemove}
              onCatExpiry={onCatExpiry} errors={fieldErrors} />}
            {step === 2 && <StepDeclaration form={form} set={set} errors={fieldErrors} />}
            {step === 3 && <StepReview form={form} businessTypes={businessTypes} files={files}
              catReq={catReq} catDocs={catDocs} onEdit={edit} submitError={submitError} />}
          </div>

          {/* Step actions — sticks to the bottom while the step is taller than the screen */}
          <div className="sr-actions">
            {step > 0
              ? <button type="button" className="sr-btn-ghost" onClick={back} disabled={loading}>
                  <ArrowLeft size={15} aria-hidden="true" /> Back
                </button>
              : <span />}
            <span className="sr-actions-count">Step {step + 1} of {STEPS.length}</span>
            {!isLast
              ? <button type="button" className="sr-btn" onClick={next}>
                  Continue <ArrowRight size={15} aria-hidden="true" />
                </button>
              : <button type="button" className="sr-btn" onClick={submit} disabled={loading} aria-busy={loading}>
                  {loading
                    ? <><Loader2 size={15} className="ui-spin" aria-hidden="true" /> Submitting…</>
                    : <>Submit Registration <Check size={15} aria-hidden="true" /></>}
                </button>}
          </div>

          <p className="sr-switch">Already have an account? <Link to="/login">Sign in</Link></p>
        </div>
      </main>

      {error && (
        <div className="sr-toast" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button>
        </div>
      )}
    </div>
  )
}

// ── Stepper ───────────────────────────────────────────────────────────────────
function Stepper({ step, onSelect, disabled }) {
  return (
    <nav className="sr-stepper" aria-label="Registration progress">
      <ol>
        {STEPS.map((s, i) => {
          const state = i < step ? 'done' : i === step ? 'current' : 'upcoming'
          const inner = (
            <>
              <span className="sr-step-dot" aria-hidden="true">{i < step ? <Check size={15} /> : i + 1}</span>
              <span className="sr-step-label">
                {s.label}
                <span className="sr-visually-hidden">
                  {state === 'done' ? ' (completed)' : state === 'current' ? ' (current step)' : ''}
                </span>
              </span>
            </>
          )
          return (
            <li key={s.label} className={`sr-step is-${state}`} aria-current={i === step ? 'step' : undefined}>
              {i < step
                ? <button type="button" onClick={() => onSelect(i)} disabled={disabled}>{inner}</button>
                : <div>{inner}</div>}
            </li>
          )
        })}
      </ol>
      {/* Compact version for narrow screens */}
      <div className="sr-stepper-compact" aria-hidden="true">
        <div className="sr-stepper-compact-text">
          <span>Step {step + 1} of {STEPS.length}</span>
          <strong>{STEPS[step].label}</strong>
        </div>
        <div className="sr-stepper-bar"><span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
      </div>
    </nav>
  )
}

// ── Step 1: Basic Info ────────────────────────────────────────────────────────
function StepBasic({ form, set, businessTypes, toggleType, showPass, setShowPass, showConfirm, setShowConfirm, errors = {}, catReq }) {
  const text = (name, label, extra = {}) => {
    const { hint, transform, ...rest } = extra
    return (
      <Field id={`sr-${name}`} label={label} required hint={hint} error={errors[name]}>
        <input {...describe(`sr-${name}`, errors[name], hint)} aria-required="true"
          value={form[name]}
          onChange={e => set(name, transform ? transform(e.target.value) : e.target.value)} {...rest} />
      </Field>
    )
  }
  const password = (name, label, shown, setShown) => (
    <Field id={`sr-${name}`} label={label} required error={errors[name]}>
      <div className="sr-pass">
        <input {...describe(`sr-${name}`, errors[name])} aria-required="true"
          type={shown ? 'text' : 'password'} autoComplete="new-password" value={form[name]}
          onChange={e => set(name, e.target.value)} placeholder="••••••••" />
        <button type="button" onClick={() => setShown(!shown)}
          aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown}>
          {shown ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </Field>
  )

  // Categories that will ask for extra licenses on the next step.
  const licenseCats = [...new Set(catReq.docs.map(d => d.category))]
  const requiredLicenses = catReq.docs.filter(d => d.required).length

  return (
    <>
      <Section title="Account" desc="You’ll sign in with this email and password.">
        <div className="sr-row">
          {text('full_name', 'Full Name', { autoComplete: 'name', placeholder: 'Juan Dela Cruz' })}
          {text('email', 'Email Address', { type: 'email', autoComplete: 'email', inputMode: 'email', placeholder: 'you@company.com' })}
        </div>
        <div className="sr-row">
          {password('password', 'Password', showPass, setShowPass)}
          {password('confirm_password', 'Confirm Password', showConfirm, setShowConfirm)}
        </div>
        {form.password && <PasswordMeter pw={form.password} />}
        {form.confirm_password && (
          <div className={`sr-match ${form.password === form.confirm_password ? 'ok' : 'bad'}`} aria-live="polite">
            {form.password === form.confirm_password
              ? <><Check size={13} aria-hidden="true" /> Passwords match</>
              : <><X size={13} aria-hidden="true" /> Passwords do not match</>}
          </div>
        )}
      </Section>

      <Section title="Company details" desc="As shown on your SEC or DTI registration.">
        {text('company_name', 'Company Name', { autoComplete: 'organization', placeholder: 'Acme Trading Corp.' })}
        {text('company_address', 'Company Address', { autoComplete: 'street-address', placeholder: '123 Rizal St, Manila' })}
        <div className="sr-row">
          {text('tin', 'TIN', { hint: 'Digits and dashes only.', inputMode: 'numeric', placeholder: '123-456-789', transform: v => v.replace(/[^\d-]/g, '') })}
          {text('phone_number', 'Phone Number', { hint: 'Digits only.', type: 'tel', inputMode: 'numeric', autoComplete: 'tel', placeholder: '09171234567', transform: v => v.replace(/[^\d]/g, '') })}
        </div>
        {text('representative_name', 'Authorized Representative', { hint: 'The person authorized to transact for the company.', placeholder: 'Full name of representative' })}
      </Section>

      <Section title="Business categories"
        desc="Select every category your company supplies. You can only bid on projects in these categories."
        status={<span className={`sr-pill${businessTypes.length ? ' is-ok' : ''}`}>{businessTypes.length} selected</span>}>
        <fieldset className={`sr-fieldset${errors.business_types ? ' has-error' : ''}`}
          aria-describedby={errors.business_types ? 'sr-business_types-err' : undefined}>
          <legend className="sr-visually-hidden">Business categories (required)</legend>
          <div className="sr-checks">
            {BUSINESS_TYPES.map(t => (
              <label key={t} className={businessTypes.includes(t) ? 'on' : ''}>
                <input type="checkbox" checked={businessTypes.includes(t)} onChange={() => toggleType(t)}
                  aria-invalid={errors.business_types ? true : undefined} />
                <span>{t}</span>
              </label>
            ))}
          </div>
          {errors.business_types && <ErrorText id="sr-business_types-err">{errors.business_types}</ErrorText>}
        </fieldset>
        {businessTypes.length > 0 && !catReq.loading && !catReq.error && (
          <p className="sr-inline-note" aria-live="polite">
            <Info size={15} aria-hidden="true" />
            {licenseCats.length === 0
              ? <span>Your selected categories need no licenses beyond the standard documents.</span>
              : <span>
                  The next step will also ask for licenses for <b>{licenseCats.join(', ')}</b>
                  {requiredLicenses > 0 ? ` (${requiredLicenses} required)` : ' (all optional)'}.
                </span>}
          </p>
        )}
      </Section>
    </>
  )
}

// ── Step 2: Documents ─────────────────────────────────────────────────────────
function StepDocuments({ form, set, files, onFile, removeFile, businessTypes, catReq, catDocs, onCatFile, onCatRemove, onCatExpiry, errors = {} }) {
  const reqCatDocs = catReq.docs.filter(d => d.required)
  const requiredTotal = REQUIRED_KEYS.length + reqCatDocs.length
  const requiredDone = REQUIRED_KEYS.filter(k => files[k]).length + reqCatDocs.filter(d => catDocs.files[d.key]).length

  const baseCard = (d) => (
    <DocCard key={d.key} id={`sr-doc-${d.key}`} label={d.label} required={d.required} help={d.help}
      file={files[d.key]} error={errors[d.key]}
      onFile={f => onFile(d.key, f)} onRemove={() => removeFile(d.key)}>
      {d.expiry && (
        <SubField id={`sr-${d.expiry}`} label="Expiry date" note="Optional" error={errors[d.expiry]}>
          <input type="date" min={todayIso()} value={form[d.expiry]}
            {...describe(`sr-${d.expiry}`, errors[d.expiry])}
            onChange={e => set(d.expiry, e.target.value)} />
        </SubField>
      )}
      {d.extra === 'financial_statement_year' && (
        <SubField id="sr-financial_statement_year" label="Statement year" note="Optional">
          <input id="sr-financial_statement_year" inputMode="numeric" placeholder="e.g. 2025"
            value={form.financial_statement_year}
            onChange={e => set('financial_statement_year', e.target.value.replace(/[^\d]/g, '').slice(0, 4))} />
        </SubField>
      )}
    </DocCard>
  )

  // Category licenses, grouped by category (the server lists each license once).
  const groups = catReq.docs.reduce((acc, d) => { (acc[d.category] ||= []).push(d); return acc }, {})
  const noExtra = businessTypes.filter(c => !groups[c])

  return (
    <>
      <div className={`sr-progress-note${requiredDone === requiredTotal && !catReq.loading ? ' is-ok' : ''}`}>
        <div>
          <strong>{requiredDone} of {catReq.loading ? '…' : requiredTotal}</strong> required documents selected
        </div>
        <span>{FILE_HINT} each. Files stay on this device until you submit.</span>
      </div>

      {DOC_GROUPS.map(g => {
        const done = g.docs.filter(d => files[d.key]).length
        const desc = g.id === 'auth'
          ? 'Authorizes your representative to transact on behalf of the company.'
          : g.id === 'legal' ? 'Proof that your company is registered and permitted to operate.'
          : 'Used to verify your financial capacity.'
        return (
          <Section key={g.id} title={g.title} desc={desc}
            status={<CountPill done={done} total={g.docs.length} />}>
            <div className="sr-doc-grid">{g.docs.map(baseCard)}</div>
          </Section>
        )
      })}

      <Section title="Category-specific licenses"
        desc="Extra licenses for the business categories you selected. Only the ones marked Required are needed to register."
        status={!catReq.loading && !catReq.error && reqCatDocs.length > 0
          ? <CountPill done={reqCatDocs.filter(d => catDocs.files[d.key]).length} total={reqCatDocs.length} />
          : null}>
        {catReq.loading && (
          <p className="sr-inline-note"><Loader2 size={15} className="ui-spin" aria-hidden="true" /> Checking which licenses your categories need…</p>
        )}
        {catReq.error && (
          <div className="sr-alert" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{catReq.error}</span>
            <button type="button" className="sr-btn-ghost sm" onClick={catReq.reload}>
              <RefreshCw size={14} aria-hidden="true" /> Try again
            </button>
          </div>
        )}
        {!catReq.loading && !catReq.error && Object.entries(groups).map(([category, docs]) => (
          <div key={category} className="sr-catgroup">
            <div className="sr-catgroup-head">
              <h4>{category}</h4>
              <span>
                {docs.filter(d => d.required).length} required · {docs.filter(d => !d.required).length} optional
              </span>
            </div>
            <div className="sr-doc-grid">
              {docs.map(d => {
                const fileErr = errors[`catdoc_${d.key}`]
                const expErr = errors[`catdoc_${d.key}_expiry`]
                const expId = `sr-catdoc-${d.key}-expiry`
                return (
                  <DocCard key={d.key} id={`sr-catdoc-${d.key}`} label={d.label} required={d.required}
                    help={d.help_text} file={catDocs.files[d.key]} error={fileErr} hasError={!!expErr}
                    onFile={f => onCatFile(d.key, f)} onRemove={() => onCatRemove(d.key)}>
                    {d.has_expiry && (
                      <SubField id={expId} label="Expiry date"
                        note={d.required ? 'Required' : 'Required if uploaded'} noteRequired={d.required || !!catDocs.files[d.key]}
                        error={expErr}>
                        <input type="date" min={todayIso()} value={catDocs.expiries[d.key] || ''}
                          {...describe(expId, expErr)}
                          onChange={e => onCatExpiry(d.key, e.target.value)} />
                      </SubField>
                    )}
                  </DocCard>
                )
              })}
            </div>
          </div>
        ))}
        {!catReq.loading && !catReq.error && noExtra.length > 0 && (
          <p className="sr-inline-note">
            <Info size={15} aria-hidden="true" />
            <span>No extra licenses needed for {noExtra.join(', ')}.</span>
          </p>
        )}
      </Section>

      <Section title="Qualifications and track record" optional
        desc="Optional. Helps the evaluation committee understand your experience."
        status={<span className="sr-pill">{OPTIONAL_DOCS.filter(d => files[d.key]).length} added</span>}>
        <div className="sr-doc-grid">{OPTIONAL_DOCS.map(baseCard)}</div>
        <Field id="sr-track_record_description" label="Track record description" optional>
          <textarea id="sr-track_record_description" rows={3} value={form.track_record_description}
            onChange={e => set('track_record_description', e.target.value)}
            placeholder="Briefly describe similar projects you have delivered" />
        </Field>
      </Section>
    </>
  )
}

// ── Step 3: Declaration ───────────────────────────────────────────────────────
function StepDeclaration({ form, set, errors = {} }) {
  const err = errors.declaration_accepted
  return (
    <Section title="Supplier declaration" desc="By registering, you make the following statements.">
      <ol className="sr-decl-list">
        <li>I hereby certify that all information provided in this registration and all uploaded documents are true, accurate, and authentic to the best of my knowledge.</li>
        <li>I understand that any false statement or falsified document is grounds for disqualification and possible legal action, and that my company will be subject to admin verification before being allowed to submit bids.</li>
        <li>I consent to the processing of the submitted business information solely for the purpose of supplier verification and procurement.</li>
      </ol>
      <div className={`sr-agree${err ? ' has-error' : ''}${form.declaration_accepted ? ' is-on' : ''}`}>
        <input id="sr-declaration" type="checkbox" checked={form.declaration_accepted}
          aria-invalid={err ? true : undefined} aria-describedby={err ? 'sr-declaration-err' : undefined}
          onChange={e => set('declaration_accepted', e.target.checked)} />
        <label htmlFor="sr-declaration">
          I have read and agree to the declaration above, the{' '}
          <Link to="/terms" target="_blank" rel="noopener noreferrer">Terms of Service</Link>, and the{' '}
          <Link to="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</Link>.
          <span className="sr-req" aria-hidden="true">*</span>
        </label>
      </div>
      {err && <ErrorText id="sr-declaration-err">{err}</ErrorText>}
    </Section>
  )
}

// ── Step 4: Review ────────────────────────────────────────────────────────────
function StepReview({ form, businessTypes, files, catReq, catDocs, onEdit, submitError }) {
  const rows = [
    ...LEGAL_DOCS, ...FINANCIAL_DOCS, ...AUTH_DOCS,
  ].map(d => ({ key: d.key, label: d.label, required: true, file: files[d.key], expiry: d.expiry ? form[d.expiry] : '' }))
  const catRows = catReq.docs.map(d => ({
    key: d.key, label: d.label, required: d.required, category: d.category,
    file: catDocs.files[d.key], expiry: d.has_expiry ? catDocs.expiries[d.key] : '', needsExpiry: d.has_expiry,
  }))
  const optRows = OPTIONAL_DOCS.map(d => ({ key: d.key, label: d.label, required: false, file: files[d.key] }))
  const missing = [...rows, ...catRows].filter(r => r.required && !r.file).length
    + catRows.filter(r => r.file && r.needsExpiry && !r.expiry).length
  const ready = missing === 0 && form.declaration_accepted && !catReq.loading && !catReq.error

  const company = [
    ['Full name', form.full_name], ['Email', form.email],
    ['Company', form.company_name], ['Address', form.company_address],
    ['TIN', form.tin], ['Phone', form.phone_number],
    ['Authorized representative', form.representative_name],
  ]

  return (
    <>
      {submitError && (
        <div className="sr-alert" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span><b>Registration was not submitted.</b> {submitError}</span>
        </div>
      )}
      <div className={`sr-progress-note${ready ? ' is-ok' : ' is-warn'}`}>
        <div>
          {ready
            ? <><CheckCircle2 size={16} aria-hidden="true" /> <strong>Ready to submit.</strong></>
            : <><AlertCircle size={16} aria-hidden="true" /> <strong>{missing > 0 ? `${missing} required item${missing === 1 ? '' : 's'} missing.` : 'Some steps are incomplete.'}</strong></>}
        </div>
        <span>After you submit, your account stays pending until an admin verifies your documents.</span>
      </div>

      <Section title="Account and company" action={<EditBtn onClick={() => onEdit(0)} label="account and company details" />}>
        <dl className="sr-summary">
          {company.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{v || <span className="sr-muted">Not provided</span>}</dd></div>
          ))}
        </dl>
      </Section>

      <Section title="Business categories" action={<EditBtn onClick={() => onEdit(0)} label="business categories" />}>
        <div className="sr-chips">
          {businessTypes.map(t => <span key={t} className="sr-chip">{t}</span>)}
        </div>
      </Section>

      <Section title="Documents" action={<EditBtn onClick={() => onEdit(1)} label="documents" />}>
        <ReviewDocList title="Required documents" rows={rows} />
        {catRows.length > 0 && <ReviewDocList title="Category-specific licenses" rows={catRows} />}
        <ReviewDocList title="Optional qualifications" rows={optRows} />
        {(form.financial_statement_year || form.track_record_description) && (
          <dl className="sr-summary sr-summary-tight">
            {form.financial_statement_year && <div><dt>Financial statement year</dt><dd>{form.financial_statement_year}</dd></div>}
            {form.track_record_description && <div className="wide"><dt>Track record</dt><dd className="sr-prewrap">{form.track_record_description}</dd></div>}
          </dl>
        )}
      </Section>

      <Section title="Declaration" action={<EditBtn onClick={() => onEdit(2)} label="declaration" />}>
        {form.declaration_accepted
          ? <p className="sr-status-line ok"><CheckCircle2 size={16} aria-hidden="true" /> Declaration, Terms of Service and Privacy Policy accepted.</p>
          : <p className="sr-status-line bad"><AlertCircle size={16} aria-hidden="true" /> Declaration not yet accepted.</p>}
      </Section>
    </>
  )
}

function ReviewDocList({ title, rows }) {
  const today = todayIso()
  return (
    <div className="sr-review-group">
      <h4>{title}</h4>
      <ul className="sr-doclist">
        {rows.map(r => {
          const expired = r.expiry && r.expiry < today
          const noDate = r.file && r.needsExpiry && !r.expiry
          const state = !r.file ? (r.required ? 'missing' : 'none')
            : expired || noDate ? 'invalid' : 'ok'
          return (
            <li key={r.key} className={`is-${state}`}>
              <span className="sr-doclist-icon" aria-hidden="true">
                {state === 'ok' ? <CheckCircle2 size={16} /> : state === 'none' ? <FileText size={16} /> : <AlertCircle size={16} />}
              </span>
              <div className="sr-doclist-main">
                <span className="sr-doclist-name">
                  {r.label}{r.category && <span className="sr-doclist-cat"> · {r.category}</span>}
                </span>
                <span className="sr-doclist-sub">
                  {r.file ? <span className="sr-doclist-file" title={r.file.name}>{r.file.name}</span>
                    : r.required ? 'Missing — required' : 'Not provided (optional)'}
                  {r.expiry && <span className={expired ? 'sr-bad' : ''}> · {expired ? 'Expired' : 'Expires'} {fmtDate(r.expiry)}</span>}
                  {noDate && <span className="sr-bad"> · Expiry date missing</span>}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function EditBtn({ onClick, label }) {
  return (
    <button type="button" className="sr-edit" onClick={onClick} aria-label={`Edit ${label}`}>
      <Pencil size={13} aria-hidden="true" /> Edit
    </button>
  )
}

function SuccessScreen({ onContinue }) {
  return (
    <div className="sr-success">
      <div className="sr-success-card" role="status">
        <span className="sr-success-icon"><CheckCircle2 size={40} aria-hidden="true" /></span>
        <h2>Registration Submitted</h2>
        <p>Your supplier account has been created and is now <b>pending admin verification</b>. You'll be able to bid once an admin approves your documents.</p>
        <button type="button" className="sr-btn" onClick={onContinue}>Go to Login</button>
      </div>
    </div>
  )
}

// ── Live password strength meter + requirement checklist ──────────────────────
function PasswordMeter({ pw }) {
  const checks = PASSWORD_RULES.map(r => ({ label: r.label, met: r.test(pw) }))
  const met = checks.filter(c => c.met).length
  const level = met <= 2 ? 'weak' : met <= 4 ? 'medium' : 'strong'
  const levelLabel = met <= 2 ? 'Weak' : met <= 4 ? 'Medium' : 'Strong'
  return (
    <div className="sr-pwmeter">
      <div className="sr-pwbar">
        <div className={`sr-pwbar-fill ${level}`} style={{ width: `${(met / checks.length) * 100}%` }} />
      </div>
      <div className="sr-pwmeter-label">
        Password strength: <span className={level}>{levelLabel}</span>
      </div>
      <ul className="sr-pwchecks">
        {checks.map(c => (
          <li key={c.label} className={c.met ? 'met' : ''}>
            {c.met ? <Check size={13} aria-hidden="true" /> : <span className="sr-pwdot" aria-hidden="true" />}
            {c.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Small building blocks ─────────────────────────────────────────────────────
function Section({ title, desc, status, action, optional, children }) {
  return (
    <section className="sr-panel">
      <header className="sr-panel-head">
        <div className="sr-panel-titles">
          <h3>{title}{optional && <span className="sr-pill">Optional</span>}</h3>
          {desc && <p>{desc}</p>}
        </div>
        {(status || action) && <div className="sr-panel-aside">{status}{action}</div>}
      </header>
      <div className="sr-panel-body">{children}</div>
    </section>
  )
}

function CountPill({ done, total }) {
  return <span className={`sr-pill${done === total ? ' is-ok' : ''}`}>{done} of {total} selected</span>
}

function ErrorText({ id, children }) {
  return <p id={id} className="sr-error-text"><AlertCircle size={13} aria-hidden="true" /> {children}</p>
}

// `error` outlines the field in red and replaces the hint with what to fix.
function Field({ id, label, required, optional, hint, error, children }) {
  return (
    <div className={`sr-field${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>
        {label}
        {required && <span className="sr-req" aria-hidden="true">*</span>}
        {optional && <span className="sr-optional">Optional</span>}
      </label>
      {children}
      {error
        ? <ErrorText id={`${id}-err`}>{error}</ErrorText>
        : hint && <p id={`${id}-hint`} className="sr-hint">{hint}</p>}
    </div>
  )
}

// A small labelled input inside a document card (expiry date, statement year).
function SubField({ id, label, note, noteRequired, error, children }) {
  return (
    <div className={`sr-subfield${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>
        {label}
        {note && <span className={noteRequired ? 'sr-subfield-note is-req' : 'sr-subfield-note'}>{note}</span>}
      </label>
      {children}
      {error && <ErrorText id={`${id}-err`}>{error}</ErrorText>}
    </div>
  )
}

// One upload card: name + Required/Optional, a drop zone (or the chosen file
// with Replace / Remove), then any related fields such as the expiry date.
// The file is only held in the browser here; it's uploaded on Submit.
function DocCard({ id, label, required, help, file, error, hasError, onFile, onRemove, children }) {
  const inputRef = useRef(null)
  const [drag, setDrag] = useState(false)
  const pick = () => inputRef.current?.click()
  const dropProps = {
    onDragOver: e => { e.preventDefault(); setDrag(true) },
    onDragLeave: () => setDrag(false),
    onDrop: e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f) },
  }
  const helpId = help ? `${id}-help` : undefined
  const errId = error ? `${id}-err` : undefined
  return (
    <div className={`sr-doc${file ? ' is-filled' : ''}${error || hasError ? ' has-error' : ''}${drag ? ' is-drag' : ''}`} {...dropProps}>
      <div className="sr-doc-head">
        <label htmlFor={id} className="sr-doc-name">{label}</label>
        <span className={`sr-tag ${required ? 'is-req' : 'is-opt'}`}>{required ? 'Required' : 'Optional'}</span>
      </div>
      {help && <p id={helpId} className="sr-doc-help">{help}</p>}

      {file ? (
        <div className={`sr-file${error ? ' is-invalid' : ''}`}>
          <span className="sr-file-icon" aria-hidden="true"><FileText size={16} /></span>
          <div className="sr-file-meta">
            <span className="sr-file-name" title={file.name}>{file.name}</span>
            <span className="sr-file-sub">{fmtSize(file.size)} · Not uploaded yet, sent on submit</span>
          </div>
          <div className="sr-file-actions">
            <button type="button" className="sr-file-btn" onClick={pick} aria-label={`Replace ${label}`}>Replace</button>
            <button type="button" className="sr-file-btn is-icon" onClick={onRemove} aria-label={`Remove ${label}`}>
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="sr-drop" onClick={pick}
          aria-label={`Upload ${label}`} aria-invalid={error ? true : undefined}
          aria-describedby={[errId, helpId].filter(Boolean).join(' ') || undefined}>
          <span className="sr-drop-icon" aria-hidden="true"><CloudUpload size={18} /></span>
          <span className="sr-drop-text">
            <span><strong>Choose file</strong> or drag it here</span>
            <span className="sr-drop-meta">{FILE_HINT}</span>
          </span>
        </button>
      )}
      <input ref={inputRef} id={id} type="file" accept=".pdf,.jpg,.jpeg,.png" hidden
        onChange={e => {
          const f = e.target.files?.[0]
          e.target.value = '' // lets the same file be chosen again after removing it
          if (f) onFile(f)
        }} />
      {error && <ErrorText id={errId}>{error}</ErrorText>}
      {Children.toArray(children).length > 0 && <div className="sr-doc-extra">{children}</div>}
    </div>
  )
}
