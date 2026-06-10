import { useState } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, CheckCircle2, XCircle,
  ClipboardCheck, Bell, Search, LogOut, Settings,
  Eye, MoreHorizontal, Clock, Shield, AlertCircle, Filter, ChevronDown
} from 'lucide-react'
import './HeadDashboard.css'

const NAV = [
  { icon: LayoutDashboard, label: 'Dashboard', to: '/head' },
  { icon: Clock, label: 'Pending Approval', to: '/head/pending' },
  { icon: CheckCircle2, label: 'Approved', to: '/head/approved' },
  { icon: Settings, label: 'Settings', to: '/head/settings' },
]

// Projects waiting for Head approval
const PENDING_PROJECTS = [
  { id: 'P-2026-003', name: 'IT Systems Upgrade', budget: '$450K', deadline: 'Aug 1, 2026', category: 'Technology', createdBy: 'Admin User', createdAt: 'Jun 8, 2026' },
  { id: 'P-2026-005', name: 'Water Treatment Facility', budget: '$1.7M', deadline: 'Sep 10, 2026', category: 'Environment', createdBy: 'Admin User', createdAt: 'Jun 9, 2026' },
]

// Projects Head already approved
const APPROVED_PROJECTS = [
  { id: 'P-2026-001', name: 'Road Infrastructure Phase 2', budget: '$2.4M', deadline: 'Jul 15, 2026', category: 'Infrastructure', approvedAt: 'Jun 5, 2026', bids: 8 },
  { id: 'P-2026-002', name: 'Hospital Equipment Procurement', budget: '$890K', deadline: 'Jun 30, 2026', category: 'Medical', approvedAt: 'Jun 3, 2026', bids: 5 },
  { id: 'P-2026-004', name: 'School Construction Batch A', budget: '$3.1M', deadline: 'May 20, 2026', category: 'Infrastructure', approvedAt: 'Apr 15, 2026', bids: 6 },
]

function HeadSidebar({ active }) {
  const navigate = useNavigate()
  return (
    <aside className="hd-sidebar">
      <div className="hd-sidebar-logo">
        <span className="lp-logo-icon" style={{ background: '#8b5cf6' }}><ClipboardCheck size={16} /></span>
        <div>
          <div className="lp-logo-name">E-Procurement</div>
          <div className="lp-logo-sub" style={{ color: '#64748b' }}>Head Panel</div>
        </div>
      </div>
      <nav className="hd-sidebar-nav">
        {NAV.map(({ icon: Icon, label, to }) => (
          <Link key={to} to={to} className={`hd-nav-item ${active === to ? 'active' : ''}`}>
            <Icon size={18} /><span>{label}</span>
          </Link>
        ))}
      </nav>
      <button className="hd-logout" onClick={() => navigate('/login')}>
        <LogOut size={16} /><span>Log out</span>
      </button>
    </aside>
  )
}

