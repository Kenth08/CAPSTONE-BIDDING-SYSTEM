import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2,
  Shield, Eye, EyeOff, ArrowLeft, Check, Upload, FileText, X,
  CheckCircle2, AlertCircle,
} from 'lucide-react'
import { apiRegisterSupplier } from '../api'
import { CATEGORIES } from '../constants/categories'
import CategoryDocumentFields, {
  appendCategoryDocs, categoryDocsProblem, pastExpiryProblem, todayIso,
  useCategoryDocState, useCategoryRequirements,
} from '../components/CategoryDocuments'
import '../style/SupplierRegister.css'

// ── Static config ─────────────────────────────────────────────────────────────
const STEPS = ['Basic Info', 'Documents', 'Declaration', 'Submit']

// Shared with the procurement category list so eligibility matching lines up.
const BUSINESS_TYPES = CATEGORIES

// key = backend field name, required = must upload to register
const LEGAL_DOCS = [
  { key: 'sec_dti_certificate', label: 'SEC or DTI Certificate', required: true },
  { key: 'mayors_permit', label: "Mayor's Permit / Business Permit", required: true },
  { key: 'philgeps_certificate', label: 'PhilGEPS Registration Certificate', required: true },
  { key: 'valid_id', label: 'Valid ID (Government-issued)', required: true },
]
const FINANCIAL_DOCS = [
  { key: 'tax_clearance_certificate', label: 'Tax Clearance Certificate', required: true },
  { key: 'audited_financial_statements', label: 'Audited Financial Statements', required: true },
  { key: 'bank_reference_letter', label: 'Bank Reference Letter', required: true },
]
const OPTIONAL_DOCS = [
  { key: 'performance_certificates', label: 'Performance Certificates / ISO', required: false },
  { key: 'past_contracts', label: 'Past Contracts / Purchase Orders', required: false },
]
const AUTH_DOCS = [
  { key: 'authorization_letter', label: 'Authorization Letter / SPA', required: true },
]
const REQUIRED_KEYS = [...LEGAL_DOCS, ...FINANCIAL_DOCS, ...AUTH_DOCS].map(d => d.key)
const OPTIONAL_KEYS = OPTIONAL_DOCS.map(d => d.key)

const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png']
const MAX_MB = 5

// ── Validation helpers ────────────────────────────────────────────────────────
const PASSWORD_RULES = [
  { label: 'At least 8 characters', test: p => p.length >= 8 },
  { label: 'One uppercase letter', test: p => /[A-Z]/.test(p) },
  { label: 'One lowercase letter', test: p => /[a-z]/.test(p) },
  { label: 'One number', test: p => /[0-9]/.test(p) },
  { label: 'One symbol', test: p => /[^A-Za-z0-9]/.test(p) },
]
const passwordValid = (pw) => PASSWORD_RULES.every(r => r.test(pw))

function validateFile(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (!ALLOWED_EXT.includes(ext)) return `Unsupported type ".${ext}". Use PDF, JPG, or PNG.`
  if (file.size > MAX_MB * 1024 * 1024) return `File is too large (max ${MAX_MB} MB).`
  return null
}

