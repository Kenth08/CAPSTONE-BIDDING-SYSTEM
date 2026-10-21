import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { Shield, Eye, EyeOff, ArrowLeft, AlertCircle, Loader2, LogIn } from 'lucide-react'
import { apiLogin, saveSession, getToken, getRole } from '../api'
import '../style/LoginPage.css'

export default function LoginPage() {
  const navigate = useNavigate()
  const [showPass, setShowPass] = useState(false)
  const [form, setForm] = useState({ identifier: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

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
      saveSession(result)
      goToDashboard(result.user.role)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Already signed in (e.g. arrived from a public page link): go straight back
  // to the dashboard instead of showing a login form that looks like a logout.
  const signedInRole = getToken() && getRole()
  if (signedInRole) return <Navigate to={`/${signedInRole}`} replace />

  return (
    <div className="login-page">
      <div className="login-left">
        <div className="login-left-inner">
          <Link to="/" className="login-back"><ArrowLeft size={16} /> Back to Home</Link>
          <div className="login-logo">
            <span className="lp-logo-icon"><Shield size={18} /></span>
            <div>
              <div className="lp-logo-name login-brand-name">E-Procurement</div>
              <div className="lp-logo-sub login-brand-sub">Procurement System</div>
            </div>
          </div>

          <h1>Welcome Back</h1>
          <p className="login-subtitle">Sign in with your username or email to continue.</p>
          <form onSubmit={handleSubmit} className="login-form">
            <div className="form-group">
              <label htmlFor="login-identifier">Username or Email</label>
              <input id="login-identifier" type="text" autoComplete="username" placeholder="Username or email" value={form.identifier}
                onChange={e => setForm({ ...form, identifier: e.target.value })} required aria-invalid={!!error} />
            </div>
            <div className="form-group">
              <label htmlFor="login-password">Password</label>
              <div className="pass-wrap">
                <input
                  id="login-password"
                  autoComplete="current-password"
                  aria-invalid={!!error}
                  type={showPass ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                  required
                />
                <button type="button" className="pass-toggle" onClick={() => setShowPass(!showPass)}
                  aria-label={showPass ? 'Hide password' : 'Show password'} aria-pressed={showPass}>
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            {error && (
              <div className="login-error" role="alert">
                <span className="login-error-msg"><AlertCircle size={15} aria-hidden="true" /> {error}</span>
                {/no account found/i.test(error) && (
                  <Link to="/register" className="login-error-cta">Create a supplier account →</Link>
                )}
              </div>
            )}
            <Link to="/forgot-password" className="login-forgot">Forgot password?</Link>
            <button type="submit" className="login-submit" disabled={loading}>
              {loading
                ? <><Loader2 size={16} className="ui-spin" aria-hidden="true" /> Signing in…</>
                : <><LogIn size={16} aria-hidden="true" /> Sign In</>}
            </button>
          </form>
          <p className="login-switch">
            New supplier? <Link to="/register">Register here</Link>
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
