import { useState, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Shield, Eye, EyeOff, ArrowLeft, KeyRound } from 'lucide-react'
import { apiLogin, apiMfaConfirm, saveSession } from '../api'
import '../style/LoginPage.css'

export default function LoginPage() {
  const navigate = useNavigate()
  const [showPass, setShowPass] = useState(false)
  const [form, setForm] = useState({ identifier: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // MFA second step
  const [mfaToken, setMfaToken] = useState(null)
  const [mfaCode, setMfaCode] = useState('')
  const mfaInputRef = useRef(null)

  const goToDashboard = (userRole) => {
    if (userRole === 'admin') navigate('/admin')
    else if (userRole === 'head') navigate('/head')
    else navigate('/supplier')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await apiLogin(form.identifier.trim(), form.password)
      if (result.mfa_required) {
        setMfaToken(result.mfa_token)
        setTimeout(() => mfaInputRef.current?.focus(), 50)
        return
      }
      saveSession(result)
      goToDashboard(result.user.role)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleMfaSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const session = await apiMfaConfirm(mfaToken, mfaCode.trim())
      saveSession(session)
      goToDashboard(session.user.role)
    } catch (err) {
      setError(err.message)
      setMfaCode('')
    } finally {
      setLoading(false)
    }
  }

  const handleBackToLogin = () => {
    setMfaToken(null)
    setMfaCode('')
    setError('')
  }

  return (
    <div className="login-page">
      <div className="login-left">
        <div className="login-left-inner">
          {mfaToken
            ? <button className="login-back" onClick={handleBackToLogin}><ArrowLeft size={16} /> Back to Login</button>
            : <Link to="/" className="login-back"><ArrowLeft size={16} /> Back to Home</Link>
          }
          <div className="login-logo">
            <span className="lp-logo-icon"><Shield size={18} /></span>
            <div>
              <div className="lp-logo-name">E-Procurement</div>
              <div className="lp-logo-sub">Procurement System</div>
            </div>
          </div>

          {mfaToken ? (
            <>
              <h1>Check Your Email</h1>
              <p className="login-subtitle">Enter the 6-digit code we just sent to your email address. It expires in 5 minutes.</p>
              <form onSubmit={handleMfaSubmit} className="login-form">
                <div className="form-group">
                  <label><KeyRound size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />Verification Code</label>
                  <input
                    ref={mfaInputRef}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    placeholder="000000"
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    required
                    className="mfa-code-input"
                  />
                </div>
                {error && <div className="login-error"><span>{error}</span></div>}
                <button type="submit" className="login-submit" disabled={loading || mfaCode.length < 6}>
                  {loading ? 'Verifying…' : 'Verify & Sign In'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1>Welcome Back</h1>
              <p className="login-subtitle">Sign in with your username or email to continue.</p>
              <form onSubmit={handleSubmit} className="login-form">
                <div className="form-group">
                  <label>Username or Email</label>
                  <input type="text" placeholder="you@example.com" value={form.identifier} onChange={e => setForm({ ...form, identifier: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Password</label>
                  <div className="pass-wrap">
                    <input
                      type={showPass ? 'text' : 'password'}
                      placeholder="••••••••"
                      value={form.password}
                      onChange={e => setForm({ ...form, password: e.target.value })}
                      required
                    />
                    <button type="button" className="pass-toggle" onClick={() => setShowPass(!showPass)}>
                      {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                {error && (
                  <div className="login-error">
                    <span>{error}</span>
                    {/no account found/i.test(error) && (
                      <Link to="/register" className="login-error-cta">Create a supplier account →</Link>
                    )}
                  </div>
                )}
                <Link to="/forgot-password" className="login-forgot">Forgot password?</Link>
                <button type="submit" className="login-submit" disabled={loading}>
                  {loading ? 'Please wait…' : 'Sign In'}
                </button>
              </form>
              <p className="login-switch">
                New supplier? <Link to="/register">Register here</Link>
              </p>
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
