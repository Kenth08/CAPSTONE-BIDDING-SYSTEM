import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, Copy, KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { apiMfaSetup, apiMfaVerify } from '../api'

/**
 * Second sign-in step for Admin and Head accounts (backend: accounts/mfa.py).
 *
 * `challenge` is what the password step returned: { mfa_token, mfa_enrolled }.
 *   - not enrolled → show a QR code + key to add to an authenticator app, then
 *     confirm the first code; the backend answers with tokens AND ten one-time
 *     backup codes, which are shown once before continuing;
 *   - enrolled     → ask for the current code (or a backup code).
 * `onDone(result)` receives { access, refresh, user } once signed in.
 */
export default function MfaStep({ challenge, onDone, onCancel }) {
  const enrolling = !challenge.mfa_enrolled
  const [setup, setSetup] = useState(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [backupResult, setBackupResult] = useState(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!enrolling) return
    apiMfaSetup(challenge.mfa_token).then(setSetup).catch((err) => setError(err.message))
  }, [enrolling, challenge.mfa_token])

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const result = await apiMfaVerify(challenge.mfa_token, code.trim())
      if (result.backup_codes?.length) setBackupResult(result)   // show them once first
      else onDone(result)
    } catch (err) {
      setError(err.message)
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  if (backupResult) {
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(backupResult.backup_codes.join('\n'))
        setCopied(true)
      } catch { /* clipboard blocked — the codes are on screen to copy by hand */ }
    }
    return (
      <div className="login-form mfa-step">
        <h1><ShieldCheck size={22} aria-hidden="true" /> Save your backup codes</h1>
        <p className="login-subtitle">
          Two-factor authentication is on. If you lose your phone, each of these codes signs you in
          once. They will not be shown again — store them somewhere safe.
        </p>
        <ul className="mfa-codes" aria-label="Backup codes">
          {backupResult.backup_codes.map((c) => <li key={c}><code>{c}</code></li>)}
        </ul>
        <button type="button" className="login-forgot mfa-link" onClick={copy}>
          <Copy size={14} aria-hidden="true" /> {copied ? 'Copied' : 'Copy all codes'}
        </button>
        <button type="button" className="login-submit" onClick={() => onDone(backupResult)}>
          I have saved my backup codes
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="login-form mfa-step">
      <h1><KeyRound size={22} aria-hidden="true" /> Two-factor sign-in</h1>
      {enrolling ? (
        <>
          <p className="login-subtitle">
            Admin and Head accounts need an authenticator app (Google Authenticator, Microsoft
            Authenticator, Authy…). Scan this code, then enter the 6-digit code it shows.
          </p>
          {setup ? (
            <div className="mfa-qr">
              <img src={setup.qr} alt="QR code to add this account to an authenticator app" width="180" height="180" />
              <p className="mfa-key">
                Can&apos;t scan? Enter this key: <code>{setup.secret.match(/.{1,4}/g).join(' ')}</code>
              </p>
            </div>
          ) : !error && <p className="login-subtitle"><Loader2 size={16} className="ui-spin" aria-hidden="true" /> Preparing…</p>}
        </>
      ) : (
        <p className="login-subtitle">Enter the 6-digit code from your authenticator app, or one of your backup codes.</p>
      )}

      <div className="form-group">
        <label htmlFor="mfa-code">Authentication code</label>
        <input id="mfa-code" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus
          placeholder="123 456" value={code} onChange={(e) => setCode(e.target.value)}
          required maxLength={16} aria-invalid={!!error} />
      </div>
      {error && (
        <div className="login-error" role="alert">
          <span className="login-error-msg"><AlertCircle size={15} aria-hidden="true" /> {error}</span>
        </div>
      )}
      <button type="submit" className="login-submit" disabled={busy || (enrolling && !setup)}>
        {busy ? <><Loader2 size={16} className="ui-spin" aria-hidden="true" /> Verifying…</> : 'Verify and sign in'}
      </button>
      <button type="button" className="login-forgot mfa-link" onClick={onCancel}>
        <ArrowLeft size={14} aria-hidden="true" /> Use a different account
      </button>
    </form>
  )
}
