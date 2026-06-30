import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Shield, ArrowLeft } from 'lucide-react'
import { apiVerifyEmail } from '../api'
import '../style/LoginPage.css'

export default function VerifyEmailPage() {
  const [params] = useSearchParams()
  const uid = params.get('uid') || ''
  const token = params.get('token') || ''

  const [status, setStatus] = useState(uid && token ? 'loading' : 'missing') // loading | done | error | missing
  const [error, setError] = useState('')

  useEffect(() => {
    if (status !== 'loading') return
    apiVerifyEmail(uid, token)
      .then(() => setStatus('done'))
      .catch(err => { setError(err.message); setStatus('error') })
  }, [status, uid, token])

  return (
    <div className="login-page">
      <div className="login-left">
        <div className="login-left-inner">
          <Link to="/login" className="login-back"><ArrowLeft size={16} /> Back to Login</Link>
          <div className="login-logo">
            <span className="lp-logo-icon"><Shield size={18} /></span>
            <div>
              <div className="lp-logo-name">E-Procurement</div>
              <div className="lp-logo-sub">Procurement System</div>
            </div>
          </div>
          <h1>Verify Email</h1>

          {status === 'missing' && (
            <>
              <p className="login-subtitle">This verification link is missing or malformed.</p>
              <div className="login-error"><span>Please use the link from your verification email, or resend it from your dashboard.</span></div>
            </>
          )}
          {status === 'loading' && (
            <p className="login-subtitle">Confirming your email address…</p>
          )}
          {status === 'done' && (
            <>
              <p className="login-subtitle">Your email address has been confirmed.</p>
              <div className="login-success">
                You're verified. <Link to="/login">Sign in</Link> to continue.
              </div>
            </>
          )}
          {status === 'error' && (
            <>
              <p className="login-subtitle">We couldn't verify your email.</p>
              <div className="login-error"><span>{error}</span></div>
            </>
          )}
        </div>
      </div>
      <div className="login-right">
        <div className="login-right-inner">
          <div className="login-quote-icon"><Shield size={32} /></div>
          <blockquote>
            "Fair procurement starts with transparent systems. Every request, every bid, every decision — tracked and accountable."
          </blockquote>
          <div className="login-stats">
            <div><strong>3</strong><span>User roles</span></div>
            <div><strong>6</strong><span>Process phases</span></div>
            <div><strong>100%</strong><span>Audit trail</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}
