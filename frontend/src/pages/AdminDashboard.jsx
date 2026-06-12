import { useState, useRef } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, Users, FileText, BarChart2,
  Bell, Search, ChevronDown, LogOut,
  Clock, CheckCircle2, Plus, Shield, Send
} from 'lucide-react'
import '../style/AdminDashboard.css'

const NAV = [
  { icon: LayoutDashboard, label: 'Dashboard', to: '/admin' },
  { icon: FolderOpen,      label: 'Projects',  to: '/admin/projects' },
  { icon: Users,           label: 'Suppliers', to: '/admin/suppliers' },
  { icon: FileText,        label: 'Bids',      to: '/admin/bids' },
]

const CATEGORIES = ['Infrastructure', 'Technology', 'Medical', 'Environment', 'Education', 'Other']

const INITIAL_PROJECTS = [
  { id: 'P-2026-001', name: 'Road Infrastructure Phase 2',    budget: '$2.4M', deadline: 'Jul 15, 2026', category: 'Infrastructure', bids: 8, status: 'published',     createdAt: 'May 28, 2026', description: 'Phase 2 of road works covering districts 3–5.' },
  { id: 'P-2026-002', name: 'Hospital Equipment Procurement', budget: '$890K', deadline: 'Jun 30, 2026', category: 'Medical',        bids: 5, status: 'published',     createdAt: 'May 25, 2026', description: 'Medical equipment for the district hospital.' },
  { id: 'P-2026-003', name: 'IT Systems Upgrade',             budget: '$450K', deadline: 'Aug 1, 2026',  category: 'Technology',     bids: 0, status: 'pending_head',  createdAt: 'Jun 8, 2026',  description: 'Upgrade of school IT infrastructure and network.' },
  { id: 'P-2026-004', name: 'School Construction Batch A',    budget: '$3.1M', deadline: 'May 20, 2026', category: 'Infrastructure', bids: 6, status: 'awarded',       createdAt: 'Apr 5, 2026',  description: 'Construction of 3 new school buildings.' },
  { id: 'P-2026-005', name: 'Water Treatment Facility',       budget: '$1.7M', deadline: 'Sep 10, 2026', category: 'Environment',    bids: 0, status: 'approved_head', createdAt: 'Jun 5, 2026',  description: 'Construction of a water treatment facility.' },
]

const INITIAL_BIDS = [
  { supplier: 'BuildRight Corp',    email: 'john@buildright.com',    project: 'Road Infrastructure Phase 2',    amount: '$2.1M', score: 88, status: 'submitted',   notes: 'Experienced local team, 24-month timeline. ISO 9001 certified.' },
  { supplier: 'MedSupply Ltd',      email: 'info@medsupply.com',     project: 'Hospital Equipment Procurement', amount: '$820K', score: 92, status: 'shortlisted', notes: 'Authorized distributor, 2-year warranty, 60-day delivery.' },
  { supplier: 'TechForward Inc',    email: 'hello@techforward.io',   project: 'Road Infrastructure Phase 2',    amount: '$2.0M', score: 76, status: 'submitted',   notes: 'Best price offer, 20-month timeline.' },
  { supplier: 'Global Builders',    email: 'gb@globalbuilders.net',  project: 'Road Infrastructure Phase 2',    amount: '$2.3M', score: 81, status: 'submitted',   notes: 'Premium materials, 5+ years in government projects.' },
  { supplier: 'AquaTech Solutions', email: 'aq@aquatech.com',        project: 'Hospital Equipment Procurement', amount: '$860K', score: 94, status: 'shortlisted', notes: 'Full warranty, on-site training, 1-year maintenance.' },
]

const INITIAL_SUPPLIERS = [
  { name: 'BuildRight Corp',    email: 'john@buildright.com',   category: 'Infrastructure', status: 'approved', joined: 'May 15, 2026', bids: 2 },
  { name: 'MedSupply Ltd',      email: 'info@medsupply.com',    category: 'Medical',        status: 'approved', joined: 'May 18, 2026', bids: 1 },
  { name: 'TechForward Inc',    email: 'hello@techforward.io',  category: 'Technology',     status: 'approved', joined: 'May 20, 2026', bids: 1 },
  { name: 'Global Builders',    email: 'gb@globalbuilders.net', category: 'Infrastructure', status: 'approved', joined: 'May 22, 2026', bids: 1 },
  { name: 'AquaTech Solutions', email: 'aq@aquatech.com',       category: 'Environment',    status: 'approved', joined: 'Jun 1, 2026',  bids: 1 },
  { name: 'EduBuild Co',        email: 'info@edubuild.com',     category: 'Education',      status: 'pending',  joined: 'Jun 8, 2026',  bids: 0 },
]

