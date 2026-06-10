import { useState } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, Users, FileText, BarChart2,
  Shield, Bell, Search, ChevronDown, LogOut, Settings,
  TrendingUp, Clock, CheckCircle2, AlertCircle, Plus,
  Eye, MoreHorizontal, ArrowUp, ArrowDown, Link2,
  PlusCircle, Filter, Download, RefreshCw
} from 'lucide-react'
import './AdminDashboard.css'

const NAV = [
  { icon: LayoutDashboard, label: 'Dashboard', to: '/admin' },
  { icon: FolderOpen, label: 'Projects', to: '/admin/projects' },
  { icon: Users, label: 'Suppliers', to: '/admin/suppliers' },
  { icon: FileText, label: 'Bids', to: '/admin/bids' },
  { icon: BarChart2, label: 'Evaluation', to: '/admin/evaluation' },
  { icon: Link2, label: 'Blockchain', to: '/admin/blockchain' },
  { icon: Settings, label: 'Settings', to: '/admin/settings' },
]

const STATS = [
  { label: 'My Projects', value: '5', change: '2 pending Head approval', up: null, icon: FolderOpen, color: 'blue' },
  { label: 'Approved by Head', value: '3', change: 'Live for suppliers', up: true, icon: CheckCircle2, color: 'green' },
  { label: 'Total Bids Received', value: '34', change: '8 need evaluation', up: null, icon: FileText, color: 'yellow' },
  { label: 'Awarded Contracts', value: '7', change: '+1 this week', up: true, icon: CheckCircle2, color: 'purple' },
]

// approval: 'pending_head' | 'approved' | 'rejected' | 'awarded'
const PROJECTS = [
  { id: 'P-2026-001', name: 'Road Infrastructure Phase 2', budget: '$2.4M', deadline: 'Jul 15, 2026', bids: 8, approval: 'approved' },
  { id: 'P-2026-002', name: 'Hospital Equipment Procurement', budget: '$890K', deadline: 'Jun 30, 2026', bids: 5, approval: 'approved' },
  { id: 'P-2026-003', name: 'IT Systems Upgrade', budget: '$450K', deadline: 'Aug 1, 2026', bids: 0, approval: 'pending_head' },
  { id: 'P-2026-004', name: 'School Construction Batch A', budget: '$3.1M', deadline: 'May 20, 2026', bids: 6, approval: 'awarded' },
  { id: 'P-2026-005', name: 'Water Treatment Facility', budget: '$1.7M', deadline: 'Sep 10, 2026', bids: 0, approval: 'pending_head' },
]

const BIDS = [
  { supplier: 'BuildRight Corp', project: 'Road Infrastructure Phase 2', amount: '$2.1M', score: 88, status: 'submitted' },
  { supplier: 'MedSupply Ltd', project: 'Hospital Equipment Procurement', amount: '$820K', score: 92, status: 'shortlisted' },
  { supplier: 'TechForward Inc', project: 'Road Infrastructure Phase 2', amount: '$2.0M', score: 76, status: 'submitted' },
  { supplier: 'Global Builders', project: 'Road Infrastructure Phase 2', amount: '$2.3M', score: 81, status: 'submitted' },
  { supplier: 'AquaTech Solutions', project: 'Hospital Equipment Procurement', amount: '$860K', score: 94, status: 'shortlisted' },
]

const APPROVAL_BADGE = {
  pending_head: ['badge-yellow', 'Pending Head Approval'],
  approved: ['badge-green', 'Approved — Live'],
  rejected: ['badge-red', 'Rejected by Head'],
  awarded: ['badge-blue', 'Awarded'],
}

const STATUS_BADGE = {
  submitted: 'badge-yellow',
  shortlisted: 'badge-green',
  rejected: 'badge-red',
  winner: 'badge-blue',
}

