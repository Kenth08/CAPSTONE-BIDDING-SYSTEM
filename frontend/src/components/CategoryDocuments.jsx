// Extra licenses a supplier's business categories require (FDA, PCAB, LTFRB…).
//
// The rules live on the server (backend/procurement/document_requirements.py)
// and are read through the public document-requirements endpoint, so the
// registration forms never hard-code which category needs what. Used by:
//   * SupplierRegister.jsx            — self-registration
//   * AdminDashboard.jsx              — Admin-assisted (walk-in) registration
//   * SupplierDashboard.jsx           — adding a category later
//
// Files are sent as catdoc_<key> and their expiry dates as catdoc_<key>_expiry.
import { useEffect, useRef, useState } from 'react'
import { AlertCircle, FileText, Upload, X } from 'lucide-react'

import { apiDocumentRequirements } from '../api'
import '../style/category-docs.css'

const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png']
const MAX_MB = 5

/** Today as yyyy-mm-dd in the viewer's own timezone (what a date input holds). */
export function todayIso() {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 10)
}

/** '' or a message when a typed expiry date is already in the past. */
export function pastExpiryProblem(label, value) {
  return value && value < todayIso()
    ? `The ${label} expired on ${value}. Upload a current, valid copy.`
    : ''
}

export function checkDocFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (!ALLOWED_EXT.includes(ext)) return `Unsupported type ".${ext}". Use PDF, JPG or PNG.`
  if (file.size > MAX_MB * 1024 * 1024) return `File is too large (max ${MAX_MB} MB).`
  return ''
}

/**
 * The category documents (not the base set) for `categories`.
 * Returns { docs, loading, error, reload }.
 */
export function useCategoryRequirements(categories) {
  const key = [...(categories || [])].sort().join('|')
  const [state, setState] = useState({ docs: [], loading: false, error: '' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const list = key ? key.split('|') : []
    if (list.length === 0) { setState({ docs: [], loading: false, error: '' }); return }
    let alive = true
    setState(s => ({ ...s, loading: true, error: '' }))
    apiDocumentRequirements(list)
      .then(all => { if (alive) setState({ docs: all.filter(d => d.source === 'category'), loading: false, error: '' }) })
      .catch(err => { if (alive) setState({ docs: [], loading: false, error: err.message }) })
    return () => { alive = false }
  }, [key, nonce])

  return { ...state, reload: () => setNonce(n => n + 1) }
}

/** First problem that blocks submitting, or '' when every required doc is ready. */
export function categoryDocsProblem(docs, files, expiries) {
  const missing = docs.filter(d => d.required && !files[d.key])
  if (missing.length) {
    return `Upload the documents your categories require: ${missing.map(d => d.label).join(', ')}.`
  }
  const noDate = docs.filter(d => d.has_expiry && files[d.key] && !expiries[d.key])
  if (noDate.length) return `Enter the expiry date for: ${noDate.map(d => d.label).join(', ')}.`
  for (const d of docs) {
    const problem = files[d.key] ? pastExpiryProblem(d.label, expiries[d.key]) : ''
    if (problem) return problem
  }
  return ''
}

/** Add the chosen files (only for `docs`, i.e. the current categories) to a FormData. */
export function appendCategoryDocs(fd, docs, files, expiries) {
  docs.forEach(d => {
    if (!files[d.key]) return
    fd.append(`catdoc_${d.key}`, files[d.key])
    if (d.has_expiry && expiries[d.key]) fd.append(`catdoc_${d.key}_expiry`, expiries[d.key])
  })
}

/** Small state holder for the files + expiry dates of the category documents. */
export function useCategoryDocState() {
  const [files, setFiles] = useState({})
  const [expiries, setExpiries] = useState({})
  return {
    files, expiries,
    setFile: (k, f) => setFiles(s => ({ ...s, [k]: f })),
    removeFile: (k) => setFiles(s => { const n = { ...s }; delete n[k]; return n }),
    setExpiry: (k, v) => setExpiries(s => ({ ...s, [k]: v })),
    reset: () => { setFiles({}); setExpiries({}) },
  }
}

