import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Shield, Eye, EyeOff, ArrowLeft } from 'lucide-react'
import { apiConfirmPasswordReset } from '../api'
import '../style/LoginPage.css'

export default function ResetPasswordPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const uid = params.get('uid') || ''
  const token = params.get('token') || ''

  const [showPass, setShowPass] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)

  const linkMissing = !uid || !token

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (newPassword !== confirmPassword) { setError('New password and confirmation do not match.'); return }
    setLoading(true)
    try {
      await apiConfirmPasswordReset(uid, token, newPassword)
      setDone(true)
      setTimeout(() => navigate('/login'), 2500)
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
          <h1>Reset Password</h1>

          {linkMissing ? (
            <>
              <p className="login-subtitle">This password reset link is missing or malformed.</p>
              <div className="login-error"><span>Please request a new reset link.</span></div>
              <p className="login-switch">
                <Link to="/forgot-password">Request a new link</Link>
              </p>
            </>
          ) : done ? (
            <>
              <p className="login-subtitle">Choose a new password for your account.</p>
              <div className="login-success">
                Your password has been reset. Redirecting you to sign in…
              </div>
            </>
          ) : (
            <>
              <p className="login-subtitle">Choose a new password for your account.</p>
              <form onSubmit={handleSubmit} className="login-form">
                <div className="form-group">
                  <label>New Password</label>
                  <div className="pass-wrap">
                    <input
                      type={showPass ? 'text' : 'password'}
                      placeholder="••••••••"
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      required
                    />
                    <button type="button" className="pass-toggle" onClick={() => setShowPass(!showPass)}>
                      {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <div className="form-group">
                  <label>Confirm New Password</label>
                  <input
                    type={showPass ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    required
                  />
                </div>
                {error && <div className="login-error"><span>{error}</span></div>}
                <button type="submit" className="login-submit" disabled={loading}>
                  {loading ? 'Saving…' : 'Reset Password'}
                </button>
              </form>
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
