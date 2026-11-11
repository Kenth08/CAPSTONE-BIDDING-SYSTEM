import { useState, useEffect } from 'react'
import { apiUpdateMySupplier, apiChangePassword, apiUploadCategoryDocuments } from '../../api'
import { useCategories } from '../../store/categoriesStore'
import CategoryDocumentFields, { appendCategoryDocs, categoryDocsProblem, useCategoryDocState, useCategoryRequirements } from '../../components/CategoryDocuments'
import { ListSkeleton } from '../../components/Skeleton'
import { isVerified } from '../../blockchain/anchorState'
import {
  CategoryRequestBanner, EmailVerifyBanner, ProfileLoadError, profileBusinessTypes,
} from './shared'

export default function SupplierSettings({ profile, setToast, onUpdated, loading, error, onRetry }) {
  const allCategories = useCategories()
  const [fullName, setFullName] = useState('')   // display name on record
  const [nameParts, setNameParts] = useState({ first_name: '', middle_name: '', last_name: '' })
  const [repName, setRepName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [businessTypes, setBusinessTypes] = useState([])
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState('')

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)

  const [withdrawing, setWithdrawing] = useState(false)
  const isVerified = profile?.qualification_status === 'verified'

  // Licenses for categories being ADDED (not the approved ones). Anything the
  // supplier already uploaded for them (e.g. with an earlier request) is skipped.
  const approvedTypes = profile ? profileBusinessTypes(profile) : []
  const addedTypes = businessTypes.filter(t => !approvedTypes.includes(t))
  const addedReq = useCategoryRequirements(addedTypes)
  const addedDocState = useCategoryDocState()
  const onFile = new Set((profile?.documents || []).filter(d => d.present).map(d => d.key))
  const newDocsReq = { ...addedReq, docs: addedReq.docs.filter(d => !onFile.has(d.key)) }

  useEffect(() => {
    if (!profile) return
    setFullName(profile.full_name || profile.contact || '')
    setNameParts({ first_name: profile.first_name || '', middle_name: profile.middle_name || '', last_name: profile.last_name || '' })
    setRepName(profile.representative_name || '')
    setPhone(profile.phone_number || '')
    setAddress(profile.company_address || '')
    // Show the pending request's selection while it awaits approval, so the
    // supplier edits their request rather than silently reverting it.
    setBusinessTypes(
      profile.category_request_status === 'pending' && Array.isArray(profile.pending_business_types)
        ? profile.pending_business_types
        : profileBusinessTypes(profile)
    )
  }, [profile])

  // Re-sending the approved list withdraws a pending request (server-side rule).
  const withdrawRequest = async () => {
    setWithdrawing(true)
    try {
      await apiUpdateMySupplier({ business_types: profileBusinessTypes(profile) })
      await onUpdated()
      setToast({ type: 'success', message: 'Category change request withdrawn.' })
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not withdraw the request.' })
    } finally {
      setWithdrawing(false)
    }
  }

  const toggleBusinessType = (t) =>
    setBusinessTypes(list => list.includes(t) ? list.filter(x => x !== t) : [...list, t])

  const saveProfile = async (e) => {
    e.preventDefault()
    setProfileError('')
    if (businessTypes.length === 0) {
      setProfileError('Select at least one business type.')
      return
    }
    if (addedReq.loading) { setProfileError('Still checking which documents the new categories need.'); return }
    const docProblem = categoryDocsProblem(newDocsReq.docs, addedDocState.files, addedDocState.expiries)
    if (docProblem) { setProfileError(docProblem); return }
    setSavingProfile(true)
    try {
      const before = profile?.category_request_status || ''
      const saved = await apiUpdateMySupplier({
        // Only when a part is filled in: an account from before the name split
        // keeps its name exactly as typed until the supplier enters the parts.
        ...(Object.values(nameParts).some(v => v.trim())
          ? Object.fromEntries(Object.entries(nameParts).map(([k, v]) => [k, v.trim()])) : {}),
        representative_name: repName.trim(),
        phone_number: phone.trim(),
        company_address: address.trim(),
        business_types: businessTypes,
      })
      // The licenses go up AFTER the request exists: the server only accepts
      // documents for categories that are approved or requested.
      const fd = new FormData()
      appendCategoryDocs(fd, newDocsReq.docs, addedDocState.files, addedDocState.expiries)
      if ([...fd.keys()].length > 0) {
        try {
          await apiUploadCategoryDocuments(fd)
          addedDocState.reset()
        } catch (err) {
          await onUpdated()
          setToast({
            type: 'error',
            message: `Your changes were saved, but the documents did not upload: ${err.message} You can upload them from My Profile.`,
          })
          return
        }
      }
      await onUpdated()
      const filedRequest = saved?.category_request_status === 'pending' &&
        (before !== 'pending' || saved?.category_requested_at !== profile?.category_requested_at)
      setToast({
        type: 'success',
        message: filedRequest
          ? 'Profile saved. Your category change was sent to the Admin for approval.'
          : 'Profile updated successfully.',
      })
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Could not update your profile.' })
    } finally {
      setSavingProfile(false)
    }
  }

  const savePassword = async (e) => {
    e.preventDefault()
    setPasswordError('')
    if (newPassword !== confirmPassword) { setPasswordError('New password and confirmation do not match.'); return }
    setSavingPassword(true)
    try {
      await apiChangePassword(currentPassword, newPassword)
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
      setToast({ type: 'success', message: 'Password changed successfully.' })
    } catch (err) {
      setPasswordError(err.message || 'Could not change your password.')
    } finally {
      setSavingPassword(false)
    }
  }

  // Changing your password only needs an account, not a company profile — so it
  // stays available even when the profile failed to load. Previously the whole
  // page was behind a `if (!profile) return <skeleton>` guard, which locked a
  // supplier out of their own password form whenever this request failed.
  const profileCard = !profile ? (
    error && !loading
      ? <ProfileLoadError message={error} onRetry={onRetry} retrying={loading} />
      : <div className="sd-card"><div style={{ padding: '40px 24px' }}><ListSkeleton rows={4} height={48} /></div></div>
  ) : (
    <div className="sd-card">
      <div className="sd-card-header">
        <div><h2>Edit Profile</h2></div>
      </div>
      <form className="sd-profile-form" onSubmit={saveProfile}>
        <div className="sd-form-group">
          <label htmlFor="sd-first-name">First Name</label>
          <input id="sd-first-name" type="text" autoComplete="given-name" value={nameParts.first_name}
            onChange={e => setNameParts(n => ({ ...n, first_name: e.target.value }))} />
        </div>
        <div className="sd-form-group">
          <label htmlFor="sd-middle-name">Middle Name (optional)</label>
          <input id="sd-middle-name" type="text" autoComplete="additional-name" value={nameParts.middle_name}
            onChange={e => setNameParts(n => ({ ...n, middle_name: e.target.value }))} />
        </div>
        <div className="sd-form-group">
          <label htmlFor="sd-last-name">Last Name</label>
          <input id="sd-last-name" type="text" autoComplete="family-name" value={nameParts.last_name}
            onChange={e => setNameParts(n => ({ ...n, last_name: e.target.value }))} />
          {!nameParts.first_name && !nameParts.last_name && fullName && (
            <small className="sd-muted">Name on record: {fullName}. Enter your first and last name to update it.</small>
          )}
        </div>
        <div className="sd-form-group">
          <label>Representative Name</label>
          <input type="text" value={repName} onChange={e => setRepName(e.target.value)} />
        </div>
        <div className="sd-form-group">
          <label>Phone Number</label>
          <input type="text" value={phone} onChange={e => setPhone(e.target.value)} />
        </div>
        <div className="sd-form-group">
          <label>Business Address</label>
          <input type="text" value={address} onChange={e => setAddress(e.target.value)} />
        </div>
        <div className="sd-form-group sd-profile-field-full">
          <label>Business Types</label>
          <span className="sd-muted sd-small" style={{ marginBottom: 6 }}>
            {isVerified
              ? 'Which procurements you can see and bid on. Changes need Admin approval; current categories stay active until then.'
              : 'Which procurements you can see and bid on. Reviewed with your registration.'}
          </span>
          <CategoryRequestBanner profile={profile} onWithdraw={withdrawRequest} withdrawing={withdrawing} />
          <div className="sd-chips">
            {allCategories.map(t => (
              <button
                type="button"
                key={t}
                className={`sd-chip sd-chip-toggle${businessTypes.includes(t) ? ' on' : ''}`}
                onClick={() => toggleBusinessType(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        {(addedReq.loading || addedReq.error || newDocsReq.docs.length > 0) && (
          <div className="sd-form-group sd-profile-field-full">
            <label>Documents for the new categories</label>
            <span className="sd-muted sd-small" style={{ marginBottom: 6 }}>
              {isVerified
                ? 'Upload these with your request. New categories need the required licenses on file.'
                : 'Upload these for review with your registration.'}
            </span>
            <CategoryDocumentFields req={newDocsReq} state={addedDocState} idPrefix="sd-catdoc"
              onError={msg => setToast({ type: 'error', message: msg })} />
          </div>
        )}
        {profileError && <span className="sd-field-error sd-profile-field-full">{profileError}</span>}
        <div className="sd-profile-actions">
          <button type="submit" className="sd-btn-primary" disabled={savingProfile}>
            {savingProfile ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  )

  return (
    <div className="sd-content">
      <EmailVerifyBanner profile={profile} setToast={setToast} />
      {profileCard}

      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>Change Password</h2></div>
        </div>
        <form className="sd-profile-form" onSubmit={savePassword}>
          <div className="sd-form-group sd-profile-field-full">
            <label>Current Password</label>
            <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required />
          </div>
          <div className="sd-form-group">
            <label>New Password</label>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
          </div>
          <div className="sd-form-group">
            <label>Confirm New Password</label>
            <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required />
          </div>
          {passwordError && <span className="sd-field-error sd-profile-field-full">{passwordError}</span>}
          <div className="sd-profile-actions">
            <button type="submit" className="sd-btn-primary" disabled={savingPassword}>
              {savingPassword ? 'Updating…' : 'Update Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