export default function SupplierRegister() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [showPass, setShowPass] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState('')
  const [errNonce, setErrNonce] = useState(0) // re-triggers the toast even on a repeat message
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  // Show errors as a floating toast so they're visible regardless of scroll position.
  const showError = (msg) => { setError(msg); setErrNonce(n => n + 1) }
  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(''), 5000)
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
  const [files, setFiles] = useState({}) // { key: File }
  // Extra licenses the chosen categories require (rules come from the server).
  const catReq = useCategoryRequirements(businessTypes)
  const catDocs = useCategoryDocState()

  // Per-field problems from the last Continue: { fieldKey: message }. Each
  // flagged field is outlined in red with its message, and a field's error
  // clears as soon as the user changes it.
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

  const onFile = (key, file) => {
    if (!file) return
    const msg = validateFile(file)
    if (msg) { setFieldErrors(e => ({ ...e, [key]: msg })); showError(msg); return }
    setError('')
    clearErr(key)
    setFiles(f => ({ ...f, [key]: file }))
  }
  const removeFile = (key) => setFiles(f => { const n = { ...f }; delete n[key]; return n })

  // Category licenses: same red-outline treatment, keyed catdoc_<key>.
  const catDocsUi = {
    ...catDocs,
    setFile: (k, f) => { catDocs.setFile(k, f); clearErr(`catdoc_${k}`) },
    setExpiry: (k, v) => { catDocs.setExpiry(k, v); clearErr(`catdoc_${k}_expiry`) },
  }

  const requiredUploaded = REQUIRED_KEYS.filter(k => files[k]).length
  const optionalUploaded = OPTIONAL_KEYS.filter(k => files[k]).length

  // ── Per-step gate ───────────────────────────────────────────────────────────
  // Collects EVERY problem on the current step (not just the first), so the
  // user sees all the fields to fix at once. `_general` holds problems that
  // aren't tied to one field.
  const collectErrors = () => {
    const errs = {}
    if (step === 0) {
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
      if (businessTypes.length === 0) errs.business_types = 'Select at least one business type.'
    }
    if (step === 1) {
      REQUIRED_KEYS.forEach(k => { if (!files[k]) errs[k] = 'Upload this document.' })
      const mp = pastExpiryProblem("Mayor's Permit", form.mayors_permit_expiry)
      if (mp) errs.mayors_permit_expiry = mp
      const tc = pastExpiryProblem('Tax Clearance Certificate', form.tax_clearance_expiry)
      if (tc) errs.tax_clearance_expiry = tc
      if (catReq.loading) errs._general = 'Still checking which documents your categories need. Try again in a moment.'
      else if (catReq.error) errs._general = 'Could not load the documents your categories need. Use "Try again" in the Category Documents section.'
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
    if (step === 2 && !form.declaration_accepted) {
      errs.declaration_accepted = 'Tick the box to accept the declaration.'
    }
    return errs
  }

  // Scroll to (and focus) the first highlighted field after it renders.
  useEffect(() => {
    if (Object.keys(fieldErrors).length === 0) return
    const el = document.querySelector('.has-error')
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.querySelector('input:not([type=file]), textarea')?.focus({ preventScroll: true })
  }, [fieldErrors])

  const next = () => {
    const errs = collectErrors()
    const keys = Object.keys(errs)
    if (keys.length) {
      setFieldErrors(errs)
      const fieldCount = keys.filter(k => k !== '_general').length
      showError(
        errs._general && fieldCount === 0 ? errs._general
          : fieldCount === 1 ? errs[keys.find(k => k !== '_general')]
          : `Please fix the ${fieldCount} highlighted fields.`
      )
      return
    }
    setFieldErrors({})
    setError('')
    setStep(s => Math.min(s + 1, STEPS.length - 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const back = () => {
    setError('')
    setFieldErrors({})
    setStep(s => Math.max(s - 1, 0))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const submit = async () => {
    setError(''); setLoading(true)
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
    } catch (err) {
      showError(err.message)
      setStep(0) // jump back to the fields so they can be fixed
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } finally {
      setLoading(false)
    }
  }

  if (done) return <SuccessScreen onContinue={() => navigate('/login')} />

  return (
    <div className="sr-page">
      {/* Left info panel */}
      <aside className="sr-aside">
        <div>
          <Link to="/login" className="sr-back"><ArrowLeft size={16} /> Back to Login</Link>
          <div className="sr-logo">
            <span className="sr-logo-icon"><Shield size={18} /></span>
            <span>E-Procurement</span>
          </div>
        </div>
        <div className="sr-aside-mid">
          <h1>Join as a<br />Supplier</h1>
          <p>Register your company and start bidding on procurement projects with full transparency.</p>
          <ul className="sr-perks">
            <li><Check size={15} /> Fair evaluation process</li>
            <li><Check size={15} /> Blockchain-verified results</li>
            <li><Check size={15} /> Secure bid submission</li>
          </ul>
        </div>
        <div className="sr-aside-foot">Your data is encrypted and only used for admin verification.</div>
      </aside>

      {/* Right form panel */}
      <main className="sr-main">
        <div className="sr-main-inner">
          <h2>Supplier Registration</h2>
          <p className="sr-sub">Complete your company profile and upload required documents for admin verification.</p>

          {/* Stepper */}
          <div className="sr-stepper">
            {STEPS.map((label, i) => (
              <div key={label} className="sr-step-wrap">
                <div className={`sr-step ${i < step ? 'done' : ''} ${i === step ? 'active' : ''}`}>
                  {i < step ? <Check size={16} /> : i + 1}
                </div>
                <span className={i === step ? 'active' : ''}>{label}</span>
                {i < STEPS.length - 1 && <div className={`sr-line ${i < step ? 'done' : ''}`} />}
              </div>
            ))}
          </div>

          <div className="sr-card">
            {step === 0 && <StepBasic form={form} set={set} businessTypes={businessTypes}
              toggleType={toggleType} showPass={showPass} setShowPass={setShowPass}
              showConfirm={showConfirm} setShowConfirm={setShowConfirm} errors={fieldErrors} />}
            {step === 1 && <StepDocuments form={form} set={set} files={files}
              onFile={onFile} removeFile={removeFile}
              catReq={catReq} catDocs={catDocsUi} onCatError={showError} errors={fieldErrors} />}
            {step === 2 && <StepDeclaration form={form} set={set} errors={fieldErrors} />}
            {step === 3 && <StepReview required={requiredUploaded} optional={optionalUploaded}
              catReq={catReq} catDocs={catDocs} />}
          </div>

          {/* Nav */}
          <div className="sr-nav">
            {step > 0
              ? <button className="sr-btn-ghost" onClick={back}><ArrowLeft size={15} /> Back</button>
              : <span />}
            {step < STEPS.length - 1
              ? <button className="sr-btn" onClick={next}>Continue</button>
              : <button className="sr-btn" onClick={submit} disabled={loading}>
                  {loading ? <><Loader2 size={15} className="ui-spin" aria-hidden="true" /> Submitting…</> : 'Submit Registration'}
                </button>}
          </div>

          <p className="sr-switch">Already have an account? <Link to="/login">Sign in</Link></p>
        </div>
      </main>

      {/* Floating error toast — visible no matter where the user has scrolled */}
      {error && (
        <div className="sr-toast" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button>
        </div>
      )}
    </div>
  )
}

// ── Step 1: Basic Info ────────────────────────────────────────────────────────
function StepBasic({ form, set, businessTypes, toggleType, showPass, setShowPass, showConfirm, setShowConfirm, errors = {} }) {
  return (
    <>
      <Section title="Account Information" desc="Your login credentials">
        <Field label="Full Name" required error={errors.full_name}>
          <input autoComplete="name" value={form.full_name} onChange={e => set('full_name', e.target.value)} placeholder="Juan Dela Cruz" />
        </Field>
        <Field label="Email Address" required error={errors.email}>
          <input type="email" autoComplete="email" inputMode="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="you@company.com" />
        </Field>
        <div className="sr-row">
          <Field label="Password" required error={errors.password}>
            <div className="sr-pass">
              <input type={showPass ? 'text' : 'password'} autoComplete="new-password" value={form.password}
                onChange={e => set('password', e.target.value)} placeholder="••••••••" />
              <button type="button" onClick={() => setShowPass(!showPass)}
                aria-label={showPass ? 'Hide password' : 'Show password'} aria-pressed={showPass}>
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </Field>
          <Field label="Confirm Password" required error={errors.confirm_password}>
            <div className="sr-pass">
              <input type={showConfirm ? 'text' : 'password'} autoComplete="new-password" value={form.confirm_password}
                onChange={e => set('confirm_password', e.target.value)} placeholder="••••••••" />
              <button type="button" onClick={() => setShowConfirm(!showConfirm)}
                aria-label={showConfirm ? 'Hide password' : 'Show password'} aria-pressed={showConfirm}>
                {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </Field>
        </div>
        {form.password && <PasswordMeter pw={form.password} />}
        {form.confirm_password && (
          <div className={`sr-match ${form.password === form.confirm_password ? 'ok' : 'bad'}`}>
            {form.password === form.confirm_password
              ? <><Check size={13} /> Passwords match</>
              : <><X size={13} /> Passwords do not match</>}
          </div>
        )}
      </Section>

      <Section title="Company Details" desc="Your business information">
        <Field label="Company Name" required error={errors.company_name}>
          <input value={form.company_name} onChange={e => set('company_name', e.target.value)} placeholder="Acme Trading Corp." />
        </Field>
        <Field label="Company Address" required error={errors.company_address}>
          <input value={form.company_address} onChange={e => set('company_address', e.target.value)} placeholder="123 Rizal St, Manila" />
        </Field>
        <div className="sr-row">
          <Field label="Phone Number" required hint="Numbers only." error={errors.phone_number}>
            <input value={form.phone_number} onChange={e => set('phone_number', e.target.value.replace(/[^\d]/g, ''))} placeholder="09171234567" />
          </Field>
          <Field label="TIN" required hint="Numbers only." error={errors.tin}>
            <input value={form.tin} onChange={e => set('tin', e.target.value.replace(/[^\d-]/g, ''))} placeholder="123-456-789" />
          </Field>
        </div>
        <Field label="Representative Name" required error={errors.representative_name}>
          <input value={form.representative_name} onChange={e => set('representative_name', e.target.value)} placeholder="Authorized representative" />
        </Field>
        <Field label="Business Type" required hint="Select all categories that apply to your company." error={errors.business_types}>
          <div className="sr-checks">
            {BUSINESS_TYPES.map(t => (
              <label key={t} className={businessTypes.includes(t) ? 'on' : ''}>
                <input type="checkbox" checked={businessTypes.includes(t)} onChange={() => toggleType(t)} />
                {t}
              </label>
            ))}
          </div>
        </Field>
      </Section>
    </>
  )
}

// ── Step 2: Documents ─────────────────────────────────────────────────────────
function StepDocuments({ form, set, files, onFile, removeFile, catReq, catDocs, onCatError, errors = {} }) {
  return (
    <>
      <Section title="Legal Documents" desc="Required for company registration and compliance.">
        <div className="sr-grid">
          {LEGAL_DOCS.map(d => <Uploader key={d.key} doc={d} file={files[d.key]} onFile={onFile} removeFile={removeFile} error={errors[d.key]} />)}
        </div>
        <Field label="Mayor's Permit Expiry" error={errors.mayors_permit_expiry}>
          <input type="date" min={todayIso()} value={form.mayors_permit_expiry} onChange={e => set('mayors_permit_expiry', e.target.value)} />
        </Field>
      </Section>

      <Section title="Financial Documents" desc="Required to verify financial capacity.">
        <div className="sr-grid">
          {FINANCIAL_DOCS.map(d => <Uploader key={d.key} doc={d} file={files[d.key]} onFile={onFile} removeFile={removeFile} error={errors[d.key]} />)}
        </div>
        <div className="sr-row">
          <Field label="Tax Clearance Expiry" error={errors.tax_clearance_expiry}>
            <input type="date" min={todayIso()} value={form.tax_clearance_expiry} onChange={e => set('tax_clearance_expiry', e.target.value)} />
          </Field>
          <Field label="Financial Statement Year" hint="Year digits only.">
            <input value={form.financial_statement_year}
              onChange={e => set('financial_statement_year', e.target.value.replace(/[^\d]/g, '').slice(0, 4))} placeholder="e.g. 2026" />
          </Field>
        </div>
      </Section>

      <Section title="Representative Authorization" desc="Required authorization document.">
        <div className="sr-grid">
          {AUTH_DOCS.map(d => <Uploader key={d.key} doc={d} file={files[d.key]} onFile={onFile} removeFile={removeFile} error={errors[d.key]} />)}
        </div>
      </Section>

      {(catReq.loading || catReq.error || catReq.docs.length > 0) && (
        <Section title="Category Documents"
          desc="Licenses required by the business categories you selected. Required ones must be uploaded to register.">
          <CategoryDocumentFields req={catReq} state={catDocs} onError={onCatError} idPrefix="sr-catdoc" errors={errors} />
        </Section>
      )}

      <Section title="Qualifications & Track Record" desc="Optional — demonstrate experience.">
        <div className="sr-grid">
          {OPTIONAL_DOCS.map(d => <Uploader key={d.key} doc={d} file={files[d.key]} onFile={onFile} removeFile={removeFile} error={errors[d.key]} />)}
        </div>
        <Field label="Track Record Description">
          <textarea rows={3} value={form.track_record_description}
            onChange={e => set('track_record_description', e.target.value)} placeholder="Brief description of similar projects" />
        </Field>
      </Section>
    </>
  )
}

// ── Step 3: Declaration ───────────────────────────────────────────────────────
function StepDeclaration({ form, set, errors = {} }) {
  return (
    <Section title="Declaration" desc="Read and confirm before submitting.">
      <div className="sr-declaration">
        <p>I hereby certify that all information provided in this registration and all uploaded documents are true, accurate, and authentic to the best of my knowledge.</p>
        <p>I understand that any false statement or falsified document is grounds for disqualification and possible legal action, and that my company will be subject to admin verification before being allowed to submit bids.</p>
        <p>I consent to the processing of the submitted business information solely for the purpose of supplier verification and procurement.</p>
      </div>
      <label className={`sr-agree${errors.declaration_accepted ? ' has-error' : ''}`}>
        <input type="checkbox" checked={form.declaration_accepted}
          onChange={e => set('declaration_accepted', e.target.checked)} />
        I have read and agree to the declaration above, the{' '}
        <Link to="/terms" target="_blank" rel="noopener noreferrer">Terms of Service</Link>, and the{' '}
        <Link to="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</Link>.
      </label>
      {errors.declaration_accepted && <small className="sr-error-text" role="alert">{errors.declaration_accepted}</small>}
    </Section>
  )
}

// ── Step 4: Review ────────────────────────────────────────────────────────────
function StepReview({ required, optional, catReq, catDocs }) {
  const catRequired = catReq.docs.filter(d => d.required)
  const catRequiredDone = catRequired.filter(d => catDocs.files[d.key]).length
  const catUploaded = catReq.docs.filter(d => catDocs.files[d.key])
  return (
    <Section title="Review & Submit" desc="Verify your information before submitting.">
      <div className="sr-review">
        <div className="sr-stat">
          <strong className={required === REQUIRED_KEYS.length ? 'ok' : 'warn'}>{required}/{REQUIRED_KEYS.length}</strong>
          <span>Required docs uploaded</span>
        </div>
        {catRequired.length > 0 && (
          <div className="sr-stat">
            <strong className={catRequiredDone === catRequired.length ? 'ok' : 'warn'}>
              {catRequiredDone}/{catRequired.length}
            </strong>
            <span>Required category docs</span>
          </div>
        )}
        <div className="sr-stat"><strong>{optional}</strong><span>Optional docs uploaded</span></div>
        <div className="sr-stat"><strong className="pending">Pending Review</strong><span>Status after submission</span></div>
      </div>
      {catUploaded.length > 0 && (
        <div className="sr-note">
          <FileText size={16} />
          <ul>
            {catUploaded.map(d => (
              <li key={d.key}>
                {d.label} <em>({d.category}{catDocs.expiries[d.key] ? `, expires ${catDocs.expiries[d.key]}` : ''})</em>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="sr-note">
        <AlertCircle size={16} />
        <ul>
          <li>All files must be 5MB or smaller (PDF, JPG, PNG).</li>
          <li>Your account will be pending admin verification after submission.</li>
          <li>You must complete all required documents to submit bids.</li>
        </ul>
      </div>
    </Section>
  )
}

function SuccessScreen({ onContinue }) {
  return (
    <div className="sr-success">
      <div className="sr-success-card">
        <span className="sr-success-icon"><CheckCircle2 size={40} /></span>
        <h2>Registration Submitted</h2>
        <p>Your supplier account has been created and is now <b>pending admin verification</b>. You'll be able to bid once an admin approves your documents.</p>
        <button className="sr-btn" onClick={onContinue}>Go to Login</button>
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
            {c.met ? <Check size={13} /> : <span className="sr-pwdot" />}
            {c.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Small building blocks ─────────────────────────────────────────────────────
function Section({ title, desc, children }) {
  return (
    <div className="sr-section">
      <div className="sr-section-head"><h3>{title}</h3><span>{desc}</span></div>
      <div className="sr-section-body">{children}</div>
    </div>
  )
}

// `error` outlines the field in red and replaces the hint with what to fix.
function Field({ label, required, hint, error, children }) {
  return (
    <div className={`sr-field${error ? ' has-error' : ''}`}>
      <label>{label}{required && <span className="req"> *</span>}</label>
      {children}
      {error
        ? <small className="sr-error-text" role="alert"><AlertCircle size={13} aria-hidden="true" /> {error}</small>
        : hint && <small>{hint}</small>}
    </div>
  )
}

function Uploader({ doc, file, onFile, removeFile, error }) {
  const ref = useRef(null)
  return (
    <div className={`sr-upload-field${error ? ' has-error' : ''}`}>
      <div className="sr-upload-label">
        {doc.label}
        <span className={doc.required ? 'req-tag' : 'opt-tag'}>{doc.required ? 'Required' : 'Optional'}</span>
      </div>
      {file ? (
        <div className="sr-file">
          <FileText size={16} /><span className="sr-file-name" title={file.name}>{file.name}</span>
          <button type="button" onClick={() => removeFile(doc.key)} aria-label={`Remove ${doc.label}`}><X size={15} /></button>
        </div>
      ) : (
        <button type="button" className="sr-upload-btn" onClick={() => ref.current?.click()}>
          <Upload size={15} /> Click to upload <em>PDF, JPG, PNG · Max 5MB</em>
        </button>
      )}
      <input ref={ref} type="file" accept=".pdf,.jpg,.jpeg,.png" hidden
        onChange={e => onFile(doc.key, e.target.files[0])} />
      {error && <small className="sr-error-text" role="alert"><AlertCircle size={13} aria-hidden="true" /> {error}</small>}
    </div>
  )
}
