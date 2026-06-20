import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Shield, ArrowLeft } from 'lucide-react'
import { apiRequestPasswordReset } from '../api'
import '../style/LoginPage.css'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await apiRequestPasswordReset(email.trim())
      // Always show the same success state — the backend deliberately never
      // reveals whether the email matched an account.
      setSent(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
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
            <div className="login-success">
              <p>If an account exists for <b>{email.trim()}</b>, a password reset link has been sent.</p>
              <p>Check your inbox (and spam folder) — the link expires in 3 days.</p>
            </div>
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