function HeadHeader({ title }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <header className="hd-header">
      <h1 className="hd-page-title">{title}</h1>
      <div className="hd-header-right">
        <div className="hd-search">
          <Search size={15} />
          <input placeholder="Search projects…" />
        </div>
        <button className="hd-notif"><Bell size={18} /><span className="hd-notif-dot" /></button>
        <div className="hd-user-wrap">
          <div className="hd-user" onClick={() => setOpen(o => !o)}>
            <div className="hd-avatar">H</div>
            <div className="hd-user-info">
              <span>Head Officer</span>
              <span>Procurement Head</span>
            </div>
            <ChevronDown size={14} color="#64748b" />
          </div>
          {open && (
            <>
              <div className="hd-dropdown-backdrop" onClick={() => setOpen(false)} />
              <div className="hd-dropdown">
                <div className="hd-dropdown-header">
                  <div className="hd-avatar">H</div>
                  <div>
                    <div className="hd-dropdown-name">Head Officer</div>
                    <div className="hd-dropdown-email">head@eprocure.gov</div>
                  </div>
                </div>
                <div className="hd-dropdown-divider" />
                <button className="hd-dropdown-item" onClick={() => { setOpen(false); navigate('/head/settings') }}>
                  <Settings size={15} /> Settings
                </button>
                <div className="hd-dropdown-divider" />
                <button className="hd-dropdown-item hd-dropdown-logout" onClick={() => navigate('/login')}>
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

function HeadHome() {
  const [pending, setPending] = useState(PENDING_PROJECTS)
  const [approved, setApproved] = useState(APPROVED_PROJECTS)

  const handleApprove = (id) => {
    const proj = pending.find(p => p.id === id)
    if (!proj) return
    setPending(prev => prev.filter(p => p.id !== id))
    setApproved(prev => [{ ...proj, approvedAt: 'Just now', bids: 0 }, ...prev])
  }

  const handleReject = (id) => {
    setPending(prev => prev.filter(p => p.id !== id))
  }

  return (
    <div className="hd-content">
      {/* Stats */}
      <div className="hd-stats">
        {[
          { label: 'Pending Approval', value: pending.length, icon: Clock, color: 'yellow' },
          { label: 'Approved Projects', value: approved.length, icon: CheckCircle2, color: 'green' },
          { label: 'Total Bids Received', value: approved.reduce((s, p) => s + (p.bids || 0), 0), icon: FolderOpen, color: 'blue' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div className="hd-stat-card" key={label}>
            <div className="hd-stat-top">
              <span className="hd-stat-label">{label}</span>
              <div className={`hd-stat-icon hd-icon-${color}`}><Icon size={18} /></div>
            </div>
            <div className="hd-stat-value">{value}</div>
          </div>
        ))}
      </div>

      {/* Pending Projects */}
      <div className="hd-card">
        <div className="hd-card-header">
          <div>
            <h2>Pending Your Approval</h2>
            <p>Projects created by Admin — approve to publish for suppliers</p>
          </div>
          {pending.length > 0 && (
            <span className="hd-pending-badge">{pending.length} awaiting</span>
          )}
        </div>

        {pending.length === 0 ? (
          <div className="hd-empty">
            <CheckCircle2 size={36} />
            <p>All caught up! No projects waiting for approval.</p>
          </div>
        ) : (
          <div className="hd-project-cards">
            {pending.map(p => (
              <div className="hd-project-card hd-pending" key={p.id}>
                <div className="hd-project-card-top">
                  <div>
                    <div className="hd-proj-id">{p.id}</div>
                    <div className="hd-proj-name">{p.name}</div>
                    <span className={`badge badge-blue`}>{p.category}</span>
                  </div>
                  <div className="hd-alert-icon"><AlertCircle size={20} /></div>
                </div>
                <div className="hd-project-card-meta">
                  <div><span>Budget</span><strong>{p.budget}</strong></div>
                  <div><span>Deadline</span><strong>{p.deadline}</strong></div>
                  <div><span>Created by</span><strong>{p.createdBy}</strong></div>
                  <div><span>Created</span><strong>{p.createdAt}</strong></div>
                </div>
                <div className="hd-project-card-actions">
                  <button className="hd-btn-approve" onClick={() => handleApprove(p.id)}>
                    <CheckCircle2 size={14} /> Approve & Publish
                  </button>
                  <button className="hd-btn-reject" onClick={() => handleReject(p.id)}>
                    <XCircle size={14} /> Reject
                  </button>
                  <button className="hd-btn-view"><Eye size={14} /> View Details</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Approved Projects */}
      <div className="hd-card">
        <div className="hd-card-header">
          <div>
            <h2>Approved Projects</h2>
            <p>Projects you approved — now live and open for supplier bids</p>
          </div>
          <Link to="/head/approved" className="hd-view-all">View all →</Link>
        </div>
        <div className="hd-table-wrap">
          <table className="hd-table">
            <thead>
              <tr><th>ID</th><th>Project Name</th><th>Budget</th><th>Deadline</th><th>Bids</th><th>Approved On</th><th></th></tr>
            </thead>
            <tbody>
              {approved.map(p => (
                <tr key={p.id}>
                  <td className="hd-mono">{p.id}</td>
                  <td className="hd-bold">{p.name}</td>
                  <td>{p.budget}</td>
                  <td className="hd-muted">{p.deadline}</td>
                  <td><span className="hd-bid-count">{p.bids}</span></td>
                  <td className="hd-muted">{p.approvedAt}</td>
                  <td><button className="hd-btn-icon"><Eye size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function PendingPage() {
  const [pending, setPending] = useState(PENDING_PROJECTS)

  return (
    <div className="hd-content">
      <div className="hd-card">
        <div className="hd-card-header">
          <div>
            <h2>Pending Approval</h2>
            <p>Review and approve projects before they go live for suppliers</p>
          </div>
          <button className="hd-btn-outline"><Filter size={14} /> Filter</button>
        </div>
        {pending.length === 0 ? (
          <div className="hd-empty">
            <CheckCircle2 size={36} />
            <p>No pending projects at this time.</p>
          </div>
        ) : (
          <div className="hd-project-cards" style={{ padding: '20px 24px' }}>
            {pending.map(p => (
              <div className="hd-project-card hd-pending" key={p.id}>
                <div className="hd-project-card-top">
                  <div>
                    <div className="hd-proj-id">{p.id}</div>
                    <div className="hd-proj-name">{p.name}</div>
                    <span className="badge badge-blue">{p.category}</span>
                  </div>
                  <div className="hd-alert-icon"><AlertCircle size={20} /></div>
                </div>
                <div className="hd-project-card-meta">
                  <div><span>Budget</span><strong>{p.budget}</strong></div>
                  <div><span>Deadline</span><strong>{p.deadline}</strong></div>
                  <div><span>Created by</span><strong>{p.createdBy}</strong></div>
                  <div><span>Submitted</span><strong>{p.createdAt}</strong></div>
                </div>
                <div className="hd-project-card-actions">
                  <button className="hd-btn-approve" onClick={() => setPending(prev => prev.filter(x => x.id !== p.id))}>
                    <CheckCircle2 size={14} /> Approve & Publish
                  </button>
                  <button className="hd-btn-reject" onClick={() => setPending(prev => prev.filter(x => x.id !== p.id))}>
                    <XCircle size={14} /> Reject
                  </button>
                  <button className="hd-btn-view"><Eye size={14} /> View Details</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ApprovedPage() {
  return (
    <div className="hd-content">
      <div className="hd-card">
        <div className="hd-card-header">
          <div><h2>Approved Projects</h2><p>All projects you have approved and published</p></div>
        </div>
        <div className="hd-table-wrap">
          <table className="hd-table">
            <thead>
              <tr><th>ID</th><th>Project Name</th><th>Budget</th><th>Category</th><th>Deadline</th><th>Bids</th><th>Approved On</th></tr>
            </thead>
            <tbody>
              {APPROVED_PROJECTS.map(p => (
                <tr key={p.id}>
                  <td className="hd-mono">{p.id}</td>
                  <td className="hd-bold">{p.name}</td>
                  <td>{p.budget}</td>
                  <td><span className="badge badge-blue">{p.category}</span></td>
                  <td className="hd-muted">{p.deadline}</td>
                  <td><span className="hd-bid-count">{p.bids}</span></td>
                  <td className="hd-muted">{p.approvedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default function HeadDashboard() {
  const loc = useLocation()
  const TITLES = {
    '/head': 'Dashboard',
    '/head/pending': 'Pending Approval',
    '/head/approved': 'Approved Projects',
    '/head/settings': 'Settings',
  }
  return (
    <div className="hd-layout">
      <HeadSidebar active={loc.pathname} />
      <div className="hd-main">
        <HeadHeader title={TITLES[loc.pathname] || 'Dashboard'} />
        <div className="hd-body">
          <Routes>
            <Route index element={<HeadHome />} />
            <Route path="pending" element={<PendingPage />} />
            <Route path="approved" element={<ApprovedPage />} />
            <Route path="*" element={<HeadHome />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