const STATUS_BADGE = {
  draft:         ['badge-gray',   'Draft'],
  pending_head:  ['badge-yellow', 'Pending Head Approval'],
  approved_head: ['badge-green',  'Approved by Head'],
  rejected_head: ['badge-red',    'Rejected by Head'],
  published:     ['badge-blue',   'Published — Live'],
  awarded:       ['badge-purple', 'Awarded'],
}

const BID_BADGE = {
  submitted:   'badge-yellow',
  shortlisted: 'badge-green',
  rejected:    'badge-red',
  winner:      'badge-blue',
}

function Sidebar({ active }) {
  const navigate = useNavigate()
  return (
    <aside className="ad-sidebar">
      <div className="ad-sidebar-logo">
        <span className="ad-logo-icon"><Shield size={16} /></span>
        <div>
          <div className="ad-logo-name">E-Procurement</div>
          <div className="ad-logo-sub">Admin Panel</div>
        </div>
      </div>
      <nav className="ad-sidebar-nav">
        {NAV.map(({ icon: Icon, label, to }) => (
          <Link key={to} to={to} className={`ad-nav-item${active === to ? ' active' : ''}`}>
            <Icon size={18} /><span>{label}</span>
          </Link>
        ))}
      </nav>
      <button className="ad-logout" onClick={() => navigate('/login')}>
        <LogOut size={16} /><span>Log out</span>
      </button>
    </aside>
  )
}

