import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Shield, Eye, EyeOff, ArrowLeft } from 'lucide-react'
import { apiLogin, saveSession } from '../api'
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
      const session = await apiLogin(form.identifier.trim(), form.password)
      saveSession(session)
      goToDashboard(session.user.role)
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
          <Link to="/" className="login-back"><ArrowLeft size={16} /> Back to Home</Link>
          <div className="login-logo">
            <span className="lp-logo-icon"><Shield size={18} /></span>
            <div>
              <div className="lp-logo-name">E-Procurement</div>
              <div className="lp-logo-sub">Procurement System</div>
            </div>
          </div>
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
                {/* No matching account → guide them straight to registration. */}
                {/no account found/i.test(error) && (
                  <Link to="/register" className="login-error-cta">Create a supplier account →</Link>
                )}
              </div>
            )}
            <a href="#" className="login-forgot">Forgot password?</a>
            <button type="submit" className="login-submit" disabled={loading}>
              {loading ? 'Please wait…' : 'Sign In'}
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
