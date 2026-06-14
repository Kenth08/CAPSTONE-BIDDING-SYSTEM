import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Shield, Eye, EyeOff, ArrowLeft, Check, Upload, FileText, X,
  CheckCircle2, AlertCircle,
} from 'lucide-react'
import { apiRegisterSupplier } from '../api'
import { CATEGORIES } from '../constants/categories'
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

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const toggleType = (t) =>
    setBusinessTypes(list => list.includes(t) ? list.filter(x => x !== t) : [...list, t])

  const onFile = (key, file) => {
    if (!file) return
    const msg = validateFile(file)
    if (msg) { showError(`${key.replace(/_/g, ' ')}: ${msg}`); return }
    setError('')
    setFiles(f => ({ ...f, [key]: file }))
  }
  const removeFile = (key) => setFiles(f => { const n = { ...f }; delete n[key]; return n })

  const requiredUploaded = REQUIRED_KEYS.filter(k => files[k]).length
  const optionalUploaded = OPTIONAL_KEYS.filter(k => files[k]).length

  // ── Per-step gate ───────────────────────────────────────────────────────────
  const validateStep = () => {
    if (step === 0) {
      const need = ['full_name', 'email', 'company_name', 'company_address',
        'phone_number', 'tin', 'representative_name']
      if (need.some(k => !form[k].trim())) return 'Please fill in all required fields.'
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return 'Enter a valid email address.'
      if (!/^\d+$/.test(form.phone_number)) return 'Phone number must contain digits only.'
      if (!/^[\d-]+$/.test(form.tin)) return 'TIN must contain digits only.'
      if (!passwordValid(form.password)) return 'Your password does not meet all the requirements yet.'
      if (form.password !== form.confirm_password) return 'Passwords do not match.'
      if (businessTypes.length === 0) return 'Select at least one business type.'
    }
    if (step === 1) {
      const missing = REQUIRED_KEYS.filter(k => !files[k])
      if (missing.length) return `Upload all required documents (${missing.length} missing).`
    }
    if (step === 2 && !form.declaration_accepted) {
      return 'You must accept the declaration to continue.'
    }
    return ''
  }

  const next = () => {
    const msg = validateStep()
    if (msg) { showError(msg); return }
    setError('')
    setStep(s => Math.min(s + 1, STEPS.length - 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const back = () => {
    setError('')
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
              showConfirm={showConfirm} setShowConfirm={setShowConfirm} />}
            {step === 1 && <StepDocuments form={form} set={set} files={files}
              onFile={onFile} removeFile={removeFile} />}
            {step === 2 && <StepDeclaration form={form} set={set} />}
            {step === 3 && <StepReview required={requiredUploaded} optional={optionalUploaded} />}
          </div>

          {/* Nav */}
          <div className="sr-nav">
            {step > 0
              ? <button className="sr-btn-ghost" onClick={back}><ArrowLeft size={15} /> Back</button>
              : <span />}
            {step < STEPS.length - 1
              ? <button className="sr-btn" onClick={next}>Continue</button>
              : <button className="sr-btn" onClick={submit} disabled={loading}>
                  {loading ? 'Submitting…' : 'Submit Registration'}
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
function StepBasic({ form, set, businessTypes, toggleType, showPass, setShowPass, showConfirm, setShowConfirm }) {
  return (
    <>
      <Section title="Account Information" desc="Your login credentials">
        <Field label="Full Name" required>
          <input value={form.full_name} onChange={e => set('full_name', e.target.value)} placeholder="Juan Dela Cruz" />
        </Field>
        <Field label="Email Address" required>
          <input type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="you@company.com" />
        </Field>
        <div className="sr-row">
          <Field label="Password" required>
            <div className="sr-pass">
              <input type={showPass ? 'text' : 'password'} value={form.password}
                onChange={e => set('password', e.target.value)} placeholder="••••••••" />
              <button type="button" onClick={() => setShowPass(!showPass)}>
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </Field>
          <Field label="Confirm Password" required>
            <div className="sr-pass">
              <input type={showConfirm ? 'text' : 'password'} value={form.confirm_password}
                onChange={e => set('confirm_password', e.target.value)} placeholder="••••••••" />
              <button type="button" onClick={() => setShowConfirm(!showConfirm)}>
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
        <Field label="Company Name" required>
          <input value={form.company_name} onChange={e => set('company_name', e.target.value)} placeholder="Acme Trading Corp." />
        </Field>
        <Field label="Company Address" required>
          <input value={form.company_address} onChange={e => set('company_address', e.target.value)} placeholder="123 Rizal St, Manila" />
        </Field>
        <div className="sr-row">
          <Field label="Phone Number" required hint="Numbers only.">
            <input value={form.phone_number} onChange={e => set('phone_number', e.target.value.replace(/[^\d]/g, ''))} placeholder="09171234567" />
          </Field>
          <Field label="TIN" required hint="Numbers only.">
            <input value={form.tin} onChange={e => set('tin', e.target.value.replace(/[^\d-]/g, ''))} placeholder="123-456-789" />
          </Field>
        </div>
        <Field label="Representative Name" required>
          <input value={form.representative_name} onChange={e => set('representative_name', e.target.value)} placeholder="Authorized representative" />
        </Field>
        <Field label="Business Type" required hint="Select all categories that apply to your company.">
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
function StepDocuments({ form, set, files, onFile, removeFile }) {
  return (
    <>
      <Section title="Legal Documents" desc="Required for company registration and compliance.">
        <div className="sr-grid">
          {LEGAL_DOCS.map(d => <Uploader key={d.key} doc={d} file={files[d.key]} onFile={onFile} removeFile={removeFile} />)}
        </div>
        <Field label="Mayor's Permit Expiry">
          <input type="date" value={form.mayors_permit_expiry} onChange={e => set('mayors_permit_expiry', e.target.value)} />
        </Field>
      </Section>

      <Section title="Financial Documents" desc="Required to verify financial capacity.">
        <div className="sr-grid">
          {FINANCIAL_DOCS.map(d => <Uploader key={d.key} doc={d} file={files[d.key]} onFile={onFile} removeFile={removeFile} />)}
        </div>
        <div className="sr-row">
          <Field label="Tax Clearance Expiry">
            <input type="date" value={form.tax_clearance_expiry} onChange={e => set('tax_clearance_expiry', e.target.value)} />
          </Field>
          <Field label="Financial Statement Year" hint="Year digits only.">
            <input value={form.financial_statement_year}
              onChange={e => set('financial_statement_year', e.target.value.replace(/[^\d]/g, '').slice(0, 4))} placeholder="e.g. 2026" />
          </Field>
        </div>
      </Section>

      <Section title="Representative Authorization" desc="Required authorization document.">
        <div className="sr-grid">
          {AUTH_DOCS.map(d => <Uploader key={d.key} doc={d} file={files[d.key]} onFile={onFile} removeFile={removeFile} />)}
        </div>
      </Section>

      <Section title="Qualifications & Track Record" desc="Optional — demonstrate experience.">
        <div className="sr-grid">
          {OPTIONAL_DOCS.map(d => <Uploader key={d.key} doc={d} file={files[d.key]} onFile={onFile} removeFile={removeFile} />)}
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
function StepDeclaration({ form, set }) {
  return (
    <Section title="Declaration" desc="Read and confirm before submitting.">
      <div className="sr-declaration">
        <p>I hereby certify that all information provided in this registration and all uploaded documents are true, accurate, and authentic to the best of my knowledge.</p>
        <p>I understand that any false statement or falsified document is grounds for disqualification and possible legal action, and that my company will be subject to admin verification before being allowed to submit bids.</p>
        <p>I consent to the processing of the submitted business information solely for the purpose of supplier verification and procurement.</p>
      </div>
      <label className="sr-agree">
        <input type="checkbox" checked={form.declaration_accepted}
          onChange={e => set('declaration_accepted', e.target.checked)} />
        I have read and agree to the declaration above.
      </label>
    </Section>
  )
}

// ── Step 4: Review ────────────────────────────────────────────────────────────
function StepReview({ required, optional }) {
  return (
    <Section title="Review & Submit" desc="Verify your information before submitting.">
      <div className="sr-review">
        <div className="sr-stat">
          <strong className={required === REQUIRED_KEYS.length ? 'ok' : 'warn'}>{required}/{REQUIRED_KEYS.length}</strong>
          <span>Required docs uploaded</span>
        </div>
        <div className="sr-stat"><strong>{optional}</strong><span>Optional docs uploaded</span></div>
        <div className="sr-stat"><strong className="pending">Pending Review</strong><span>Status after submission</span></div>
      </div>
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

function Field({ label, required, hint, children }) {
  return (
    <div className="sr-field">
      <label>{label}{required && <span className="req"> *</span>}</label>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  )
}

function Uploader({ doc, file, onFile, removeFile }) {
  const ref = useRef(null)
  return (
    <div className="sr-upload-field">
      <div className="sr-upload-label">
        {doc.label}
        <span className={doc.required ? 'req-tag' : 'opt-tag'}>{doc.required ? 'Required' : 'Optional'}</span>
      </div>
      {file ? (
        <div className="sr-file">
          <FileText size={16} /><span className="sr-file-name" title={file.name}>{file.name}</span>
          <button type="button" onClick={() => removeFile(doc.key)}><X size={15} /></button>
        </div>
      ) : (
        <button type="button" className="sr-upload-btn" onClick={() => ref.current?.click()}>
          <Upload size={15} /> Click to upload <em>PDF, JPG, PNG · Max 5MB</em>
        </button>
      )}
      <input ref={ref} type="file" accept=".pdf,.jpg,.jpeg,.png" hidden
        onChange={e => onFile(doc.key, e.target.files[0])} />
    </div>
  )
}