function Sidebar({ active }) {
  const navigate = useNavigate()
  return (
    <aside className="ad-sidebar">
      <div className="ad-sidebar-logo">
        <span className="lp-logo-icon"><Shield size={16} /></span>
        <div>
          <div className="lp-logo-name">E-Procurement</div>
          <div className="lp-logo-sub" style={{ color: '#64748b' }}>Admin Panel</div>
        </div>
      </div>
      <nav className="ad-sidebar-nav">
        {NAV.map(({ icon: Icon, label, to }) => (
          <Link
            key={to}
            to={to}
            className={`ad-nav-item ${active === to ? 'active' : ''}`}
          >
            <Icon size={18} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
      <button className="ad-logout" onClick={() => navigate('/login')}>
        <LogOut size={16} />
        <span>Log out</span>
      </button>
    </aside>
  )
}

function Header({ title }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <header className="ad-header">
      <div className="ad-header-left">
        <h1 className="ad-page-title">{title}</h1>
      </div>
      <div className="ad-header-right">
        <div className="ad-search">
          <Search size={15} />
          <input placeholder="Search…" />
        </div>
        <button className="ad-notif">
          <Bell size={18} />
          <span className="ad-notif-dot" />
        </button>
        <div className="ad-user-wrap">
          <div className="ad-user" onClick={() => setOpen(o => !o)}>
            <div className="ad-avatar">A</div>
            <div className="ad-user-info">
              <span className="ad-user-name">Admin User</span>
              <span className="ad-user-role">System Admin</span>
            </div>
            <ChevronDown size={14} color="#64748b" className={open ? 'rotate-180' : ''} />
          </div>
          {open && (
            <>
              <div className="ad-dropdown-backdrop" onClick={() => setOpen(false)} />
              <div className="ad-dropdown">
                <div className="ad-dropdown-header">
                  <div className="ad-avatar">A</div>
                  <div>
                    <div className="ad-dropdown-name">Admin User</div>
                    <div className="ad-dropdown-email">admin@eprocure.gov</div>
                  </div>
                </div>
                <div className="ad-dropdown-divider" />
                <button className="ad-dropdown-item" onClick={() => { setOpen(false); navigate('/admin/settings') }}>
                  <Settings size={15} /> Settings
                </button>
                <div className="ad-dropdown-divider" />
                <button className="ad-dropdown-item ad-dropdown-logout" onClick={() => navigate('/login')}>
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

function DashboardHome() {
  return (
    <div className="ad-content">
      {/* Stats */}
      <div className="ad-stats">
        {STATS.map(({ label, value, change, up, icon: Icon, color }) => (
          <div className={`ad-stat-card ad-stat-${color}`} key={label}>
            <div className="ad-stat-top">
              <div className="ad-stat-label">{label}</div>
              <div className={`ad-stat-icon-wrap ad-stat-icon-${color}`}><Icon size={18} /></div>
            </div>
            <div className="ad-stat-value">{value}</div>
            <div className="ad-stat-change">
              {up !== null && (up ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
              {change}
            </div>
          </div>
        ))}
      </div>

      {/* Recent Projects */}
      <div className="ad-card">
        <div className="ad-card-header">
          <div>
            <h2>My Projects</h2>
            <p>Projects you created — waiting for Head approval or already live</p>
          </div>
          <div className="ad-card-actions">
            <button className="ad-btn-icon"><Filter size={15} /></button>
            <Link to="/admin/projects" className="btn-primary" style={{ fontSize: 13, padding: '8px 16px' }}>
              <Plus size={14} /> New Project
            </Link>
          </div>
        </div>
        <div className="ad-table-wrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Project ID</th>
                <th>Project Name</th>
                <th>Budget</th>
                <th>Deadline</th>
                <th>Bids</th>
                <th>Head Approval</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {PROJECTS.map(p => {
                const [cls, label] = APPROVAL_BADGE[p.approval]
                return (
                  <tr key={p.id}>
                    <td className="ad-id">{p.id}</td>
                    <td className="ad-bold">{p.name}</td>
                    <td>{p.budget}</td>
                    <td className="ad-muted">{p.deadline}</td>
                    <td>
                      {p.approval === 'pending_head'
                        ? <span className="ad-muted" style={{ fontSize: 12 }}>—</span>
                        : <span className="ad-bid-count">{p.bids}</span>}
                    </td>
                    <td><span className={`badge ${cls}`}>{label}</span></td>
                    <td><button className="ad-btn-icon"><MoreHorizontal size={16} /></button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bottom grid */}
      <div className="ad-bottom-grid">
        {/* Recent Bids */}
        <div className="ad-card">
          <div className="ad-card-header">
            <div>
              <h2>All Supplier Bids</h2>
              <p>All bids submitted on your approved projects</p>
            </div>
            <Link to="/admin/bids" className="ad-view-all">View all →</Link>
          </div>
          <div className="ad-bids-list">
            {BIDS.map((b, i) => (
              <div className="ad-bid-row" key={i}>
                <div className="ad-bid-avatar">{b.supplier[0]}</div>
                <div className="ad-bid-info">
                  <span className="ad-bold">{b.supplier}</span>
                  <span className="ad-muted">{b.project}</span>
                </div>
                <div className="ad-bid-right">
                  <span className="ad-bid-amount">{b.amount}</span>
                  <span className={`badge ${STATUS_BADGE[b.status]}`}>{b.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Activity */}
        <div className="ad-card">
          <div className="ad-card-header">
            <div><h2>Recent Activity</h2><p>System events and updates</p></div>
          </div>
          <div className="ad-activity">
            {[
              { icon: CheckCircle2, color: 'green', text: 'Head approved Road Infrastructure Phase 2', time: '1 hour ago' },
              { icon: FileText, color: 'yellow', text: 'New bid from BuildRight Corp received', time: '3 hours ago' },
              { icon: AlertCircle, color: 'yellow', text: 'IT Systems Upgrade pending Head approval', time: '5 hours ago' },
              { icon: PlusCircle, color: 'purple', text: 'Water Treatment Facility project created', time: '1 day ago' },
              { icon: Link2, color: 'green', text: 'Contract P-2026-004 recorded on blockchain', time: '2 days ago' },
            ].map(({ icon: Icon, color, text, time }, i) => (
              <div className="ad-activity-row" key={i}>
                <div className={`ad-act-icon ad-act-${color}`}><Icon size={14} /></div>
                <div className="ad-act-info">
                  <span>{text}</span>
                  <span className="ad-muted">{time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ProjectsPage() {
  return (
    <div className="ad-content">
      <div className="ad-card">
        <div className="ad-card-header">
          <div>
            <h2>All Projects</h2>
            <p>Manage all procurement projects</p>
          </div>
          <div className="ad-card-actions">
            <button className="ad-btn-outline"><Filter size={14} /> Filter</button>
            <button className="ad-btn-outline"><Download size={14} /> Export</button>
            <button className="btn-primary" style={{ fontSize: 13, padding: '8px 16px' }}>
              <Plus size={14} /> New Project
            </button>
          </div>
        </div>
        <div className="ad-table-wrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>ID</th><th>Name</th><th>Budget</th><th>Deadline</th><th>Bids</th><th>Head Approval</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {PROJECTS.map(p => {
                const [cls, label] = APPROVAL_BADGE[p.approval]
                return (
                  <tr key={p.id}>
                    <td className="ad-id">{p.id}</td>
                    <td className="ad-bold">{p.name}</td>
                    <td>{p.budget}</td>
                    <td className="ad-muted">{p.deadline}</td>
                    <td>
                      {p.approval === 'pending_head'
                        ? <span className="ad-muted" style={{ fontSize: 12 }}>Not live yet</span>
                        : <span className="ad-bid-count">{p.bids}</span>}
                    </td>
                    <td><span className={`badge ${cls}`}>{label}</span></td>
                    <td>
                      <div className="ad-actions-row">
                        <button className="ad-btn-icon"><Eye size={15} /></button>
                        <button className="ad-btn-icon"><MoreHorizontal size={15} /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function SuppliersPage() {
  const SUPPLIERS = [
    { name: 'BuildRight Corp', contact: 'john@buildright.com', projects: 3, status: 'approved' },
    { name: 'MedSupply Ltd', contact: 'info@medsupply.com', projects: 1, status: 'approved' },
    { name: 'TechForward Inc', contact: 'hello@techforward.io', projects: 2, status: 'pending' },
    { name: 'Global Builders', contact: 'gb@globalbuilders.net', projects: 4, status: 'approved' },
    { name: 'AquaTech Solutions', contact: 'aq@aquatech.com', projects: 1, status: 'approved' },
    { name: 'SkyConstruct Ltd', contact: 'sky@skyconstruct.ph', projects: 0, status: 'pending' },
  ]
  return (
    <div className="ad-content">
      <div className="ad-card">
        <div className="ad-card-header">
          <div><h2>Supplier Management</h2><p>Review and approve registered suppliers</p></div>
          <div className="ad-card-actions">
            <button className="ad-btn-outline"><Filter size={14} /> Filter</button>
            <button className="btn-primary" style={{ fontSize: 13, padding: '8px 16px' }}>
              <Plus size={14} /> Invite Supplier
            </button>
          </div>
        </div>
        <div className="ad-table-wrap">
          <table className="ad-table">
            <thead>
              <tr><th>Company</th><th>Contact</th><th>Projects</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {SUPPLIERS.map(s => (
                <tr key={s.name}>
                  <td>
                    <div className="ad-supplier-row">
                      <div className="ad-avatar">{s.name[0]}</div>
                      <span className="ad-bold">{s.name}</span>
                    </div>
                  </td>
                  <td className="ad-muted">{s.contact}</td>
                  <td><span className="ad-bid-count">{s.projects}</span></td>
                  <td><span className={`badge ${s.status === 'approved' ? 'badge-green' : 'badge-yellow'}`}>{s.status}</span></td>
                  <td>
                    <div className="ad-actions-row">
                      {s.status === 'pending' && (
                        <>
                          <button className="ad-btn-approve">Approve</button>
                          <button className="ad-btn-reject">Reject</button>
                        </>
                      )}
                      {s.status === 'approved' && <button className="ad-btn-icon"><Eye size={15} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function BidsPage() {
  return (
    <div className="ad-content">
      <div className="ad-card">
        <div className="ad-card-header">
          <div>
            <h2>All Supplier Bids</h2>
            <p>All bids submitted on your Head-approved projects — select a winner to finalize</p>
          </div>
          <div className="ad-card-actions">
            <button className="ad-btn-outline"><Filter size={14} /> Filter</button>
            <button className="ad-btn-outline"><RefreshCw size={14} /> Refresh</button>
          </div>
        </div>
        <div className="ad-table-wrap">
          <table className="ad-table">
            <thead>
              <tr><th>Supplier</th><th>Project</th><th>Bid Amount</th><th>Score</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {BIDS.map((b, i) => (
                <tr key={i}>
                  <td className="ad-bold">{b.supplier}</td>
                  <td className="ad-muted">{b.project}</td>
                  <td>{b.amount}</td>
                  <td>
                    <div className="ad-score-wrap">
                      <div className="ad-score-bar">
                        <div className="ad-score-fill" style={{ width: `${b.score}%` }} />
                      </div>
                      <span>{b.score}</span>
                    </div>
                  </td>
                  <td><span className={`badge ${STATUS_BADGE[b.status]}`}>{b.status}</span></td>
                  <td>
                    <div className="ad-actions-row">
                      <button className="ad-btn-icon"><Eye size={15} /></button>
                      {b.status === 'submitted' && <button className="ad-btn-approve">Shortlist</button>}
                      {b.status === 'shortlisted' && <button className="ad-btn-winner">Pick Winner</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function BlockchainPage() {
  const RECORDS = [
    { hash: '0x3a9f...c12e', event: 'Contract Awarded', project: 'School Construction Batch A', timestamp: '2026-05-20 14:32:11', verified: true },
    { hash: '0x7b2d...e45a', event: 'Bid Submitted', project: 'Hospital Equipment', timestamp: '2026-06-01 09:15:44', verified: true },
    { hash: '0xf41c...9801', event: 'Supplier Approved', project: '—', timestamp: '2026-06-03 11:02:30', verified: true },
    { hash: '0x92ab...3d7f', event: 'Project Created', project: 'Water Treatment Facility', timestamp: '2026-06-05 16:48:22', verified: true },
    { hash: '0x1e5c...a930', event: 'Bid Submitted', project: 'Road Infrastructure Phase 2', timestamp: '2026-06-08 08:55:17', verified: true },
  ]
  return (
    <div className="ad-content">
      <div className="ad-stats" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        {[
          { label: 'Total Records', value: '284', icon: Link2, color: 'blue' },
          { label: 'Verified Transactions', value: '284', icon: CheckCircle2, color: 'green' },
          { label: 'Last Block', value: '#19,482', icon: Shield, color: 'purple' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div className={`ad-stat-card ad-stat-${color}`} key={label}>
            <div className="ad-stat-top">
              <div className="ad-stat-label">{label}</div>
              <div className={`ad-stat-icon-wrap ad-stat-icon-${color}`}><Icon size={18} /></div>
            </div>
            <div className="ad-stat-value">{value}</div>
          </div>
        ))}
      </div>
      <div className="ad-card">
        <div className="ad-card-header">
          <div><h2>Blockchain Ledger</h2><p>Immutable record of all procurement events</p></div>
          <button className="ad-btn-outline"><Download size={14} /> Export</button>
        </div>
        <div className="ad-table-wrap">
          <table className="ad-table">
            <thead>
              <tr><th>Tx Hash</th><th>Event</th><th>Project</th><th>Timestamp</th><th>Verified</th></tr>
            </thead>
            <tbody>
              {RECORDS.map((r, i) => (
                <tr key={i}>
                  <td className="ad-id ad-mono">{r.hash}</td>
                  <td className="ad-bold">{r.event}</td>
                  <td className="ad-muted">{r.project}</td>
                  <td className="ad-muted">{r.timestamp}</td>
                  <td>
                    {r.verified
                      ? <span className="badge badge-green"><CheckCircle2 size={11} /> Verified</span>
                      : <span className="badge badge-yellow"><AlertCircle size={11} /> Pending</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default function AdminDashboard() {
  const loc = useLocation()
  const PAGE_TITLES = {
    '/admin': 'Dashboard',
    '/admin/projects': 'Projects',
    '/admin/suppliers': 'Suppliers',
    '/admin/bids': 'Bids',
    '/admin/evaluation': 'Evaluation',
    '/admin/blockchain': 'Blockchain',
    '/admin/settings': 'Settings',
  }
  const title = PAGE_TITLES[loc.pathname] || 'Dashboard'

  return (
    <div className="ad-layout">
      <Sidebar active={loc.pathname} />
      <div className="ad-main">
        <Header title={title} />
        <div className="ad-body">
          <Routes>
            <Route index element={<DashboardHome />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="suppliers" element={<SuppliersPage />} />
            <Route path="bids" element={<BidsPage />} />
            <Route path="blockchain" element={<BlockchainPage />} />
            <Route path="*" element={<DashboardHome />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
