import { useState, useEffect, useMemo } from 'react'
import { useDebouncedValue } from '../../utils/useDebouncedValue'
import { WARRANTY_MONTH_PRESETS, deliveryLabel as deliveryChoiceLabel, deliveryPresetsFor, warrantyLabel } from '../../utils/bidTerms'
import {
  Calendar, Search, Plus, FileText, Eye, X, AlertTriangle, Check, ImageIcon, Download,
} from 'lucide-react'
import { useProjects, createProject, deadlineLabel, deliveryLabel, resubmitProjectDocuments } from '../../store/projectsStore'
import { findCategory, normalizeCategory, OTHERS_CATEGORY } from '../../constants/categories'
import { addCategory, useCategories } from '../../store/categoriesStore'
import { TableSkeleton } from '../../components/Skeleton'
import StatusBadge from '../../components/ui/StatusBadge'
import { TableEmpty } from '../../components/ui/EmptyState'
import LocationPicker from '../../components/ui/LocationPicker'
import MoneyInput from '../../components/ui/MoneyInput'
import SecureImg from '../../components/ui/SecureImg'
import PreviewButton, { LocalPreviewButton } from '../../components/ui/FilePreview'
import {
  DeadlineCell, DocUploader, Info2, RefCode, Toast, checkDoc,
} from './shared'

// ── Planning Page ─────────────────────────────────────────────────────────────