function Header({ title }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <header className="ad-header">
      <h1 className="ad-page-title">{title}</h1>
      <div className="ad-header-right">
        <div className="ad-search">
          <Search size={15} />
          <input placeholder="Search…" />
        </div>
        <button className="ad-notif">
          <Bell size={18} /><span className="ad-notif-dot" />
        </button>
        <div className="ad-user-wrap">
          <div className="ad-user" onClick={() => setOpen(o => !o)}>
            <div className="ad-avatar">A</div>
            <div className="ad-user-info">
              <span className="ad-user-name">Admin User</span>
              <span className="ad-user-role">System Admin</span>
            </div>
            <ChevronDown size={14} color="#64748b" />
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

function DashboardHome({ projects }) {
  const pendingHead  = projects.filter(p => p.status === 'pending_head').length
  const approvedHead = projects.filter(p => p.status === 'approved_head').length
  const awarded      = projects.filter(p => p.status === 'awarded').length
  const totalBids    = projects.reduce((s, p) => s + p.bids, 0)

  const STATS = [
    { label: 'My Projects',         value: String(projects.length), sub: `${approvedHead} ready to publish`, icon: FolderOpen,   color: 'blue'   },
    { label: 'Pending Head Review', value: String(pendingHead),     sub: 'Awaiting Head approval',           icon: Clock,        color: 'yellow' },
    { label: 'Total Bids Received', value: String(totalBids),       sub: 'Across all published projects',    icon: FileText,     color: 'green'  },
    { label: 'Awarded Contracts',   value: String(awarded),         sub: '+1 this month',                    icon: CheckCircle2, color: 'purple' },
  ]

  return (
    <div className="ad-content">
      <div className="ad-stats">
        {STATS.map(({ label, value, sub, icon: Icon, color }) => (
          <div className="ad-stat-card" key={label}>
            <div className="ad-stat-top">
              <span className="ad-stat-label">{label}</span>
              <div className={`ad-stat-icon ad-icon-${color}`}><Icon size={18} /></div>
            </div>
            <div className="ad-stat-value">{value}</div>
            <div className="ad-stat-sub">{sub}</div>
          </div>
        ))}
      </div>

      <div className="ad-bottom-grid">
        <div className="ad-card">
          <div className="ad-card-header">
            <div>
              <h2>Recent Projects</h2>
              <p>Latest procurement projects</p>
            </div>
            <Link to="/admin/projects" className="ad-view-all">View all →</Link>
          </div>
          <table className="ad-table">
            <thead>
              <tr><th>ID</th><th>Name</th><th>Budget</th><th>Status</th></tr>
            </thead>
            <tbody>
              {projects.slice(0, 5).map(p => {
                const [cls, lbl] = STATUS_BADGE[p.status] || ['badge-gray', p.status]
                return (
                  <tr key={p.id}>
                    <td className="ad-mono">{p.id}</td>
                    <td className="ad-bold">{p.name}</td>
                    <td>{p.budget}</td>
                    <td><span className={`badge ${cls}`}>{lbl}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="ad-card">
          <div className="ad-card-header">
            <div>
              <h2>Recent Bids</h2>
              <p>Latest supplier submissions</p>
            </div>
            <Link to="/admin/bids" className="ad-view-all">View all →</Link>
          </div>
          <div className="ad-bids-list">
            {INITIAL_BIDS.slice(0, 4).map((b, i) => (
              <div className="ad-bid-row" key={i}>
                <div className="ad-bid-avatar">{b.supplier[0]}</div>
                <div className="ad-bid-info">
                  <span className="ad-bold">{b.supplier}</span>
                  <span className="ad-muted">{b.project}</span>
                </div>
                <div className="ad-bid-right">
                  <span className="ad-bold">{b.amount}</span>
                  <span className={`badge ${BID_BADGE[b.status] || 'badge-gray'}`}>{b.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ProjectsPage({ projects, onAdd, onSubmitToHead, onPublish }) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ title: '', budget: '', deadline: '', category: 'Infrastructure', description: '' })

  const handleSubmit = (e) => {
    e.preventDefault()
    onAdd(form)
    setForm({ title: '', budget: '', deadline: '', category: 'Infrastructure', description: '' })
    setShowForm(false)
  }

  return (
    <div className="ad-content">
      <div className="ad-card">
        <div className="ad-card-header">
          <div>
            <h2>All Projects</h2>
            <p>Manage procurement projects</p>
          </div>
          <button className="ad-btn-primary" onClick={() => setShowForm(v => !v)}>
            <Plus size={15} /> New Project
          </button>
        </div>

        {showForm && (
          <div className="ad-form-wrap">
            <div className="ad-form-title">Create New Project</div>
            <form onSubmit={handleSubmit} className="ad-form-grid">
              <div className="ad-form-group">
                <label>Project Title</label>
                <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Road Infrastructure Phase 3" required />
              </div>
              <div className="ad-form-group">
                <label>Budget</label>
                <input value={form.budget} onChange={e => setForm({ ...form, budget: e.target.value })} placeholder="e.g. $1.2M" required />
              </div>
              <div className="ad-form-group">
                <label>Deadline</label>
                <input type="date" value={form.deadline} onChange={e => setForm({ ...form, deadline: e.target.value })} required />
              </div>
              <div className="ad-form-group">
                <label>Category</label>
                <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="ad-form-group ad-form-full">
                <label>Description</label>
                <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={3} placeholder="Brief description of the project scope…" required />
              </div>
              <div className="ad-form-actions">
                <button type="button" className="ad-btn-cancel" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="ad-btn-primary">Create Project</button>
              </div>
            </form>
          </div>
        )}

        <table className="ad-table">
          <thead>
            <tr>
              <th>ID</th><th>Name</th><th>Budget</th><th>Category</th>
              <th>Deadline</th><th>Bids</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {projects.map(p => {
              const [cls, lbl] = STATUS_BADGE[p.status] || ['badge-gray', p.status]
              return (
                <tr key={p.id}>
                  <td className="ad-mono">{p.id}</td>
                  <td className="ad-bold">{p.name}</td>
                  <td>{p.budget}</td>
                  <td><span className="badge badge-blue">{p.category}</span></td>
                  <td className="ad-muted">{p.deadline}</td>
                  <td>{p.bids}</td>
                  <td><span className={`badge ${cls}`}>{lbl}</span></td>
                  <td>
                    <div className="ad-actions">
                      {p.status === 'draft' && (
                        <button className="ad-btn-send" onClick={() => onSubmitToHead(p.id)}>
                          <Send size={12} /> Send to Head
                        </button>
                      )}
                      {p.status === 'approved_head' && (
                        <button className="ad-btn-publish" onClick={() => onPublish(p.id)}>
                          Publish
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SuppliersPage() {
  const [suppliers, setSuppliers] = useState(INITIAL_SUPPLIERS)
  const approve = (email) => setSuppliers(s => s.map(x => x.email === email ? { ...x, status: 'approved' } : x))
  const reject  = (email) => setSuppliers(s => s.map(x => x.email === email ? { ...x, status: 'rejected' } : x))

  return (
    <div className="ad-content">
      <div className="ad-card">
        <div className="ad-card-header">
          <div>
            <h2>Registered Suppliers</h2>
            <p>Manage supplier accounts and approvals</p>
          </div>
        </div>
        <table className="ad-table">
          <thead>
            <tr><th>Supplier</th><th>Email</th><th>Category</th><th>Joined</th><th>Bids</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {suppliers.map(s => (
              <tr key={s.email}>
                <td className="ad-bold">{s.name}</td>
                <td className="ad-muted">{s.email}</td>
                <td><span className="badge badge-blue">{s.category}</span></td>
                <td className="ad-muted">{s.joined}</td>
                <td>{s.bids}</td>
                <td>
                  <span className={`badge ${s.status === 'approved' ? 'badge-green' : s.status === 'rejected' ? 'badge-red' : 'badge-yellow'}`}>
                    {s.status}
                  </span>
                </td>
                <td>
                  {s.status === 'pending' && (
                    <div className="ad-actions">
                      <button className="ad-btn-approve" onClick={() => approve(s.email)}>Approve</button>
                      <button className="ad-btn-reject"  onClick={() => reject(s.email)}>Reject</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
            <h2>All Bids</h2>
            <p>Review and evaluate supplier bids</p>
          </div>
        </div>
        <table className="ad-table">
          <thead>
            <tr><th>Supplier</th><th>Project</th><th>Amount</th><th>Score</th><th>Status</th><th>Notes</th></tr>
          </thead>
          <tbody>
            {INITIAL_BIDS.map((b, i) => (
              <tr key={i}>
                <td>
                  <div className="ad-supplier-cell">
                    <div className="ad-bid-avatar">{b.supplier[0]}</div>
                    <div>
                      <div className="ad-bold">{b.supplier}</div>
                      <div className="ad-muted ad-small">{b.email}</div>
                    </div>
                  </div>
                </td>
                <td className="ad-muted">{b.project}</td>
                <td className="ad-bold">{b.amount}</td>
                <td>
                  <div className="ad-score-wrap">
                    <span className="ad-score">{b.score}</span>
                    <div className="ad-score-bar">
                      <div className="ad-score-fill" style={{ width: `${b.score}%` }} />
                    </div>
                  </div>
                </td>
                <td><span className={`badge ${BID_BADGE[b.status] || 'badge-gray'}`}>{b.status}</span></td>
                <td className="ad-muted ad-small" style={{ maxWidth: 200 }}>{b.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function AdminDashboard() {
  const loc = useLocation()
  const [projects, setProjects] = useState(INITIAL_PROJECTS)
  const idRef = useRef(6)

  const addProject = (form) => {
    const deadline = form.deadline
      ? new Date(form.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : ''
    setProjects(prev => [{
      id: `P-2026-00${idRef.current++}`,
      name: form.title,
      budget: form.budget,
      deadline,
      category: form.category,
      bids: 0,
      status: 'draft',
      createdAt: 'Just now',
      description: form.description,
    }, ...prev])
  }

  const submitToHead  = (id) => setProjects(prev => prev.map(p => p.id === id ? { ...p, status: 'pending_head' } : p))
  const publishProject = (id) => setProjects(prev => prev.map(p => p.id === id ? { ...p, status: 'published' }   : p))

  const PAGE_TITLES = {
    '/admin':           'Dashboard',
    '/admin/projects':  'Projects',
    '/admin/suppliers': 'Suppliers',
    '/admin/bids':      'Bids',
  }
  const title = PAGE_TITLES[loc.pathname] || 'Dashboard'

  return (
    <div className="ad-layout">
      <Sidebar active={loc.pathname} />
      <div className="ad-main">
        <Header title={title} />
        <div className="ad-body">
          <Routes>
            <Route index element={<DashboardHome projects={projects} />} />
            <Route path="projects"  element={<ProjectsPage projects={projects} onAdd={addProject} onSubmitToHead={submitToHead} onPublish={publishProject} />} />
            <Route path="suppliers" element={<SuppliersPage />} />
            <Route path="bids"      element={<BidsPage />} />
            <Route path="*"         element={<DashboardHome projects={projects} />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
