import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Shield, ArrowLeft } from 'lucide-react'
import { apiRequestPasswordReset } from '../api'
import '../style/LoginPage.css'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [resending, setResending] = useState(false)
  const [resendMsg, setResendMsg] = useState('')
  const [cooldown, setCooldown] = useState(0) // seconds until "Resend" is allowed again

  // Tick the resend cooldown down to zero.
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown(cooldown - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await apiRequestPasswordReset(email.trim())
      // Always show the same success state — the backend deliberately never
      // reveals whether the email matched an account.
      setSent(true)
      setCooldown(30) // a link was just sent — block an instant resend
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleResend = async () => {
    if (resending || cooldown > 0) return
    setError('')
    setResendMsg('')
    setResending(true)
    try {
      await apiRequestPasswordReset(email.trim())
      setResendMsg('Another reset link is on its way. Check your inbox and spam folder.')
      setCooldown(30)
    } catch (err) {
      setError(err.message)
    } finally {
      setResending(false)
    }
  }

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
          <h1>Forgot Password</h1>
          <p className="login-subtitle">Enter the email on your account and we'll send you a link to reset your password.</p>

          {sent ? (
            <>
              <div className="login-success">
                <p>If an account exists for <b>{email.trim()}</b>, a password reset link has been sent.</p>
                <p>Check your inbox (and spam folder) — the link expires in 3 days.</p>
              </div>
              {resendMsg && <div className="login-resend-msg" style={{ marginTop: 12 }}>{resendMsg}</div>}
              {error && <div className="login-error" style={{ marginTop: 12 }}><span>{error}</span></div>}
              <p className="login-resend">
                Didn't get the email?{' '}
                <button
                  type="button"
                  className="login-resend-btn"
                  onClick={handleResend}
                  disabled={resending || cooldown > 0}
                >
                  {resending ? 'Sending…' : cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend link'}
                </button>
              </p>
            </>
          ) : (
            <form onSubmit={handleSubmit} className="login-form">
              <div className="form-group">
                <label>Email</label>
                <input type="email" placeholder="you@example.com" value={email}
                  onChange={e => setEmail(e.target.value)} required />
              </div>
              {error && <div className="login-error"><span>{error}</span></div>}
              <button type="submit" className="login-submit" disabled={loading}>
                {loading ? 'Sending…' : 'Send Reset Link'}
              </button>
            </form>
          )}

          <p className="login-switch">
            Remembered your password? <Link to="/login">Sign in</Link>
          </p>
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