const PROCUREMENT_TYPES = ['Goods', 'Services', 'Infrastructure', 'Consulting Services']
// Adds or removes a number from a sorted list (delivery / warranty choices).
// Value of the "Others (add a new category)" option in the category dropdown.
const NEW_CATEGORY = '__new__'
const toggleNumber = (list, n) => (list.includes(n) ? list.filter(x => x !== n) : [...list, n].sort((a, b) => a - b))
const EMPTY_PROJECT = {
  name: '', category: '', category_other: '', type: 'Goods', budget: '',
  delivery_location: '', bidding_period_days: '', delivery_period_days: '', description: '',
  delivery_options: [], warranty_options: [],   // choices bidders pick from (utils/bidTerms.js)
  reference_image: null,   // optional product reference photo (File)
  require_product_images: false,   // bidders must attach product photos
  product_image_instructions: '',  // optional guidance shown to bidders
}
// Common bidding windows — the deadline itself is computed at publish time
// (today + this many days), never chosen as a fixed calendar date, so it can
// never go stale while the project waits in approval.
const BIDDING_PERIOD_OPTIONS = [7, 14, 21, 30, 45, 60]
// Delivery windows, counted from AWARD (Notice to Proceed), not bid close —
// standard procurement practice. No same-day option: even an urgent order
// needs time for Notice of Award + contract signing first.
const DELIVERY_PERIOD_OPTIONS = [3, 7, 14, 30, 60, 90]
const REQUIRED_PROCUREMENT_DOCS = [
  { key: 'purchase_request', label: 'Purchase Request (PR)' },
  { key: 'technical_specifications', label: 'Technical Specifications' },
  { key: 'terms_of_reference', label: 'Terms of Reference (TOR)' },
  { key: 'approved_budget_document', label: 'Approved Budget Document' },
  { key: 'bid_evaluation_criteria', label: 'Bid Evaluation Criteria' },
]
// Reference image rules: image types only (JPG/PNG/WEBP), max 5 MB. Returns an
// error message or '' when the file is acceptable.
const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp']
const checkImage = (f) => {
  const ext = f.name.split('.').pop().toLowerCase()
  if (!IMG_EXT.includes(ext)) return 'Only image files are accepted.'
  if (f.size > 5 * 1024 * 1024) return 'Image must be under 5MB.'
  return ''
}
const fmtBytes = (n) => {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
// Optional reference-image upload control: dashed drop zone that swaps to an
// image preview (with a remove button) once a file is chosen. `file` is a File;
// `existingUrl` is a previously-saved image shown when editing.
function ReferenceImageUploader({ file, existingUrl, onFile, onRemove }) {
  const [preview, setPreview] = useState('')
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file)
      setPreview(url)
      return () => URL.revokeObjectURL(url)
    }
    setPreview('')
  }, [file])

  const shown = preview || existingUrl
  const handleDrop = (e) => {
    e.preventDefault(); setDragOver(false)
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) onFile(dropped)
  }

  return (
    <div className="ad-form-full">
      <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-dark)' }}>
        Reference Image <span className="ad-opt-tag" style={{ marginLeft: 6 }}>Optional</span>
      </label>
      <div className="ad-muted ad-small" style={{ marginBottom: 10 }}>
        A photo of the exact product, model, color or design you require.
      </div>

      {shown ? (
        <div className="ad-refimg-preview">
          <SecureImg src={shown} alt="Reference preview" className="ad-refimg-img" />
          <button type="button" className="ad-refimg-remove" onClick={onRemove} aria-label="Remove image">
            <X size={14} />
          </button>
          {file && (
            <div className="ad-refimg-meta">
              <span className="ad-refimg-name" title={file.name}>{file.name}</span>
              <span className="ad-muted ad-small">{fmtBytes(file.size)}</span>
            </div>
          )}
        </div>
      ) : (
        <label
          className={`ad-refimg-drop${dragOver ? ' ad-refimg-drop-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <ImageIcon size={28} className="ad-muted" />
          <span className="ad-refimg-cta">Click to upload or drag and drop</span>
          <span className="ad-muted ad-small">JPG, PNG, WEBP · max 5MB</span>
          <input type="file" accept=".jpg,.jpeg,.png,.webp" hidden
            onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = '' }} />
        </label>
      )}
    </div>
  )
}
// Read-only detail view for a planning procurement: its info + uploaded documents.
function ProjectDetailModal({ project, onClose, setToast }) {
  const needsRevision = project.status === 'needs_revision'
  const [files, setFiles] = useState({})   // { docKey: File }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const onFile = (key, file) => {
    if (!file) return
    const msg = checkDoc(file)
    if (msg) { setErr(`${key.replace(/_/g, ' ')}: ${msg}`); return }
    setErr('')
    setFiles(f => ({ ...f, [key]: file }))
  }

  const flaggedDocs = project.documents.filter(d => d.review_status === 'needs_revision')
  const allReplaced = flaggedDocs.every(d => files[d.key])

  const doResubmit = async () => {
    setBusy(true)
    try {
      const fd = new FormData()
      Object.entries(files).forEach(([k, file]) => fd.append(k, file))
      await resubmitProjectDocuments(project.id, fd)
      setToast({ type: 'success', message: 'Document(s) resubmitted — back in the Head\'s queue for review.' })
      onClose()
    } catch (e) {
      setErr(e.message || 'Could not resubmit documents.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ad-modal-overlay" onClick={onClose}>
      <div className="ad-modal" onClick={e => e.stopPropagation()}>
        <div className="ad-modal-header">
          <div>
            <h3>{project.name}</h3>
            <div className="ad-ref-line">
              <RefCode code={project.code} />
              <span className="ad-muted ad-small">{project.category || '—'}</span>
            </div>
          </div>
          <button className="ad-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="ad-modal-body">
          <div className="ad-modal-badges">
            <StatusBadge domain="project" status={project.status} />
          </div>

          {project.status === 'rejected' && project.rejectReason && (
            <div className="ad-modal-error"><AlertTriangle size={15} /> Reason: {project.rejectReason}</div>
          )}

          {needsRevision && (
            <div className="ad-modal-error" style={{ background: 'rgba(249,115,22,0.08)', borderColor: 'rgba(249,115,22,0.3)', color: '#c2410c' }}>
              <AlertTriangle size={15} /> The Head flagged {flaggedDocs.length} document(s). Re-upload them and
              resubmit; the project returns to the Head's queue.
            </div>
          )}

          {project.referenceImage && (
            <div className="ad-refimg-section">
              <div className="ad-refimg-section-label"><ImageIcon size={14} /> Reference Image</div>
              <SecureImg src={project.referenceImage} alt="Reference" className="ad-refimg-view" />
            </div>
          )}

          <div className="ad-info-grid">
            <Info2 label="Procurement Type" value={project.type} />
            <Info2 label="Approved Budget (ABC)" value={project.budget} />
            <Info2 label="Bid Submission Deadline" value={deadlineLabel(project)} />
            <Info2 label="Expected Delivery" value={deliveryLabel(project)} />
            <Info2 label="Delivery Location" value={project.deliveryLocation} />
            <Info2 label="Submitted" value={project.submittedAt} />
            <Info2
              label="Product Images from Bidders"
              value={project.requireProductImages ? 'Required' : 'Optional'}
            />
            {project.requireProductImages && project.productImageInstructions && (
              <Info2 label="Instructions for Bidders" value={project.productImageInstructions} full />
            )}
            <Info2 label="Description" value={project.description} full />
          </div>

          <div className="ad-docs-head"><FileText size={15} /> Procurement Documents</div>
          <div className="ad-docs-list">
            {project.documents.map(d => {
              const flagged = d.review_status === 'needs_revision'
              return (
                <div className={`ad-doc-row${flagged ? ' flagged' : ''}`} key={d.key}>
                  <div className="ad-doc-main">
                    <div className="ad-doc-name">
                      <span className="ad-bold">{d.label}</span>
                      <span className={d.required ? 'ad-req-tag' : 'ad-opt-tag'}>{d.required ? 'Required' : 'Optional'}</span>
                      {flagged
                        ? <span className="ad-doc-status ad-doc-flag">Flagged for revision</span>
                        : d.review_status === 'approved'
                          ? <span className="ad-doc-status ad-doc-ok"><Check size={11} /> Reviewed</span>
                          : null}
                    </div>
                    {d.url
                      ? <span className="ad-doc-actions"><PreviewButton url={d.url} name={d.label} className="ad-doc-view" /><a className="ad-doc-view" href={d.url} target="_blank" rel="noreferrer"><Download size={13} /> Download</a></span>
                      : <span className="ad-doc-missing">Not uploaded</span>}
                  </div>
                  {flagged && d.review_note && (
                    <div className="ad-doc-prevnote">Head's note: “{d.review_note}”</div>
                  )}
                  {flagged && (
                    files[d.key] ? (
                      <div className="ad-doc-file" style={{ marginTop: 8 }}>
                        <FileText size={14} />
                        <span className="ad-doc-name" title={files[d.key].name}>{files[d.key].name}</span>
                        <LocalPreviewButton file={files[d.key]} className="sd-file-preview" />
                        <button type="button" onClick={() => setFiles(f => { const n = { ...f }; delete n[d.key]; return n })} aria-label="Remove"><X size={14} /></button>
                      </div>
                    ) : (
                      <label className="ad-doc-upload" style={{ marginTop: 8 }}>
                        <FileText size={14} /> Upload fixed file
                        <input type="file" accept=".pdf,.jpg,.jpeg,.png" hidden
                          onChange={e => onFile(d.key, e.target.files[0])} />
                      </label>
                    )
                  )}
                </div>
              )
            })}
          </div>
          {err && <div className="ad-modal-error" style={{ marginTop: 12 }}><AlertTriangle size={15} /> {err}</div>}
        </div>

        <div className="ad-modal-footer">
          <button className="ad-btn-cancel" onClick={onClose}>Close</button>
          {needsRevision && (
            <button className="ad-btn-primary" disabled={!allReplaced || busy} onClick={doResubmit}>
              {busy ? 'Resubmitting…' : 'Resubmit Documents'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
export default function PlanningPage() {
  const { projects, loading } = useProjects()
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_PROJECT)
  const [files, setFiles] = useState({})        // { docKey: File }
  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState('')
  const [toast, setToast] = useState(null)      // { type, message }
  const [viewProject, setViewProject] = useState(null) // project shown in detail modal
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const categories = useCategories()
  const [addingCategory, setAddingCategory] = useState(false)
  // The category is chosen from a dropdown of the shared list. Its last option,
  // "Others", is how a new category is added: a box for the name appears, and
  // the name is saved to the list on submit (saveCategory).
  const [catChoice, setCatChoice] = useState('')        // a listed category, NEW_CATEGORY or ''
  const [newCategory, setNewCategory] = useState('')
  const listedCategories = categories.filter(c => c !== OTHERS_CATEGORY)
  const chooseCategory = (v) => {
    setCatChoice(v)
    setForm(f => ({ ...f, category: v === NEW_CATEGORY ? newCategory : v, category_other: '' }))
  }
  const typedCategory = normalizeCategory(form.category)
  const knownCategory = findCategory(categories, typedCategory)
  const isNewCategory = Boolean(typedCategory) && !knownCategory

  // Adds the typed name to the shared category list (or picks the existing one
  // it matches ignoring case) and returns the stored name, or null on failure.
  const saveCategory = async () => {
    if (knownCategory) { set('category', knownCategory); return knownCategory }
    if (!typedCategory) return null
    if (typedCategory.includes(',')) { setSubmitErr("A category name can't contain a comma."); return null }
    setAddingCategory(true)
    try {
      const name = await addCategory(typedCategory)
      set('category', name)
      setSubmitErr('')
      setToast({ type: 'success', message: `Category "${name}" added.` })
      return name
    } catch (err) {
      setSubmitErr(err.message || 'Could not add the category.')
      return null
    } finally {
      setAddingCategory(false)
    }
  }

  const onDoc = (key, file) => {
    if (!file) return
    const msg = checkDoc(file)
    if (msg) { setSubmitErr(`${key.replace(/_/g, ' ')}: ${msg}`); return }
    setSubmitErr('')
    setFiles(f => ({ ...f, [key]: file }))
  }

  // Optional reference image — validate type/size before keeping it; a bad image
  // never blocks the rest of the form (the field just stays empty).
  const onImage = (file) => {
    if (!file) return
    const msg = checkImage(file)
    if (msg) { setSubmitErr(msg); return }
    setSubmitErr('')
    set('reference_image', file)
  }

  const resetForm = () => { setForm(EMPTY_PROJECT); setFiles({}); setShowForm(false); setCatChoice(''); setNewCategory('') }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const missingDocs = REQUIRED_PROCUREMENT_DOCS.filter(d => !files[d.key])
    if (!typedCategory) {
      setSubmitErr(catChoice === NEW_CATEGORY ? 'Type the name of the new category.' : 'Choose a procurement category.'); return
    }
    if (knownCategory === OTHERS_CATEGORY && !form.category_other.trim()) {
      setSubmitErr('Specify what is being procured when the category is Others.'); return
    }
    if (missingDocs.length) {
      setSubmitErr(`Upload all required documents (${missingDocs.length} missing).`); return
    }
    const category = await saveCategory()
    if (!category) return
    setSubmitErr(''); setSubmitting(true)
    try {
      await createProject({ ...form, category }, files)
      resetForm()
      setToast({ type: 'success', message: 'Procurement submitted to the Head for approval.' })
    } catch (err) {
      setSubmitErr(err.message || 'Could not create the project. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // Planning holds projects still in the pipeline: drafts, those awaiting the
  // Head's approval, and any the Head rejected. Approved projects move to Projects.
  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return projects
      .filter(p => ['draft', 'pending_head', 'needs_revision', 'rejected'].includes(p.status))
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q) ||
        (p.code || '').toLowerCase().includes(q))
  }, [projects, query])

  return (
    <div className="ad-content">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      {viewProject && (
        <ProjectDetailModal
          project={viewProject}
          onClose={() => setViewProject(null)}
          setToast={setToast}
        />
      )}
      <div className="ad-card">
        <div className="ad-card-header">
          <label className="ad-search-inline">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">Search planning requests</span>
            <input placeholder="Search by title, type, or ref code" value={search} onChange={e => setSearch(e.target.value)} />
          </label>
          <button className="ad-btn-primary" onClick={() => setShowForm(v => !v)}>
            <Plus size={14} /> {showForm ? 'Cancel' : 'Create Project'}
          </button>
        </div>

        {showForm && (
          <div className="ad-form-wrap">
            <div className="ad-form-title">Create New Procurement</div>
            <form onSubmit={handleSubmit} className="ad-form-grid">
              <div className="ad-form-group ad-form-full">
                <label>Project Title<span className="ui-req" aria-hidden="true">*</span></label>
                <input value={form.name} onChange={e => set('name', e.target.value)} required />
              </div>
              <div className="ad-form-group">
                <label htmlFor="ad-category">Procurement Category<span className="ui-req" aria-hidden="true">*</span></label>
                <select id="ad-category" value={catChoice} onChange={e => chooseCategory(e.target.value)} required>
                  <option value="" disabled>Choose a category…</option>
                  {listedCategories.map(c => <option key={c} value={c}>{c}</option>)}
                  <option value={NEW_CATEGORY}>Others (add a new category)</option>
                </select>
                {catChoice === NEW_CATEGORY && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label htmlFor="ad-category-new">New category name<span className="ui-req" aria-hidden="true">*</span></label>
                    <div className="ad-category-input">
                      {/* autoFocus: after choosing Others the focus would stay on the
                          dropdown, and typing there jumps between options instead. */}
                      <input id="ad-category-new" value={newCategory} maxLength={120} autoComplete="off" required autoFocus
                        placeholder="e.g. Laboratory Equipment"
                        onChange={e => { setNewCategory(e.target.value); set('category', e.target.value) }} />
                      {isNewCategory && (
                        <button type="button" className="ad-btn-primary-sm" onClick={saveCategory} disabled={addingCategory}>
                          <Plus size={14} /> {addingCategory ? 'Adding…' : 'Add'}
                        </button>
                      )}
                    </div>
                    {knownCategory && knownCategory !== OTHERS_CATEGORY && (
                      <span className="ad-muted ad-small">"{knownCategory}" is already in the list, so it will be used.</span>
                    )}
                  </div>
                )}
                {knownCategory === OTHERS_CATEGORY && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label htmlFor="ad-category-other">Please specify<span className="ui-req" aria-hidden="true">*</span></label>
                    <input id="ad-category-other" value={form.category_other} maxLength={200} required
                      onChange={e => set('category_other', e.target.value)} placeholder="e.g. Event sound system rental" style={{ width: '100%' }} />
                    <span className="ad-muted ad-small" style={{ marginTop: 4, display: 'block' }}>
                      Procurements under Others are open to every verified supplier.
                    </span>
                  </div>
                )}
                {isNewCategory && (
                  <span className="ad-muted ad-small" style={{ marginTop: 4, display: 'block' }}>
                    "{typedCategory}" is a new category. It is added when you submit. No supplier
                    is registered for it yet, so suppliers must add it to their categories before they can bid.
                  </span>
                )}
              </div>
              <div className="ad-form-group">
                <label>Procurement Type</label>
                <select value={form.type} onChange={e => set('type', e.target.value)}>
                  {PROCUREMENT_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div className="ad-form-group">
                <label htmlFor="plan-abc">Approved Budget (ABC)<span className="ui-req" aria-hidden="true">*</span></label>
                <MoneyInput id="plan-abc" value={form.budget} onChange={v => set('budget', v)} required />
              </div>
              <div className="ad-form-group">
                <label htmlFor="plan-location">Delivery Location<span className="ui-req" aria-hidden="true">*</span></label>
                <LocationPicker id="plan-location" value={form.delivery_location} onChange={v => set('delivery_location', v)} />
              </div>
              <div className="ad-form-group">
                <label>Bidding Period<span className="ui-req" aria-hidden="true">*</span></label>
                <select value={form.bidding_period_days} onChange={e => set('bidding_period_days', e.target.value)} required>
                  <option value="" disabled>Select a period…</option>
                  {BIDDING_PERIOD_OPTIONS.map(n => <option key={n} value={n}>{n} days</option>)}
                </select>
                <span className="ad-muted ad-small" style={{ marginTop: 4, display: 'block' }}>
                  The deadline is set when you publish, so suppliers get the full period.
                </span>
              </div>
              <div className="ad-form-group">
                <label>Delivery Period<span className="ui-req" aria-hidden="true">*</span></label>
                <select value={form.delivery_period_days} onChange={e => set('delivery_period_days', e.target.value)} required>
                  <option value="" disabled>Select a period…</option>
                  {DELIVERY_PERIOD_OPTIONS.map(n => <option key={n} value={n}>{n} days</option>)}
                </select>
                <span className="ad-muted ad-small" style={{ marginTop: 4, display: 'block' }}>
                  Counted from the day a winner is selected.
                </span>
              </div>
              <fieldset className="ad-form-group ad-form-full ad-choice-group">
                <legend>Delivery timelines bidders may offer</legend>
                <div className="ad-choice-list">
                  {deliveryPresetsFor(form.delivery_period_days).map(d => (
                    <label key={d} className="ad-choice">
                      <input type="checkbox" checked={form.delivery_options.includes(d)}
                        onChange={() => set('delivery_options', toggleNumber(form.delivery_options, d))} />
                      {deliveryChoiceLabel(d)}
                    </label>
                  ))}
                </div>
                <span className="ad-muted ad-small">Pick the ones the specifications allow. Leave all unticked to let bidders type their own.</span>
              </fieldset>
              <fieldset className="ad-form-group ad-form-full ad-choice-group">
                <legend>Warranty periods bidders may offer</legend>
                <div className="ad-choice-list">
                  {WARRANTY_MONTH_PRESETS.map(m => (
                    <label key={m} className="ad-choice">
                      <input type="checkbox" checked={form.warranty_options.includes(m)}
                        onChange={() => set('warranty_options', toggleNumber(form.warranty_options, m))} />
                      {warrantyLabel(m)}
                    </label>
                  ))}
                </div>
                <span className="ad-muted ad-small">Leave all unticked to let bidders type their own.</span>
              </fieldset>
              <div className="ad-form-group ad-form-full">
                <label>Project Description<span className="ui-req" aria-hidden="true">*</span></label>
                <textarea value={form.description} onChange={e => set('description', e.target.value)} rows={3} required />
              </div>

              <div className="ad-form-full">
                <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-dark)' }}>
                  Required Procurement Documents
                </label>
                <div className="ad-muted ad-small" style={{ marginBottom: 10 }}>
                  All required. PDF, JPG or PNG, max 5 MB each.
                </div>
                <div className="ad-doc-grid">
                  {REQUIRED_PROCUREMENT_DOCS.map(d => (
                    <DocUploader key={d.key} doc={d} file={files[d.key]} onFile={onDoc}
                      onRemove={() => setFiles(f => { const n = { ...f }; delete n[d.key]; return n })} />
                  ))}
                </div>
              </div>

              <ReferenceImageUploader
                file={form.reference_image}
                onFile={onImage}
                onRemove={() => set('reference_image', null)}
              />

              {/* Off by default: only procurements where the exact product,
                  brand or style matters need bidders to show photos of it. */}
              <div className="ad-form-full ad-pimg-option">
                <label className="ad-pimg-toggle">
                  <input
                    type="checkbox"
                    checked={form.require_product_images}
                    onChange={e => set('require_product_images', e.target.checked)}
                  />
                  <span>
                    <strong>Require product images from bidders</strong>
                    <span className="ad-muted ad-small">
                      Each supplier must attach 1 to 5 photos of the exact product offered.
                    </span>
                  </span>
                </label>
                {form.require_product_images && (
                  <div className="ad-form-group" style={{ marginTop: 10 }}>
                    <label htmlFor="pimg-instructions">Instructions for bidders <span className="ad-opt-tag">Optional</span></label>
                    <textarea
                      id="pimg-instructions"
                      rows={2}
                      maxLength={300}
                      value={form.product_image_instructions}
                      onChange={e => set('product_image_instructions', e.target.value)}
                      placeholder="e.g. Show the exact brand/model and a photo of the actual product"
                    />
                    <span className="ad-muted ad-small">{form.product_image_instructions.length} / 300</span>
                  </div>
                )}
              </div>

              {submitErr && (
                <div className="ad-form-full ad-inline-error" role="alert">
                  <AlertTriangle size={15} aria-hidden="true" /> {submitErr}
                </div>
              )}
              <div className="ad-form-actions">
                <button type="button" className="ad-btn-cancel" onClick={resetForm}>Cancel</button>
                <button type="submit" className="ad-btn-primary" disabled={submitting}>
                  {submitting ? 'Submitting…' : 'Submit for Head Approval'}
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="ad-table-scroll ad-x-scroll">
        <table className="ad-table">
          <thead>
            <tr>
              <th>Ref Code</th><th>Project Title</th><th className="ad-num">Budget</th><th>Type</th>
              <th>Bidding Period</th><th>Status</th><th className="ad-actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && filtered.length === 0
              ? <TableSkeleton rows={4} cols={7} />
              : filtered.length === 0
              ? <TableEmpty colSpan={7} icon={Calendar}
                  title={search ? 'No planning requests match your search' : 'No planning requests yet'}
                  description={search
                    ? 'Try a different title, type, or ref code.'
                    : 'Create a project to send it to the Head for review.'}
                  action={!search && !showForm && (
                    <button className="ad-btn-primary" onClick={() => setShowForm(true)}>
                      <Plus size={14} /> Create Project
                    </button>
                  )} />
              : filtered.map(p => (
                <tr key={p.id}>
                  <td><RefCode code={p.code} /></td>
                  <td className="ad-bold">
                    {p.name}
                    {p.status === 'rejected' && p.rejectReason && (
                      <div className="ad-muted ad-small" style={{ fontWeight: 400, marginTop: 2 }}>
                        Reason: {p.rejectReason}
                      </div>
                    )}
                    {p.status === 'needs_revision' && (
                      <div className="ad-muted ad-small" style={{ fontWeight: 400, marginTop: 2, color: '#c2410c' }}>
                        {p.documents.filter(d => d.review_status === 'needs_revision').length} document(s) flagged by the Head — click View Details to fix.
                      </div>
                    )}
                  </td>
                  <td className="ad-num">{p.budget}</td>
                  <td className="ad-nowrap">{p.type}</td>
                  <td><DeadlineCell project={p} /></td>
                  <td>
                    <StatusBadge domain="project" status={p.status} />
                  </td>
                  <td className="ad-actions-col">
                    <div className="ad-actions">
                      <button className="ad-btn-view-sm" onClick={() => setViewProject(p)}>
                        <Eye size={12} /> View Details
                      </button>
                    </div>
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