function DocRow({ doc, file, expiry, onFile, onRemove, onExpiry, onError, idPrefix, error, expiryError }) {
  const ref = useRef(null)
  const inputId = `${idPrefix}-${doc.key}`
  return (
    <div className={`cd-row${error || expiryError ? ' has-error' : ''}`}>
      <div className="cd-row-head">
        <span className="cd-label">{doc.label}</span>
        <span className={doc.required ? 'cd-tag cd-tag-req' : 'cd-tag'}>{doc.required ? 'Required' : 'Optional'}</span>
      </div>
      {doc.help_text && <p className="cd-help">{doc.help_text}</p>}
      <div className="cd-controls">
        {file ? (
          <div className="cd-file" data-invalid={error ? 'true' : undefined}>
            <FileText size={15} aria-hidden="true" />
            <span className="cd-file-name" title={file.name}>{file.name}</span>
            <button type="button" className="cd-icon-btn" onClick={() => onRemove(doc.key)} aria-label={`Remove ${doc.label}`}>
              <X size={14} />
            </button>
          </div>
        ) : (
          <button type="button" className={`cd-upload-btn${error ? ' cd-invalid' : ''}`} onClick={() => ref.current?.click()}>
            <Upload size={14} aria-hidden="true" /> Choose file <em>PDF, JPG, PNG · max 5 MB</em>
          </button>
        )}
        {doc.has_expiry && (
          <label className="cd-expiry" htmlFor={`${inputId}-exp`}>
            <span>Expiry date{file ? <span className="cd-req"> *</span> : null}</span>
            <input id={`${inputId}-exp`} type="date" value={expiry || ''} min={todayIso()}
              className={expiryError ? 'cd-invalid' : undefined} aria-invalid={!!expiryError}
              onChange={e => onExpiry(doc.key, e.target.value)} />
          </label>
        )}
      </div>
      {(error || expiryError) && (
        <small className="cd-error-text" role="alert">
          <AlertCircle size={13} aria-hidden="true" /> {error || expiryError}
        </small>
      )}
      <input ref={ref} id={inputId} type="file" accept=".pdf,.jpg,.jpeg,.png" hidden
        onChange={e => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          const msg = checkDocFile(f)
          if (msg) { onError?.(`${doc.label}: ${msg}`); return }
          onFile(doc.key, f)
        }} />
    </div>
  )
}

/**
 * Uploaders for the category documents, grouped by category.
 * `state` comes from useCategoryDocState(); `req` from useCategoryRequirements().
 */
export default function CategoryDocumentFields({ req, state, onError, idPrefix = 'catdoc', emptyText, errors = {} }) {
  if (req.loading) return <p className="cd-note">Checking which documents your categories need…</p>
  if (req.error) {
    return (
      <div className="cd-error" role="alert">
        <AlertCircle size={15} aria-hidden="true" />
        <span>{req.error}</span>
        <button type="button" onClick={req.reload}>Try again</button>
      </div>
    )
  }
  if (req.docs.length === 0) {
    return emptyText ? <p className="cd-note">{emptyText}</p> : null
  }
  const groups = req.docs.reduce((acc, d) => {
    (acc[d.category] ||= []).push(d)
    return acc
  }, {})
  return (
    <div className="cd-groups">
      {Object.entries(groups).map(([category, docs]) => (
        <fieldset key={category} className="cd-group">
          <legend>{category}</legend>
          {docs.map(d => (
            <DocRow key={d.key} doc={d} idPrefix={idPrefix}
              file={state.files[d.key]} expiry={state.expiries[d.key]}
              onFile={state.setFile} onRemove={state.removeFile} onExpiry={state.setExpiry} onError={onError}
              error={errors[`catdoc_${d.key}`]} expiryError={errors[`catdoc_${d.key}_expiry`]} />
          ))}
        </fieldset>
      ))}
    </div>
  )
}
