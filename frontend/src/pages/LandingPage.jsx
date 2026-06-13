import { Link } from 'react-router-dom'
import {
  Shield, Users, FileText, Lock, BarChart2, Link2,
  PlusCircle, CheckCircle, Eye, Building2, ClipboardCheck
} from 'lucide-react'
import '../style/LandingPage.css'

const STEPS = [
  { num: '01', icon: PlusCircle, title: 'Admin Creates Project', desc: 'Scope, budget, and deadline defined' },
  { num: '02', icon: ClipboardCheck, title: 'Head Approves', desc: 'Project reviewed and published by Head' },
  { num: '03', icon: Users, title: 'Suppliers Register', desc: 'Register and get approved to bid' },
  { num: '04', icon: FileText, title: 'Bids Submitted', desc: 'Secured through structured workflow' },
  { num: '05', icon: BarChart2, title: 'Admin Evaluates', desc: 'Admin reviews bids and picks winner' },
  { num: '06', icon: Shield, title: 'Recorded on Chain', desc: 'Winner stored permanently' },
]

const FEATURES = [
  { icon: Shield, title: 'Blockchain Transparency', desc: 'Every final award is verifiable, traceable, and resistant to hidden edits.' },
  { icon: Lock, title: 'Secure Bid Submission', desc: 'Suppliers submit through a protected channel built for integrity.' },
  { icon: BarChart2, title: 'Real-time Monitoring', desc: 'Admins track live bid activity while the process stays controlled.' },
  { icon: BarChart2, title: 'Automated Evaluation', desc: 'Bids organized to support faster and consistent decision-making.' },
  { icon: Users, title: 'Supplier Management', desc: 'Manage registered vendors, submissions, and participation with clarity.' },
  { icon: Link2, title: 'Immutable Audit Trail', desc: 'A permanent chain of records supports accountability and compliance.' },
]

const ROLES = [
  {
    icon: Shield,
    title: 'Admin',
    subtitle: 'Controls the full procurement lifecycle.',
    perks: ['Create and manage projects', 'Approve or reject suppliers', 'Evaluate and rank bids', 'Select winner and record to blockchain'],
    cta: 'Login →',
    to: '/login',
    variant: 'dark',
  },
  {
    icon: Building2,
    title: 'Supplier',
    subtitle: 'Competes through secure and fair bidding.',
    perks: ['Register and get approved', 'Browse available projects', 'Submit bids with proposals', 'Track status and view results'],
    cta: 'Login →',
    to: '/login',
    variant: 'light',
  },
  {
    icon: ClipboardCheck,
    title: 'Head',
    subtitle: 'Approves projects before they go live.',
    perks: ['Review admin-created projects', 'Approve or reject projects', 'See all published projects', 'Monitor procurement progress'],
    cta: 'Login →',
    to: '/login',
    variant: 'light',
  },
]

