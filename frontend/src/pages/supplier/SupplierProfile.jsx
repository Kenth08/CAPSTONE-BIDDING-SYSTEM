import { Clock, CheckCircle2, Eye, Lock } from 'lucide-react'
import { ListSkeleton } from '../../components/Skeleton'
import PreviewButton from '../../components/ui/FilePreview'
import {
  CategoryDocUpload, CategoryRequestBanner, EmailVerifyBanner, ProfileLoadError, canUploadCategoryDoc, profileBusinessTypes,
} from './shared'

const QUAL_STATUS = {
  waiting_admin_approval: { label: 'Pending Review', tone: 'pending', text: 'Awaiting admin verification. You can browse projects; bidding unlocks once approved.' },
  needs_revision:         { label: 'Action Required', tone: 'revision', text: 'Fix the documents below, then resubmit for review.' },
  verified:               { label: 'Approved', tone: 'approved', text: 'You can submit bids on open projects.' },
  rejected:               { label: 'Rejected', tone: 'rejected', text: 'Your registration was rejected. See the message below.' },
}
// Maps a document's review state to a badge — "not uploaded" wins over any
// stale review status, since a missing file can't meaningfully be "approved".
function docStatusBadge(doc) {
  if (!doc.url) return { label: 'Not Uploaded', cls: 'badge-gray' }
  if (doc.review_status === 'approved') return { label: 'Approved', cls: 'badge-green' }
  if (doc.review_status === 'needs_revision') return { label: 'Needs Revision', cls: 'badge-red' }
  if (doc.review_status === 'resubmitted') return { label: 'Resubmitted', cls: 'badge-blue' }
  return { label: 'Pending Review', cls: 'badge-yellow' }
}
// Only mayors_permit and tax_clearance_certificate carry an expiry date on the
// Supplier model — every other document type has none.
const DOC_EXPIRY_FIELD = {
  mayors_permit: 'mayors_permit_expiry',
  tax_clearance_certificate: 'tax_clearance_expiry',
}
function docExpiryInfo(doc, profile) {
  // Category licenses carry their own expiry date; base documents read it
  // from the supplier profile.
  const field = DOC_EXPIRY_FIELD[doc.key]
  const raw = doc.source === 'category' ? doc.expiry_date : (field ? profile?.[field] : null)
  if (!raw) return null
  const date = new Date(raw)
  const daysLeft = Math.ceil((date - new Date()) / (1000 * 60 * 60 * 24))
  return { date, expired: daysLeft < 0, expiringSoon: daysLeft >= 0 && daysLeft <= 30 }
}
export default function SupplierProfile({ profile, eligible, loading, error, onRetry, setToast, onUpdated }) {
  if (!profile) {
    return (
      <div className="sd-content">
        {error && !loading
          ? <ProfileLoadError message={error} onRetry={onRetry} retrying={loading} />
          : (
            <div className="sd-card">
              <div style={{ padding: '40px 24px' }}><ListSkeleton rows={4} height={48} /></div>
            </div>
          )}
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
      <EmailVerifyBanner profile={profile} setToast={setToast} />
      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>Company details</h2></div>
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
            <CategoryRequestBanner profile={profile} />
          </div>
        </div>
      </div>

      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>My Documents</h2></div>
        </div>
        <div className="sd-doc-list" style={{ padding: '8px 24px 20px' }}>
          {(profile.documents || []).map(d => {
            const badge = docStatusBadge(d)
            const expiry = docExpiryInfo(d, profile)
            const labelEl = (
              <span className="sd-file-rowname">
                {d.label}{!d.required && <span className="sd-optional"> (optional)</span>}
                {d.source === 'category' && (
                  <span className="cd-badge cd-badge-cat" style={{ marginLeft: 8 }}>
                    {d.category}{d.pending_category ? ' · requested' : ''}
                  </span>
                )}
              </span>
            )
            // Expired: red badge. Within 30 days: orange "Expires in X days".
            // Otherwise the plain date. The server decides both (d.expired,
            // d.expiring_soon), so the page and the approval rules agree.
            const expiryEl = d.expired ? (
              <span className="cd-badge cd-badge-missing">
                Expired {expiry ? expiry.date.toLocaleDateString() : ''} — please renew
              </span>
            ) : d.expiring_soon ? (
              <span className="cd-badge cd-badge-warn">
                Expires in {d.days_left} day{d.days_left === 1 ? '' : 's'}
              </span>
            ) : expiry && (
              <span className="sd-doc-expiry">Expires {expiry.date.toLocaleDateString()}</span>
            )
            // A "Missing" badge and an upload control right in the list, for
            // category licenses and for base documents that need renewing.
            // (A base document the BAC office flagged is replaced through the
            // revision panel instead.)
            if ((d.source === 'category' && d.missing) || canUploadCategoryDoc(d, profile)) {
              return (
                <div key={d.key} className={`sd-doc-row${d.url ? '' : ' sd-doc-row-missing'}`}>
                  {labelEl}
                  {d.expired
                    ? null /* the red "Expired — please renew" badge below says it */
                    : d.missing
                      ? <span className="cd-badge cd-badge-missing">Missing — please upload</span>
                      : <span className={`ui-badge ${badge.cls}`}><span className="ui-badge-dot" aria-hidden="true" />{badge.label}</span>}
                  {expiryEl}
                  {d.url && <PreviewButton url={d.url} name={d.label} className="sd-doc-view" />}
                  {d.url && <a className="sd-doc-view" href={d.url} target="_blank" rel="noreferrer"><Eye size={13} /> Download</a>}
                  {canUploadCategoryDoc(d, profile) && (
                    <CategoryDocUpload doc={d} setToast={setToast} onUploaded={onUpdated} />
                  )}
                </div>
              )
            }
            return d.url ? (
              <a key={d.key} className="sd-doc-row" href={d.url} target="_blank" rel="noreferrer">
                {labelEl}
                <span className={`ui-badge ${badge.cls}`}><span className="ui-badge-dot" aria-hidden="true" />{badge.label}</span>
                {expiryEl}
                <span className="sd-doc-view"><Eye size={13} /> View</span>
              </a>
            ) : (
              <div key={d.key} className="sd-doc-row sd-doc-row-missing">
                {labelEl}
                <span className={`ui-badge ${badge.cls}`}><span className="ui-badge-dot" aria-hidden="true" />{badge.label}</span>
                {expiryEl}
              </div>
            )
          })}
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
