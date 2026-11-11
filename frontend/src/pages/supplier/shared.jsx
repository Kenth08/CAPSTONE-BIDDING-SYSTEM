import { useState, useEffect, useRef } from 'react'
import {
  FileText, Clock, X, Send, AlertTriangle, Upload, Camera,
} from 'lucide-react'
import { apiResendVerification, apiUploadCategoryDocuments } from '../../api'
import { checkDocFile, pastExpiryProblem, todayIso } from '../../components/CategoryDocuments'
import SecureImg from '../../components/ui/SecureImg'
import { LocalPreviewButton } from '../../components/ui/FilePreview'

// API → UI mapping (backend uses code/decimal/ISO; the UI shows ₱ + dates).
export const fmtDate = (v) => v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
export const fmtPeso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH')
// Backend deadline is an ISO date (YYYY-MM-DD) — plain string comparison
// against today's ISO date is enough and avoids timezone-conversion bugs.
export const todayISO = () => new Date().toISOString().slice(0, 10)
export const mapProductImage = (i) => ({ id: i.id, url: i.url, caption: i.caption || '' })
// ── Bid document upload rules (per-field types; shared 5 MB cap) ──────────────
export const MAX_MB = 5
// accept: the <input accept> attribute; exts: allowed extensions; text: shown in the box.
export const UPLOAD_RULES = {
  productImages: { accept: '.jpg,.jpeg,.png,.webp', exts: ['jpg', 'jpeg', 'png', 'webp'], text: 'JPG, PNG or WebP' },
  datasheet:     { accept: '.pdf,.docx,.xlsx', exts: ['pdf', 'docx', 'xlsx'], text: 'PDF, DOCX or XLSX' },
  compliance:    { accept: '.pdf', exts: ['pdf'], text: 'PDF only' },
  quotation:     { accept: '.pdf,.doc,.docx', exts: ['pdf', 'doc', 'docx'], text: 'PDF, DOC or DOCX' },
  technical:     { accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg', exts: ['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg'], text: 'PDF, DOC, DOCX, PNG or JPG' },
  other:         { accept: '.pdf,.jpg,.jpeg,.png,.docx,.xlsx', exts: ['pdf', 'jpg', 'jpeg', 'png', 'docx', 'xlsx'], text: 'PDF, JPG, PNG, DOCX or XLSX' },
}
// Returns an error string or null. Messages match the spec exactly.
export function validateBidFile(file, rule) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (!rule.exts.includes(ext)) return 'Only the accepted file types are allowed.'
  if (file.size > MAX_MB * 1024 * 1024) return 'File must be under 5MB.'
  return null
}
// Legacy validator kept for the document re-submission panel (PDF/JPG/PNG).
export const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png']
export function validateFile(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (!ALLOWED_EXT.includes(ext)) return `Unsupported type ".${ext}". Use PDF, JPG, or PNG.`
  if (file.size > MAX_MB * 1024 * 1024) return `File is too large (max ${MAX_MB} MB).`
  return null
}
// ─── Product images ──────────────────────────────────────────────────────────
// Up to 5 photos of the offered product, each with an optional caption. The
// backend re-checks everything (real format via Pillow, size, count, deadline);
// these checks only save the supplier a failed round-trip.
export const MAX_PRODUCT_IMAGES = 5
export const CAPTION_MAX = 150
// Preview of a not-yet-uploaded File. The object URL is revoked on unmount so
// removed or submitted images don't leak memory.
export function LocalThumb({ file, alt }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  return url ? <SecureImg src={url} alt={alt} /> : null
}
export let pickSeq = 0
// Picker for NEW images: thumbnail, caption and remove per image, plus an add
// tile while there is room. `items` is [{ id, file, caption }]; `max` is how many
// more images this bid can take.
export function ProductImagePicker({ items, onChange, max, disabled }) {
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
export function appendProductImages(fd, items) {
  items.forEach(i => {
    fd.append('product_images', i.file)
    fd.append('product_image_captions', i.caption.trim())
  })
}
// Shown until the supplier confirms their email via the link we mailed them
// at registration — independent of qualification_status, so it can appear
// alongside any of those banners.
export function EmailVerifyBanner({ profile, setToast }) {
  const [sending, setSending] = useState(false)
  if (!profile || profile.email_verified) return null

  const resend = async () => {
    setSending(true)
    try {
      await apiResendVerification()
      setToast({ type: 'success', message: `Verification email sent${profile.email ? ` to ${profile.email}` : ''}. Check your inbox and spam folder.` })
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
          Open the link we emailed{profile.email ? ` to ${profile.email}` : ' you'} so the BAC office can approve your registration. Check your spam folder, or resend it.
        </span>
      </div>
      <button type="button" className="sd-btn-back" disabled={sending} onClick={resend}>
        {sending ? 'Sending…' : 'Resend Email'}
      </button>
    </div>
  )
}
export const BID_LABEL = {
  under_review: 'Under Review', qualified: 'Qualified',
  disqualified: 'Disqualified', winner: 'Winner',
}
// Normalize the supplier's registered categories into a list. The JSON list is
// the source of truth; fall back to the legacy comma-joined string.
export function profileBusinessTypes(profile) {
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
export function CategoryRequestBanner({ profile, onWithdraw, withdrawing }) {
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
            categories or submit a new request below.
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
          Requested: {changes || 'no change'}. Until approved, you can only bid in your current
          categories: {approved.join(', ') || '—'}.
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
// Can the supplier upload this category license from My Documents? Mirrors the
// server rule (SupplierViewSet.my_category_documents): any license of a pending
// category request, or a current category's license that is missing or was
// flagged. A flagged document during a full revision goes through the
// "Documents Needing Revision" panel instead, so it isn't offered twice.
export function canUploadCategoryDoc(doc, profile) {
  const inRevision = profile?.qualification_status === 'needs_revision'
  if (inRevision && doc.review_status === 'needs_revision') return false
  // Base registration documents: only as a renewal (expired, expiring soon or
  // missing). One the BAC office flagged goes through the revision panel.
  if (doc.source === 'base') return doc.review_status !== 'needs_revision' && (!!doc.reason || !!doc.expiring_soon)
  // Missing, lost from storage, expired or expiring soon (a renewal) → upload.
  return doc.pending_category || !!doc.reason || doc.expiring_soon || doc.review_status === 'needs_revision'
}
// Inline "Upload" for one category license: choose a file (+ expiry date) and send.
export function CategoryDocUpload({ doc, setToast, onUploaded }) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState(null)
  const [expiry, setExpiry] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)

  const send = async () => {
    if (!file) { setToast({ type: 'error', message: `Choose a file for ${doc.label}.` }); return }
    if (doc.has_expiry && !expiry) { setToast({ type: 'error', message: `Enter the expiry date of the ${doc.label}.` }); return }
    const past = pastExpiryProblem(doc.label, expiry)
    if (past) { setToast({ type: 'error', message: past }); return }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append(`catdoc_${doc.key}`, file)
      if (doc.has_expiry) fd.append(`catdoc_${doc.key}_expiry`, expiry)
      await apiUploadCategoryDocuments(fd)
      setToast({ type: 'success', message: `${doc.label} uploaded. The Admin will review it.` })
      setOpen(false); setFile(null); setExpiry('')
      await onUploaded?.()
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not upload the document.' })
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" className="sd-reupload-btn" onClick={() => setOpen(true)}>
        <Upload size={14} /> Upload
      </button>
    )
  }
  return (
    <div className="sd-catdoc-upload">
      {file ? (
        <span className="cd-file">
          <FileText size={14} aria-hidden="true" />
          <span className="cd-file-name" title={file.name}>{file.name}</span>
          <LocalPreviewButton file={file} className="sd-file-preview" />
          <button type="button" className="cd-icon-btn" onClick={() => setFile(null)} aria-label="Remove file"><X size={13} /></button>
        </span>
      ) : (
        <button type="button" className="cd-upload-btn" onClick={() => ref.current?.click()}>
          <Upload size={14} aria-hidden="true" /> Choose file
        </button>
      )}
      <input ref={ref} type="file" accept=".pdf,.jpg,.jpeg,.png" hidden
        onChange={e => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          const msg = checkDocFile(f)
          if (msg) { setToast({ type: 'error', message: `${doc.label}: ${msg}` }); return }
          setFile(f)
        }} />
      {doc.has_expiry && (
        <label className="cd-expiry">
          <span>Expiry date</span>
          <input type="date" min={todayIso()} value={expiry} onChange={e => setExpiry(e.target.value)} />
        </label>
      )}
      <button type="button" className="sd-btn-primary" onClick={send} disabled={busy}>
        {busy ? 'Uploading…' : 'Send'}
      </button>
      <button type="button" className="sd-btn-cancel" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
    </div>
  )
}
// Shown by Profile/Settings when the profile could not be loaded. Without this
// both pages sat on their loading skeleton indefinitely, which looked like a
// hung page rather than a failed request.
export function ProfileLoadError({ message, onRetry, retrying }) {
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
              ? 'Your sign-in has no company profile. Ask the procuring entity’s administrator to link or re-create your registration.'
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
