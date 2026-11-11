import { lazy, Suspense, useState, useEffect, useRef } from 'react'
import { ColumnChart, DonutChart, STATUS, monthLabel } from '../components/charts/Charts'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, FileText, Clock, CheckCircle2, Building2, LogOut, Settings, ArrowRight, User, X, Send, Trophy, BarChart2, AlertTriangle, Upload, Lock, XCircle, ShieldCheck,
} from 'lucide-react'
import {
  apiLogout, apiGetMySupplier, apiResubmitDocuments, apiListProjects, apiListMyBids, apiSubmitBid, apiWithdrawBid, apiListAwards,
} from '../api'
import { pastExpiryProblem, todayIso } from '../components/CategoryDocuments'
import { Skeleton, ListSkeleton, PageSkeleton } from '../components/Skeleton'
import { getCached, loadCached } from '../utils/sessionCache'
import AnchorActivity from '../components/AnchorActivity'
import AppSidebar from '../components/shell/AppSidebar'
import AppHeader, { storedUser } from '../components/shell/AppHeader'
import StatusBadge from '../components/ui/StatusBadge'
import EmptyState from '../components/ui/EmptyState'
import { peso, pesoCompact } from '../utils/format'
import { DashGrid, DashHeader, Panel, TabbedPanel } from '../components/ui/Dashboard'
import KpiCard, { KpiRow } from '../components/ui/KpiCard'
import Countdown, { useNow } from '../components/ui/Countdown'
import Thumbnail from '../components/ui/Thumbnail'
import Lightbox from '../components/ui/Lightbox'
import RelativeTime from '../components/ui/RelativeTime'
import Toaster from '../components/ui/Toaster'
import { isVerified } from '../blockchain/anchorState'
import '../style/SupplierDashboard.css'
import { LocalPreviewButton } from '../components/ui/FilePreview'
import {
  CategoryDocUpload, EmailVerifyBanner, canUploadCategoryDoc, fmtDate, fmtPeso, mapProductImage, todayISO, validateFile,
} from './supplier/shared'

// Each section is its own download, loaded the first time it is opened.
const SupplierProjects = lazy(() => import('./supplier/SupplierProjects'))
const SupplierBids = lazy(() => import('./supplier/SupplierBids'))
const SupplierStatusPage = lazy(() => import('./supplier/SupplierStatusPage'))
const SupplierReportsPage = lazy(() => import('./supplier/SupplierReportsPage'))
const SupplierProfile = lazy(() => import('./supplier/SupplierProfile'))
const SupplierSettings = lazy(() => import('./supplier/SupplierSettings'))
// The bid form loads when a supplier opens it, not with the dashboard.
const BidModal = lazy(() => import('./supplier/BidModal'))
const ProcurementRecordPage = lazy(() => import('../components/ProcurementRecord'))
const ProjectAnchorDetailPage = lazy(() =>
  import('../components/AnchorDetail').then((m) => ({ default: m.ProjectAnchorDetailPage })))

