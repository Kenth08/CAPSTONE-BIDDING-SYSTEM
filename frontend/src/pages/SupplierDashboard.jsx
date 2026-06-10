import { useState } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, FileText, Clock, CheckCircle2,
  Building2, Bell, Search, ChevronDown, LogOut, Settings,
  Plus, Eye, MoreHorizontal, ArrowRight, Shield, AlertCircle, User
} from 'lucide-react'
import './SupplierDashboard.css'

const NAV = [
  { icon: LayoutDashboard, label: 'Dashboard', to: '/supplier' },
  { icon: FolderOpen, label: 'Projects', to: '/supplier/projects' },
  { icon: FileText, label: 'My Bids', to: '/supplier/bids' },
  { icon: Clock, label: 'Status', to: '/supplier/status' },
  { icon: Settings, label: 'Profile', to: '/supplier/profile' },
]

const OPEN_PROJECTS = [
  { id: 'P-2026-001', name: 'Road Infrastructure Phase 2', budget: '$2.4M', deadline: 'Jul 15, 2026', category: 'Infrastructure' },
  { id: 'P-2026-003', name: 'IT Systems Upgrade', budget: '$450K', deadline: 'Aug 1, 2026', category: 'Technology' },
  { id: 'P-2026-005', name: 'Water Treatment Facility', budget: '$1.7M', deadline: 'Sep 10, 2026', category: 'Environment' },
]

const MY_BIDS = [
  { project: 'Hospital Equipment Procurement', amount: '$820K', submitted: 'Jun 1, 2026', status: 'shortlisted' },
  { project: 'Road Infrastructure Phase 2', amount: '$2.1M', submitted: 'Jun 5, 2026', status: 'pending' },
]

function SupplierSidebar({ active }) {
  const navigate = useNavigate()
  return (
    <aside className="sd-sidebar">
      <div className="sd-sidebar-logo">
        <span className="lp-logo-icon"><Building2 size={16} /></span>
        <div>
          <div className="lp-logo-name">E-Procurement</div>
          <div className="lp-logo-sub" style={{ color: '#64748b' }}>Supplier Panel</div>
        </div>
      </div>
      <nav className="sd-sidebar-nav">
        {NAV.map(({ icon: Icon, label, to }) => (
          <Link key={to} to={to} className={`sd-nav-item ${active === to ? 'active' : ''}`}>
            <Icon size={18} /><span>{label}</span>
          </Link>
        ))}
      </nav>
      <button className="sd-logout" onClick={() => navigate('/login')}>
        <LogOut size={16} /><span>Log out</span>
      </button>
    </aside>
  )
}