export default function LandingPage() {
  return (
    <div className="landing">
      {/* Navbar */}
      <nav className="lp-nav">
        <Link to="/" className="lp-logo">
          <span className="lp-logo-icon"><Shield size={18} /></span>
          <div>
            <div className="lp-logo-name">E-Procurement</div>
            <div className="lp-logo-sub">Blockchain System</div>
          </div>
        </Link>
        <div className="lp-nav-links" id="nav-links">
          <a href="#how-it-works">How It Works</a>
          <a href="#features">Features</a>
          <a href="#roles">Roles</a>
        </div>
        <div className="lp-nav-right">
          <Link to="/" className="lp-public-btn"><Eye size={14} /> Public Results</Link>
          <Link to="/login" className="btn-primary lp-login-btn">Login</Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="lp-hero">
        <div className="lp-hero-grid" />
        <div className="lp-hero-content">
          <h1>
            Transparent Procurement,{' '}
            <span className="lp-accent">Secured by Blockchain</span>
          </h1>
          <p>
            A blockchain-based e-procurement platform that ensures fair bidding,
            tamper-proof records, and full transparency for government and corporate procurement.
          </p>
          <div className="lp-hero-btns">
            <Link to="/login" className="btn-primary lp-hero-login">
              <Shield size={16} /> Login
            </Link>
            <Link to="/register" className="btn-outline lp-hero-register">
              Register as Supplier
            </Link>
          </div>
          <p className="lp-hero-hint">
            New supplier? <Link to="/register" className="lp-hint-link">Register as Supplier</Link>
          </p>
        </div>
      </section>

      {/* How It Works */}
      <section className="lp-section lp-hiw" id="how-it-works">
        <div className="lp-section-label">PROCESS</div>
        <h2 className="lp-section-title">How It Works</h2>
        <p className="lp-section-sub">A clean procurement flow designed to keep participation fair and results verifiable by everyone.</p>
        <div className="lp-steps">
          {STEPS.map(({ num, icon: Icon, title, desc }) => (
            <div className="lp-step" key={num}>
              <div className="lp-step-icon"><Icon size={22} /></div>
              <div className="lp-step-num">{num}</div>
              <div className="lp-step-title">{title}</div>
              <div className="lp-step-desc">{desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Key Features */}
      <section className="lp-section lp-features-sec" id="features">
        <div className="lp-section-label">CAPABILITIES</div>
        <h2 className="lp-section-title">Key Features</h2>
        <div className="lp-features-grid">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div className="lp-feature-card" key={title}>
              <div className="lp-feature-icon"><Icon size={20} /></div>
              <h3>{title}</h3>
              <p>{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Roles */}
      <section className="lp-section lp-roles-sec" id="roles">
        <div className="lp-section-label">ACCESS CONTROL</div>
        <h2 className="lp-section-title">Three User Roles</h2>
        <p className="lp-section-sub">Each role has specific access to keep the process organized and transparent.</p>
        <div className="lp-roles-grid">
          {ROLES.map(({ icon: Icon, title, subtitle, perks, cta, to, variant }) => (
            <div className={`lp-role-card lp-role-${variant}`} key={title}>
              <div className={`lp-role-icon lp-role-icon-${variant}`}><Icon size={22} /></div>
              <h3>{title}</h3>
              <p className="lp-role-sub">{subtitle}</p>
              <ul className="lp-role-perks">
                {perks.map(p => (
                  <li key={p}><CheckCircle size={15} className="lp-check" />{p}</li>
                ))}
              </ul>
              <Link to={to} className={`lp-role-cta lp-role-cta-${variant}`}>{cta}</Link>
            </div>
          ))}
        </div>
      </section>

      {/* CTA Banner */}
      <section className="lp-cta">
        <div className="lp-cta-badge"><span className="lp-dot" />Ready to get started?</div>
        <h2>Join the Platform</h2>
        <p>Register as a supplier to start bidding, or log in as an admin to manage the procurement process.</p>
        <div className="lp-cta-btns">
          <Link to="/register" className="btn-primary">
            <Building2 size={16} /> Register as Supplier
          </Link>
          <Link to="/login" className="btn-outline">Login as Admin</Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="lp-footer">
        <div className="lp-footer-top">
          <div className="lp-footer-brand">
            <Link to="/" className="lp-logo">
              <span className="lp-logo-icon"><Shield size={16} /></span>
              <div className="lp-logo-name">E-Procurement</div>
            </Link>
            <p>A blockchain-based procurement platform ensuring fair bidding, transparent records, and secure transactions.</p>
          </div>
          <div className="lp-footer-col">
            <h4>PRODUCT</h4>
            <a href="#features">Features</a>
            <a href="#how-it-works">How It Works</a>
            <a href="#roles">Roles</a>
          </div>
          <div className="lp-footer-col">
            <h4>COMPANY</h4>
            <a href="#">About</a>
            <a href="#">Documentation</a>
            <a href="#">Support</a>
          </div>
          <div className="lp-footer-col">
            <h4>LEGAL</h4>
            <a href="#">Privacy Policy</a>
            <a href="#">Terms of Service</a>
            <a href="#">Compliance</a>
          </div>
        </div>
        <div className="lp-footer-bottom">
          <span>© 2026 E-Procurement Blockchain System. All rights reserved.</span>
          <div className="lp-footer-links">
            <a href="#">Security</a>
            <a href="#">Status</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