const mapProject = (p) => ({
  id: p.code, pk: p.id, name: p.name, budget: fmtPeso(p.budget),
  budgetRaw: Number(p.budget || 0),  // numeric ABC for the live budget comparison
  deadline: fmtDate(p.deadline), category: p.category, categoryOther: p.category_other || '', description: p.description,
  // Delivery (days) and warranty (months) choices; empty = free text (older projects).
  deliveryOptions: p.delivery_options || [], warrantyOptions: p.warranty_options || [],
  deadlineRaw: p.deadline || null, publishedAt: p.published_at || null,
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
  // Stored names are random; the original upload name comes from the API.
  const names = b.file_names || {}
  const base = (_url, key) => names[key] || ''
  const out = []
  if (b.quotation_document_url) out.push({ label: 'Quotation Document', name: base(b.quotation_document_url, 'quotation_document'), url: b.quotation_document_url })
  if (b.technical_document_url) out.push({ label: 'Technical Proposal', name: base(b.technical_document_url, 'technical_document'), url: b.technical_document_url })
  if (b.supplier_product_image_url) out.push({ label: 'Product Image', name: base(b.supplier_product_image_url, 'supplier_product_image'), url: b.supplier_product_image_url })
  if (b.supplier_datasheet_url) out.push({ label: 'Product Datasheet', name: base(b.supplier_datasheet_url, 'supplier_datasheet'), url: b.supplier_datasheet_url })
  if (b.supplier_compliance_doc_url) out.push({ label: 'Compliance Document', name: base(b.supplier_compliance_doc_url, 'supplier_compliance_doc'), url: b.supplier_compliance_doc_url })
  ;(b.attachments || []).forEach(a => out.push({ label: 'Other Attachment', name: a.file_name, url: a.url }))
  return out
}
const mapBid = (b) => ({
  id: b.id, project: b.project_name, projectId: b.project_code, projectPk: b.project, category: b.project_category,
  amount: fmtPeso(b.amount), amountRaw: Number(b.amount || 0),
  submitted: fmtDate(b.submitted_at), submittedAt: b.submitted_at, status: b.status, notes: b.notes,
  deliveryTimeline: b.delivery_timeline || '',
  brandName: b.brand_name || '', modelNumber: b.model_number || '',
  additionalComments: b.additional_comments || '',
  files: collectBidFiles(b),
  documents: b.documents || [],  // per-document review state (flag/approve/resubmit)
  // Blockchain anchors for THIS bid. Only a winning bid has one (BID_SUBMITTED,
  // written at award time); every other bid is a database record only.
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
// Lists the documents the admin flagged and lets the supplier re-upload + resubmit.
function RevisionPanel({ profile, onResubmitted, setToast }) {
  const flagged = (profile?.documents || []).filter(d => d.review_status === 'needs_revision')
  const [files, setFiles] = useState({})  // { key: File }
  const [expiries, setExpiries] = useState({})  // { key: 'yyyy-mm-dd' } for category licenses
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
    const past = flagged.map(d => pastExpiryProblem(d.label, expiries[d.key])).find(Boolean)
    if (past) { setToast({ type: 'error', message: past }); setConfirm(false); return }
    setBusy(true)
    try {
      const fd = new FormData()
      Object.entries(files).forEach(([k, file]) => {
        fd.append(k, file)
        if (expiries[k]) fd.append(`${k}_expiry`, expiries[k])
      })
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
        <div><h2>Documents Needing Revision</h2><p>Re-upload them, then resubmit for review.</p></div>
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
                  <LocalPreviewButton file={files[d.key]} className="sd-file-preview" />
                  <button onClick={() => setFiles(f => { const n = { ...f }; delete n[d.key]; return n })}><X size={14} /></button>
                </div>
              ) : (
                <button className="sd-reupload-btn" onClick={() => refs.current[d.key]?.click()}>
                  <Upload size={14} /> Re-upload
                </button>
              )}
              <input ref={el => (refs.current[d.key] = el)} type="file" accept=".pdf,.jpg,.jpeg,.png" hidden
                onChange={e => onFile(d.key, e.target.files[0])} />
              {d.source === 'category' && d.has_expiry && (
                <label className="cd-expiry">
                  <span>New expiry date</span>
                  <input type="date" min={todayIso()} value={expiries[d.key] || ''}
                    onChange={e => setExpiries(x => ({ ...x, [d.key]: e.target.value }))} />
                </label>
              )}
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
// ── Supplier home: opportunities, bids and document health ───────────────────

const NEW_WINDOW_MS = 48 * 60 * 60 * 1000
// What the supplier must do next, per verification status.
function AccountStatusBanner({ profile }) {
  if (!profile || profile.qualification_status === 'verified') return null
  const qs = profile.qualification_status
  const missing = (profile.documents || []).filter(d => d.missing).length
  if (qs === 'rejected') {
    return (
      <div className="rf-banner rf-banner--danger" role="status">
        <span className="rf-banner-icon" aria-hidden="true"><XCircle size={18} /></span>
        <div>
          <strong>Your registration was not approved</strong>
          <p>{profile.admin_notes ? `Reason from the BAC office: “${profile.admin_notes}”` : 'The BAC office did not give a reason.'} Contact the procurement office if you believe this is a mistake.</p>
        </div>
      </div>
    )
  }
  if (qs === 'needs_revision') {
    const flagged = (profile.documents || []).filter(d => d.review_status === 'needs_revision').length
    if (!flagged) {
      return (
        <div className="rf-banner rf-banner--warning" role="status">
          <span className="rf-banner-icon" aria-hidden="true"><AlertTriangle size={18} /></span>
          <div>
            <strong>Action needed on your registration</strong>
            <p>{profile.admin_notes ? `The BAC office says: “${profile.admin_notes}”` : 'The BAC office asked for changes to your registration.'} Contact the procurement office if anything is unclear.</p>
          </div>
        </div>
      )
    }
    return (
      <div className="rf-banner rf-banner--warning" role="status">
        <span className="rf-banner-icon" aria-hidden="true"><AlertTriangle size={18} /></span>
        <div>
          <strong>Action needed: fix the flagged documents</strong>
          <p>The BAC office needs some documents replaced. Bidding unlocks once they verify the new files.</p>
          <ol>
            <li>Open <b>Documents Needing Revision</b> below and re-upload each flagged file.</li>
            <li>Select <b>Resubmit for Review</b>. Your account returns to the review queue.</li>
          </ol>
        </div>
        <a href="#doc-revision" className="ui-btn ui-btn--primary ui-btn--sm">Fix documents</a>
      </div>
    )
  }
  return (
    <div className="rf-banner rf-banner--info" role="status">
      <span className="rf-banner-icon" aria-hidden="true"><Clock size={18} /></span>
      <div>
        <strong>Your account is waiting for verification</strong>
        <p>You can browse opportunities now and bid once the BAC office verifies you. To avoid delays:</p>
        <ol>
          {!profile.email_verified && <li>Confirm your email address with the link we sent you.</li>}
          <li>{missing ? `Upload the ${missing} required document${missing === 1 ? '' : 's'} still missing (see Document health).` : 'Keep your documents current — all required documents are on file.'}</li>
          <li>Wait for the review. You will be emailed when a decision is made.</li>
        </ol>
      </div>
      <Link to="/supplier/profile" className="ui-btn ui-btn--secondary ui-btn--sm">My documents</Link>
    </div>
  )
}
// Submitted → Under evaluation → Qualified/Disqualified → Won/Not selected
function bidSteps(b) {
  const awardedElsewhere = b.projectStatus === 'awarded' && b.status !== 'winner'
  const s = (label, state) => ({ label, state })
  if (b.status === 'winner') return [s('Submitted', 'done'), s('Evaluated', 'done'), s('Qualified', 'done'), s('Won', 'done')]
  if (b.status === 'disqualified') return [s('Submitted', 'done'), s('Evaluated', 'done'), s('Disqualified', 'bad')]
  if (b.status === 'qualified') return [s('Submitted', 'done'), s('Evaluated', 'done'), s('Qualified', 'done'),
    awardedElsewhere ? s('Not selected', 'bad') : s('Won / Not selected', 'current')]
  return [s('Submitted', 'done'), awardedElsewhere ? s('Not selected', 'bad') : s('Under evaluation', 'current'),
    s('Qualified / Disqualified', 'upcoming'), s('Won / Not selected', 'upcoming')]
}
function MiniSteps({ steps }) {
  return (
    <ol className="rf-mini-steps" aria-label="Bid progress">
      {steps.map(st => (
        <li key={st.label} className={`is-${st.state}`}>
          <span className="rf-mini-dot" aria-hidden="true" />{st.label}
          <span className="sr-only"> ({st.state === 'done' ? 'done' : st.state === 'current' ? 'current' : st.state === 'bad' ? 'outcome' : 'not yet'})</span>
        </li>
      ))}
    </ol>
  )
}
// Documents that need attention, most serious first.
function docProblems(profile) {
  const out = []
  for (const d of profile?.documents || []) {
    if (d.review_status === 'needs_revision') out.push({ d, tone: 'danger', note: `Flagged by the BAC office${d.review_note ? `: “${d.review_note}”` : ''}`, rank: 0 })
    else if (d.expired) out.push({ d, tone: 'danger', note: d.expiry_date ? `Expired ${fmtDate(d.expiry_date)}` : 'Expired', rank: 1 })
    else if (d.missing) out.push({ d, tone: 'danger', note: d.reason === 'file missing from storage' ? 'File is missing — upload it again' : 'Required — not uploaded yet', rank: 2 })
    else if (d.expiring_soon) out.push({ d, tone: 'warning', note: `Expires ${fmtDate(d.expiry_date)}${d.days_left != null ? ` · in ${d.days_left} day${d.days_left === 1 ? '' : 's'}` : ''}`, rank: 3 })
  }
  return out.sort((a, b) => a.rank - b.rank)
}
const DOC_LIMIT = 4
const OPP_LIMIT = 4
const BID_LIMIT = 5
function DocumentHealth({ profile, setToast, onUploaded }) {
  const [showAll, setShowAll] = useState(false)
  if (!profile) return <div className="rf-card-body"><ListSkeleton rows={3} height={36} /></div>
  const problems = docProblems(profile)
  const total = (profile.documents || []).filter(d => d.required).length
  const ok = total - (profile.documents || []).filter(d => d.required && (d.missing || d.expired || d.review_status === 'needs_revision')).length
  const inRevision = profile.qualification_status === 'needs_revision'
  const shownProblems = showAll ? problems : problems.slice(0, DOC_LIMIT)
  return (
    <>
      <dl className="rf-stat-line">
        <div><dt>Verification</dt><dd><StatusBadge domain="qualification" status={profile.qualification_status} /></dd></div>
        <div><dt>Required documents in order</dt><dd>{ok} of {total}</dd></div>
      </dl>
      {problems.length === 0 ? (
        <EmptyState compact icon={ShieldCheck} title="All documents in order"
          description="Nothing is missing, flagged or expiring in the next 30 days." />
      ) : (
        <>
        <ul className="rf-doc-list">
          {shownProblems.map(({ d, tone, note }) => (
            <li key={d.key} className="rf-doc-row">
              <span className={`rf-attn-icon rf-tone-${tone}`} aria-hidden="true">
                {tone === 'danger' ? <AlertTriangle size={15} /> : <Clock size={15} />}
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="rf-doc-name" style={{ display: 'block' }}>{d.label}</span>
                <span className="rf-doc-note">{note}</span>
              </span>
              <span>
                {inRevision && d.review_status === 'needs_revision' ? (
                  <a href="#doc-revision" className="ui-btn ui-btn--secondary ui-btn--sm"><Upload size={13} /> Re-upload</a>
                ) : canUploadCategoryDoc(d, profile) ? (
                  <CategoryDocUpload doc={d} setToast={setToast} onUploaded={onUploaded} />
                ) : (
                  <Link to="/supplier/profile" className="ui-btn ui-btn--ghost ui-btn--sm"
                    title="Base registration documents are replaced when the BAC office requests a revision">
                    <Upload size={13} /> Upload
                  </Link>
                )}
              </span>
            </li>
          ))}
        </ul>
        {problems.length > DOC_LIMIT && (
          <div className="dash-more">
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setShowAll(v => !v)} aria-expanded={showAll}>
              {showAll ? 'Show fewer' : `Show all ${problems.length}`}
            </button>
          </div>
        )}
        </>
      )}
    </>
  )
}
// The last six months as "YYYY-MM", oldest first.
function lastSixMonths() {
  const out = []
  const d = new Date()
  d.setDate(1)
  for (let i = 0; i < 6; i++) {
    out.unshift(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    d.setMonth(d.getMonth() - 1)
  }
  return out
}
// How the supplier's bids are doing, in one panel with a tab per picture:
// outcome of every bid, and bids submitted per month with how many were won.
function SupplierCharts({ bids, loading }) {
  if (loading && !bids.length) {
    return <Panel title="My bid performance"><div className="rf-card-body"><Skeleton height={180} radius={8} /></div></Panel>
  }
  const won = bids.filter(b => b.status === 'winner').length
  const disq = bids.filter(b => b.status === 'disqualified').length
  const lost = bids.filter(b => b.status !== 'winner' && b.status !== 'disqualified' && b.projectStatus === 'awarded').length
  const pending = bids.length - won - disq - lost
  const months = lastSixMonths()
  const perMonth = Object.fromEntries(months.map(m => [m, { submitted: 0, won: 0 }]))
  bids.forEach(b => {
    const m = String(b.submittedAt || '').slice(0, 7)
    if (perMonth[m]) {
      perMonth[m].submitted += 1
      if (b.status === 'winner') perMonth[m].won += 1
    }
  })
  return (
    <TabbedPanel title="My bid performance" link={{ to: '/supplier/reports', label: 'Reports' }} tabs={[
      {
        key: 'outcome', label: 'By outcome', render: () => (
          <div className="ch-card-body">
            {!bids.length ? <p className="rf-muted" style={{ margin: 0 }}>Your bids will be charted here once you submit one.</p> : (
              <DonutChart ariaLabel="My bids by outcome" centerLabel="bids" size={128}
                data={[
                  { label: 'Won', value: won, color: STATUS.success },
                  { label: 'Still being evaluated', value: pending, color: STATUS.info },
                  { label: 'Not selected', value: lost, color: STATUS.neutral },
                  { label: 'Disqualified', value: disq, color: STATUS.danger },
                ]} />
            )}
          </div>
        ),
      },
      {
        key: 'month', label: 'Per month', render: () => (
          <div className="ch-card-body">
            <ColumnChart ariaLabel="Bids submitted and won per month" height={160}
              series={[{ key: 'submitted', label: 'Submitted' }, { key: 'won', label: 'Won' }]}
              data={months.map(m => ({ label: monthLabel(m), values: perMonth[m] }))} />
          </div>
        ),
      },
    ]} />
  )
}
function SupplierHome({ projects, bids, awards = [], failed = {}, onBid, eligible, profile, onResubmitted, setToast, loadingProjects, loadingBids }) {
  const now = useNow()
  const [modal, setModal] = useState(null)
  const [preview, setPreview] = useState(null)   // { images, index, title }
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState('deadline')
  const u = storedUser()
  const bidByProject = Object.fromEntries(bids.map(b => [b.projectId, b]))

  const open = projects.filter(p => !p.isExpired)
  const isNew = (p) => p.publishedAt && now - new Date(p.publishedAt).getTime() < NEW_WINDOW_MS
  const categories = [...new Set(open.map(p => p.category).filter(Boolean))].sort()
  const feed = open
    .filter(p => category === 'all' || p.category === category)
    .sort((a, b) => sort === 'abc_desc' ? b.budgetRaw - a.budgetRaw
      : sort === 'abc_asc' ? a.budgetRaw - b.budgetRaw
      : String(a.deadlineRaw).localeCompare(String(b.deadlineRaw)))

  const won = bids.filter(b => b.status === 'winner')
  const active = bids.filter(b => ['under_review', 'qualified'].includes(b.status) && b.projectStatus !== 'awarded')
  const decided = bids.filter(b => b.status === 'winner' || b.status === 'disqualified' || b.projectStatus === 'awarded')
  const winRate = decided.length ? Math.round((won.length / decided.length) * 100) : null
  const problems = docProblems(profile)
  const newCount = open.filter(isNew).length

  const receiptFor = (b) => {
    const award = awards.find(a => a.bid === b.id || a.project_code === b.projectId)
    // Only a transaction the server has verified counts as a receipt.
    return (award?.anchors || []).find(a => a.stage === 'AWARDED' && isVerified(a))
  }

  return (
    <div className="sd-content rf-home">
      {modal && <Suspense fallback={null}><BidModal project={modal} profile={profile} onClose={() => setModal(null)} onSubmit={onBid} /></Suspense>}

      <DashHeader name={profile?.representative_name || profile?.full_name || u.full_name || 'Supplier'}
        actions={<Link to="/supplier/projects" className="ui-btn ui-btn--primary ui-btn--sm"><FolderOpen size={13} aria-hidden="true" /> All opportunities</Link>} />

      <AccountStatusBanner profile={profile} />
      <EmailVerifyBanner profile={profile} setToast={setToast} />
      <div id="doc-revision" style={{ scrollMarginTop: 80 }}>
        <RevisionPanel profile={profile} onResubmitted={onResubmitted} setToast={setToast} />
      </div>

      {(failed.projects || failed.bids) && (
        <div className="ui-callout ui-callout--danger" role="alert">
          <AlertTriangle size={18} className="ui-callout-icon" />
          <div>
            <div className="ui-callout-title">Some of your data could not load</div>
            <p>{failed.projects ? 'Opportunities' : 'Your bids'} could not be loaded. Refresh the page to try again.</p>
          </div>
        </div>
      )}
      <KpiRow cols={4}>
        <KpiCard label="Open opportunities" icon={FolderOpen} tone="info" loading={loadingProjects}
          value={failed.projects ? '—' : open.length} to="/supplier/projects"
          context={newCount ? `${newCount} new in 48 hours` : 'In your categories'} />
        <KpiCard label="My active bids" icon={FileText} loading={loadingBids} value={failed.bids ? '—' : active.length} to="/supplier/bids"
          context={`${active.filter(b => b.status === 'under_review').length} under evaluation`} />
        {/* Win rate used to be its own card; it describes these same bids. */}
        <KpiCard label="Bids won" icon={Trophy} tone={won.length ? 'success' : 'neutral'} loading={loadingBids}
          value={failed.bids ? '—' : won.length} to="/supplier/bids"
          title={decided.length ? `Win rate ${winRate}%: ${won.length} of ${decided.length} decided bid${decided.length === 1 ? '' : 's'}` : undefined}
          context={won.length
            ? `${winRate}% win rate · ${pesoCompact(won.reduce((s, b) => s + b.amountRaw, 0))}`
            : decided.length ? `0 of ${decided.length} decided bid${decided.length === 1 ? '' : 's'}` : 'No awards yet'} />
        <KpiCard label="Documents to fix" icon={AlertTriangle} loading={!profile}
          tone={problems.some(p => p.tone === 'danger') ? 'danger' : problems.length ? 'warning' : 'neutral'}
          value={problems.length} to="/supplier/profile"
          context={problems.length ? 'Missing, flagged or expiring' : 'All in order'} />
      </KpiRow>

      <DashGrid main={<>
      <Panel id="opp" title="Opportunities for you" count={feed.length} countTone="info"
        actions={open.length > 0 && (
            <div className="rf-filterbar">
              <label>Category
                <select className="rf-select" value={category} onChange={e => setCategory(e.target.value)}>
                  <option value="all">All categories</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label>Sort
                <select className="rf-select" value={sort} onChange={e => setSort(e.target.value)}>
                  <option value="deadline">Deadline (soonest)</option>
                  <option value="abc_desc">ABC (highest)</option>
                  <option value="abc_asc">ABC (lowest)</option>
                </select>
              </label>
            </div>
          )}>
        {loadingProjects && projects.length === 0 ? (
          <div className="rf-opp-grid">{[0, 1, 2].map(i => <Skeleton key={i} height={170} radius={12} />)}</div>
        ) : feed.length === 0 ? (
          <EmptyState icon={FolderOpen} title="No open procurements in your categories"
            description="New biddings appear here when published."
            action={<>
              <Link to="/public" className="ui-btn ui-btn--secondary ui-btn--sm">Browse all public biddings</Link>
              <Link to="/supplier/settings" className="ui-btn ui-btn--ghost ui-btn--sm">Review my categories</Link>
            </>} />
        ) : (
          <>
          <div className="rf-opp-grid">
            {feed.slice(0, OPP_LIMIT).map(p => {
              const mine = bidByProject[p.id]
              return (
                <article key={p.id} className="rf-opp">
                  <div className="rf-opp-top">
                    <Thumbnail src={p.referenceImage} size={64} category={p.category}
                      alt={`Reference image for ${p.id} ${p.name}`}
                      onOpen={() => setPreview({ images: [{ url: p.referenceImage, caption: `${p.id} · ${p.name}` }], index: 0, title: 'Reference image' })} />
                    <div style={{ minWidth: 0 }}>
                      <div className="rf-opp-tags">
                        <span className="rf-code">{p.id}</span>
                        {isNew(p) && <span className="rf-new-tag">New</span>}
                        <span className="rf-muted" style={{ fontSize: 'var(--fs-caption)' }}>{p.category}</span>
                      </div>
                      <h4 className="rf-opp-title">{p.name}</h4>
                    </div>
                  </div>
                  <div className="rf-opp-meta">
                    <div className="rf-opp-abc"><small>Approved budget (ABC)</small><strong>{peso(p.budgetRaw)}</strong></div>
                    <Countdown deadline={p.deadlineRaw} />
                  </div>
                  <div className="rf-opp-actions">
                    {mine ? (
                      <Link to="/supplier/bids" className="ui-btn ui-btn--secondary ui-btn--sm"><CheckCircle2 size={13} /> Bid submitted · view</Link>
                    ) : eligible ? (
                      <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => setModal(p)}>
                        View &amp; bid <ArrowRight size={13} />
                      </button>
                    ) : (
                      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled title="Bidding unlocks once your account is verified">
                        <Lock size={13} /> Locked until verified
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
          {feed.length > OPP_LIMIT && (
            <p className="dash-note">
              Showing {OPP_LIMIT} of {feed.length}.{' '}
              <Link to="/supplier/projects" className="rf-card-link">All opportunities</Link>
            </p>
          )}
          </>
        )}
      </Panel>

        <Panel id="mybids" title="My bids" link={bids.length > 0 ? { to: '/supplier/bids', label: 'All bids' } : undefined}>
          {loadingBids && bids.length === 0 ? (
            <div className="rf-card-body"><ListSkeleton rows={2} height={60} /></div>
          ) : bids.length === 0 ? (
            <EmptyState compact icon={FileText} title="No bids yet"
              description={eligible ? 'Pick an opportunity above and submit your first bid.' : 'Once your account is verified you can start bidding.'} />
          ) : (
            <ul className="rf-list">
              {bids.slice(0, BID_LIMIT).map(b => {
                const receipt = b.status === 'winner' ? receiptFor(b) : null
                const imgs = b.productImages || []
                return (
                  <li key={b.id} className="rf-bid-row">
                    <Thumbnail src={imgs[0]?.url} size={48} category={b.category}
                      alt={`Product image on your bid for ${b.projectId}`} badge={imgs.length > 1 ? `+${imgs.length - 1}` : null}
                      onOpen={() => setPreview({ images: imgs.map((i, n) => ({ url: i.url, caption: i.caption || `Product image ${n + 1}` })), index: 0, title: `${b.projectId} · your product images` })} />
                    <div style={{ minWidth: 0 }}>
                      <div className="rf-list-title">{b.project}</div>
                      <div className="rf-list-sub"><span className="rf-code">{b.projectId}</span>Submitted <RelativeTime value={b.submittedAt} /></div>
                      <MiniSteps steps={bidSteps(b)} />
                    </div>
                    <div className="rf-list-side">
                      <span className="rf-amount">{peso(b.amountRaw)}</span>
                      {b.status === 'winner' && (receipt ? (
                        <a className="rf-receipt" href={receipt.explorer_url} target="_blank" rel="noopener noreferrer"
                          title={`Award transaction ${receipt.tx_hash} on Etherscan`}>
                          <ShieldCheck size={13} aria-hidden="true" /> Blockchain receipt
                        </a>
                      ) : <span className="rf-muted" style={{ fontSize: 'var(--fs-caption)' }}>Receipt pending</span>)}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
      </>} side={<>
        <Panel id="docs" title="Document health" link={{ to: '/supplier/profile', label: 'My documents' }}>
          <DocumentHealth profile={profile} setToast={setToast} onUploaded={onResubmitted} />
        </Panel>
        {!failed.bids && <SupplierCharts bids={bids} loading={loadingBids} />}
      </>} />

      {preview && (
        <Lightbox images={preview.images} index={preview.index} title={preview.title}
          onIndex={(i) => setPreview(pv => ({ ...pv, index: i }))} onClose={() => setPreview(null)} />
      )}
    </div>
  )
}
// ─── Root ─────────────────────────────────────────────────────────────────────

// Cached so the supplier's profile shows instantly on revisit instead of
// flashing empty while it refetches.
const MY_PROFILE_CACHE = 'supplier:profile'
// The same for the lists, stored already mapped for the UI. Going back to the
// dashboard shows them at once while they refresh in the background.
const MY_PROJECTS_CACHE = 'supplier:projects'
const MY_BIDS_CACHE = 'supplier:bids'
const MY_AWARDS_CACHE = 'supplier:awards'
export default function SupplierDashboard() {
  const loc = useLocation()
  const navigate = useNavigate()
  const [profile, setProfile] = useState(() => getCached(MY_PROFILE_CACHE) ?? null)
  const [profileError, setProfileError] = useState('')
  const [loadingProfile, setLoadingProfile] = useState(() => getCached(MY_PROFILE_CACHE) === undefined)
  const [projects, setProjects] = useState(() => getCached(MY_PROJECTS_CACHE) || [])   // eligible (published + category match)
  const [bids, setBids] = useState(() => getCached(MY_BIDS_CACHE) || [])
  const [awards, setAwards] = useState(() => getCached(MY_AWARDS_CACHE) || [])       // this supplier's own awards only
  // Skeletons only while there is nothing to show. A background refresh keeps
  // the last list on screen.
  const [loadingProjects, setLoadingProjects] = useState(() => getCached(MY_PROJECTS_CACHE) === undefined)
  const [loadingBids, setLoadingBids] = useState(() => getCached(MY_BIDS_CACHE) === undefined)
  // Which lists failed to load, so the home shows "—" instead of a false 0.
  const [loadFailed, setLoadFailed] = useState({ projects: false, bids: false })
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
    return loadCached(MY_PROFILE_CACHE, apiGetMySupplier)
      .then(setProfile)
      .catch(err => {
        // Keep showing the cached profile if a background refresh fails; only
        // report the error when there is nothing to fall back on.
        if (getCached(MY_PROFILE_CACHE) === undefined) {
          setProfile(null)
          setProfileError(err?.message || 'Could not load your profile.')
        }
      })
      .finally(() => setLoadingProfile(false))
  }
  // Backend returns only the projects this supplier is eligible for.
  // A failed refresh only counts as "failed" (shown as —) when there is no
  // earlier list to keep showing.
  const loadProjects = () => {
    if (getCached(MY_PROJECTS_CACHE) === undefined) setLoadingProjects(true)
    loadCached(MY_PROJECTS_CACHE, () => apiListProjects().then(d => d.map(mapProject)))
      .then(list => { setProjects(list); setLoadFailed(f => ({ ...f, projects: false })) })
      .catch(() => { if (getCached(MY_PROJECTS_CACHE) === undefined) setLoadFailed(f => ({ ...f, projects: true })) })
      .finally(() => setLoadingProjects(false))
  }
  const loadBids = () => {
    if (getCached(MY_BIDS_CACHE) === undefined) setLoadingBids(true)
    loadCached(MY_BIDS_CACHE, () => apiListMyBids().then(d => d.map(mapBid)))
      .then(list => { setBids(list); setLoadFailed(f => ({ ...f, bids: false })) })
      .catch(() => { if (getCached(MY_BIDS_CACHE) === undefined) setLoadFailed(f => ({ ...f, bids: true })) })
      .finally(() => setLoadingBids(false))
  }
  // The supplier's OWN awards (scoped server-side) — this is how the winner
  // receives the Notice of Award addressed to them, along with the BAC
  // Resolution and Notice to Proceed. Silently ignored on failure: a supplier
  // who has never won simply has none.
  const loadAwards = () => {
    loadCached(MY_AWARDS_CACHE, apiListAwards)
      .then(setAwards)
      .catch(() => { if (getCached(MY_AWARDS_CACHE) === undefined) setAwards([]) })
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

  // A verified supplier is likely to open the bid form, so fetch its code while
  // the browser is idle. The first "Bid" click then opens it at once.
  useEffect(() => {
    if (!eligible) return
    const load = () => { import('./supplier/BidModal').catch(() => {}) }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(load, { timeout: 4000 })
      return () => window.cancelIdleCallback?.(id)
    }
    const t = setTimeout(load, 1500)
    return () => clearTimeout(t)
  }, [eligible])

  // Returns true on success so the modal can close itself (and stay open with the
  // error toast on failure). `formData` is the multipart payload built in BidModal.
  const submitBid = async (project, formData) => {
    try {
      await apiSubmitBid(project.pk, formData)
      loadBids()
      setToast({ type: 'success', message: 'Bid submitted successfully.' })
      // Nothing to sign here: bids are not anchored on submission, so a losing
      // supplier's amount never reaches the public ledger. The bids are
      // committed on-chain together when the winner is selected.
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
  const title = Object.entries(TITLES).find(([path]) => loc.pathname === path)?.[1]
    || (loc.pathname.startsWith('/supplier/record/') ? 'Procurement Record' : 'Dashboard')

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
          {/* Only the page area waits for a section's code; the sidebar and
              header above stay on screen. */}
          <Suspense fallback={<PageSkeleton className="sd-content" />}>
          <Routes>
            <Route index element={<SupplierHome projects={projects} bids={bids} awards={awards} failed={loadFailed} onBid={submitBid} eligible={eligible} profile={profile} onResubmitted={loadProfile} setToast={setToast} loadingProjects={loadingProjects} loadingBids={loadingBids} />} />
            <Route path="projects" element={<SupplierProjects projects={projects} bids={bids} onBid={submitBid} eligible={eligible} loading={loadingProjects} profile={profile} />} />
            <Route path="bids"     element={<SupplierBids bids={bids} awards={awards} onWithdraw={withdrawBid} loading={loadingBids} onResubmitted={loadBids} setToast={setToast} />} />
            <Route path="status"   element={<SupplierStatusPage bids={bids} profile={profile} eligible={eligible} setToast={setToast} />} />
            <Route path="reports"  element={<SupplierReportsPage bids={bids} profile={profile} />} />
            <Route path="record/:id" element={<ProcurementRecordPage className="sd-content" backTo="/supplier/bids" backLabel="Back to my bids" />} />
            <Route path="record/:id/anchor/:anchorId" element={<ProjectAnchorDetailPage className="sd-content" />} />
            <Route path="profile"  element={<SupplierProfile profile={profile} eligible={eligible} loading={loadingProfile} error={profileError} onRetry={loadProfile} setToast={setToast} onUpdated={() => Promise.all([loadProfile(), loadProjects()])} />} />
            <Route path="settings" element={<SupplierSettings profile={profile} setToast={setToast} onUpdated={() => Promise.all([loadProfile(), loadProjects()])} loading={loadingProfile} error={profileError} onRetry={loadProfile} />} />
            <Route path="*"        element={<SupplierHome projects={projects} bids={bids} awards={awards} failed={loadFailed} onBid={submitBid} eligible={eligible} profile={profile} onResubmitted={loadProfile} setToast={setToast} loadingProjects={loadingProjects} loadingBids={loadingBids} />} />
          </Routes>
          </Suspense>
        </div>
      </div>
      {/* Anchoring feedback for the supplier's own bid submissions. At the
          layout root so it survives navigation while MetaMask is open. */}
      <AnchorActivity />
      <Toaster />
    </div>
  )
}
