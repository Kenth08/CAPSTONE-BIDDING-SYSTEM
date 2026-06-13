import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Shield, Eye, EyeOff, Building2, ArrowLeft, ClipboardCheck } from 'lucide-react'
import { apiLogin, saveSession } from '../api'
import '../style/LoginPage.css'

const ROLES = [
  { key: 'admin', label: 'Admin', icon: Shield },
  { key: 'head', label: 'Head', icon: ClipboardCheck },
  { key: 'supplier', label: 'Supplier', icon: Building2 },
]

export default function LoginPage() {
  const navigate = useNavigate()
  const [showPass, setShowPass] = useState(false)
  const [role, setRole] = useState('admin')
  const [form, setForm] = useState({ username: '', password: '' })
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
      const session = await apiLogin(form.username, form.password)
      saveSession(session)
      goToDashboard(session.user.role)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const roleLabel = ROLES.find(r => r.key === role)?.label || 'Admin'

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
          <p>Select your role and sign in to continue.</p>

          <div className="login-role-tabs">
            {ROLES.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                className={role === key ? 'active' : ''}
                onClick={() => setRole(key)}
              >
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="login-form">
            <div className="form-group">
              <label>Username</label>
              <input type="text" placeholder="admin" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} required />
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
            {error && <div className="login-error">{error}</div>}
            <span className="login-hint">Demo accounts: <b>admin</b> / <b>head</b> / <b>supplier</b> — password <b>password123</b></span>
            <a href="#" className="login-forgot">Forgot password?</a>
            <button type="submit" className="login-submit" disabled={loading}>
              {loading ? 'Please wait…' : `Sign in as ${roleLabel}`}
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
