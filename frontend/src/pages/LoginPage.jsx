import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Shield, Eye, EyeOff, Building2, ArrowLeft, ClipboardCheck } from 'lucide-react'
import '../style/LoginPage.css'

const ROLES = [
  { key: 'admin', label: 'Admin', icon: Shield },
  { key: 'head', label: 'Head', icon: ClipboardCheck },
  { key: 'supplier', label: 'Supplier', icon: Building2 },
]

export default function LoginPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const isRegister = params.get('register') === 'supplier'
  const [showPass, setShowPass] = useState(false)
  const [role, setRole] = useState('admin')
  const [form, setForm] = useState({ email: '', password: '', company: '', name: '' })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (role === 'admin') navigate('/admin')
    else if (role === 'head') navigate('/head')
    else navigate('/supplier')
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
          <h1>{isRegister ? 'Register as Supplier' : 'Welcome Back'}</h1>
          <p>{isRegister ? 'Create your supplier account to start bidding on procurement projects.' : 'Select your role and sign in to continue.'}</p>

          {!isRegister && (
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
          )}

          <form onSubmit={handleSubmit} className="login-form">
            {isRegister && (
              <>
                <div className="form-group">
                  <label>Full Name</label>
                  <input type="text" placeholder="John Smith" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Company Name</label>
                  <input type="text" placeholder="Acme Corp" value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} required />
                </div>
              </>
            )}
            <div className="form-group">
              <label>Email Address</label>
              <input type="email" placeholder="you@example.com" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
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
            {!isRegister && <a href="#" className="login-forgot">Forgot password?</a>}
            <button type="submit" className="login-submit">
              {isRegister ? 'Create Account' : `Sign in as ${roleLabel}`}
            </button>
          </form>

          <p className="login-switch">
            {isRegister
              ? <>Already have an account? <Link to="/login">Sign in</Link></>
              : <>New supplier? <Link to="/login?register=supplier">Register here</Link></>
            }
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