function SupplierHeader({ title }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <header className="sd-header">
      <h1 className="sd-page-title">{title}</h1>
      <div className="sd-header-right">
        <div className="sd-search">
          <Search size={15} />
          <input placeholder="Search projects…" />
        </div>
        <button className="sd-notif"><Bell size={18} /><span className="sd-notif-dot" /></button>
        <div className="sd-user-wrap">
          <div className="sd-user" onClick={() => setOpen(o => !o)}>
            <div className="sd-avatar">S</div>
            <div className="sd-user-info">
              <span>Supplier User</span>
              <span>BuildRight Corp</span>
            </div>
            <ChevronDown size={14} color="#64748b" />
          </div>
          {open && (
            <>
              <div className="sd-dropdown-backdrop" onClick={() => setOpen(false)} />
              <div className="sd-dropdown">
                <div className="sd-dropdown-header">
                  <div className="sd-avatar">S</div>
                  <div>
                    <div className="sd-dropdown-name">Supplier User</div>
                    <div className="sd-dropdown-email">supplier@buildright.com</div>
                  </div>
                </div>
                <div className="sd-dropdown-divider" />
                <button className="sd-dropdown-item" onClick={() => { setOpen(false); navigate('/supplier/profile') }}>
                  <User size={15} /> My Profile
                </button>
                <button className="sd-dropdown-item" onClick={() => { setOpen(false); navigate('/supplier/profile') }}>
                  <Settings size={15} /> Settings
                </button>
                <div className="sd-dropdown-divider" />
                <button className="sd-dropdown-item sd-dropdown-logout" onClick={() => navigate('/login')}>
                  <LogOut size={15} /> Log out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

function SupplierHome() {
  return (
    <div className="sd-content">
      <div className="sd-stats">
        {[
          { label: 'Open Projects', value: '3', icon: FolderOpen, color: 'blue' },
          { label: 'My Active Bids', value: '2', icon: FileText, color: 'green' },
          { label: 'Shortlisted', value: '1', icon: CheckCircle2, color: 'purple' },
          { label: 'Approval Status', value: 'Active', icon: Shield, color: 'green' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div className="sd-stat-card" key={label}>
            <div className="sd-stat-top">
              <span className="sd-stat-label">{label}</span>
              <div className={`sd-stat-icon sd-icon-${color}`}><Icon size={17} /></div>
            </div>
            <div className="sd-stat-value">{value}</div>
          </div>
        ))}
      </div>

      <div className="sd-grid">
        <div className="sd-card sd-card-wide">
          <div className="sd-card-header">
            <div><h2>Available Projects</h2><p>Open projects you can bid on</p></div>
            <Link to="/supplier/projects" className="sd-view-all">View all →</Link>
          </div>
          <div className="sd-projects-list">
            {OPEN_PROJECTS.map(p => (
              <div className="sd-project-row" key={p.id}>
                <div className="sd-proj-icon"><FolderOpen size={16} /></div>
                <div className="sd-proj-info">
                  <span className="sd-bold">{p.name}</span>
                  <span className="sd-muted">{p.id} · {p.category}</span>
                </div>
                <div className="sd-proj-right">
                  <span className="sd-proj-budget">{p.budget}</span>
                  <span className="sd-muted sd-small">Due {p.deadline}</span>
                </div>
                <Link to="/supplier/projects" className="sd-bid-btn">Bid <ArrowRight size={13} /></Link>
              </div>
            ))}
          </div>
        </div>

        <div className="sd-card">
          <div className="sd-card-header">
            <div><h2>My Bids</h2><p>Your submitted bids</p></div>
          </div>
          <div className="sd-bids-list">
            {MY_BIDS.map((b, i) => (
              <div className="sd-bid-row" key={i}>
                <div className="sd-bid-info">
                  <span className="sd-bold">{b.project}</span>
                  <span className="sd-muted sd-small">Submitted {b.submitted}</span>
                </div>
                <div className="sd-bid-right">
                  <span className="sd-proj-budget">{b.amount}</span>
                  <span className={`badge ${b.status === 'shortlisted' ? 'badge-green' : 'badge-yellow'}`}>{b.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="sd-card sd-status-card">
        <div className="sd-card-header">
          <div><h2>Account Status</h2><p>Your registration and approval details</p></div>
        </div>
        <div className="sd-status-body">
          <div className="sd-status-item">
            <CheckCircle2 size={18} className="sd-check" />
            <div>
              <span className="sd-bold">Account Registered</span>
              <span className="sd-muted">Jun 1, 2026</span>
            </div>
          </div>
          <div className="sd-status-divider" />
          <div className="sd-status-item">
            <CheckCircle2 size={18} className="sd-check" />
            <div>
              <span className="sd-bold">Admin Approved</span>
              <span className="sd-muted">Jun 3, 2026</span>
            </div>
          </div>
          <div className="sd-status-divider" />
          <div className="sd-status-item">
            <CheckCircle2 size={18} className="sd-check" />
            <div>
              <span className="sd-bold">Eligible to Bid</span>
              <span className="sd-muted">Active on all open projects</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SupplierProjects() {
  return (
    <div className="sd-content">
      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>Available Projects</h2><p>Browse and bid on open procurement projects</p></div>
        </div>
        <table className="sd-table">
          <thead>
            <tr><th>ID</th><th>Project</th><th>Budget</th><th>Category</th><th>Deadline</th><th></th></tr>
          </thead>
          <tbody>
            {OPEN_PROJECTS.map(p => (
              <tr key={p.id}>
                <td className="sd-mono">{p.id}</td>
                <td className="sd-bold">{p.name}</td>
                <td>{p.budget}</td>
                <td><span className="badge badge-blue">{p.category}</span></td>
                <td className="sd-muted">{p.deadline}</td>
                <td><button className="sd-bid-btn-table">Submit Bid</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SupplierBids() {
  return (
    <div className="sd-content">
      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>My Bids</h2><p>Track all your submitted bids</p></div>
        </div>
        <table className="sd-table">
          <thead>
            <tr><th>Project</th><th>Amount</th><th>Submitted</th><th>Status</th></tr>
          </thead>
          <tbody>
            {MY_BIDS.map((b, i) => (
              <tr key={i}>
                <td className="sd-bold">{b.project}</td>
                <td>{b.amount}</td>
                <td className="sd-muted">{b.submitted}</td>
                <td><span className={`badge ${b.status === 'shortlisted' ? 'badge-green' : 'badge-yellow'}`}>{b.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function SupplierDashboard() {
  const loc = useLocation()
  const TITLES = {
    '/supplier': 'Dashboard',
    '/supplier/projects': 'Projects',
    '/supplier/bids': 'My Bids',
    '/supplier/status': 'Status',
    '/supplier/profile': 'Profile',
  }
  return (
    <div className="sd-layout">
      <SupplierSidebar active={loc.pathname} />
      <div className="sd-main">
        <SupplierHeader title={TITLES[loc.pathname] || 'Dashboard'} />
        <div className="sd-body">
          <Routes>
            <Route index element={<SupplierHome />} />
            <Route path="projects" element={<SupplierProjects />} />
            <Route path="bids" element={<SupplierBids />} />
            <Route path="*" element={<SupplierHome />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
