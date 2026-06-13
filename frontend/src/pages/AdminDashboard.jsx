import { useState, useRef } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, Calendar, Users, Pencil, Award, BarChart2,
  Bell, Search, ChevronDown, ChevronRight, LogOut, Shield,
  Plus, FileText, Activity, UserCheck, Info, Eye
} from 'lucide-react'
import '../style/AdminDashboard.css'

const NAV = [
  { icon: LayoutDashboard, label: 'Dashboard', to: '/admin' },
  { icon: FolderOpen,      label: 'Projects',  to: '/admin/projects' },
  { icon: Calendar,        label: 'Planning',  to: '/admin/planning' },
  { icon: Users,           label: 'Suppliers', to: '/admin/suppliers' },
  { icon: Pencil,          label: 'Bids',      to: '/admin/bids' },
  { icon: Award,           label: 'Awards',    to: '/admin/awards' },
  { icon: BarChart2,       label: 'Reports',   to: '/admin/reports' },
]

const INITIAL_PROJECTS = [
  {
    id: 'P-2026-001', name: 'computer',
    budget: '₱2,000', deadline: '6/3/2026',
    type: 'ICT Services', eligibleTypes: 'Open to All',
    bids: 1, status: 'awarded',
    description: 'Procurement of computer units for office use.',
  },
  {
    id: 'P-2026-002', name: 'chair/table',
    budget: '₱100,000', deadline: '7/10/2026',
    type: 'IT Equipment', eligibleTypes: 'Open to All',
    bids: 1, status: 'awarded',
    description: 'Procurement of chairs and tables for conference rooms.',
  },
]

const INITIAL_SUPPLIERS = [
  {
    id: 1, company: 'PA co.', contact: 'Kenthcharles Repollo',
    businessType: 'IT Equipment, ICT Services',
    status: 'draft', qualificationStatus: 'verified',
    emailVerified: 'Verified', registered: '6/1/2026',
  },
  {
    id: 2, company: 'PA co.', contact: 'coc',
    businessType: '53ce8d48-c8e8-45db-be63-d659c488e905',
    status: 'approved', qualificationStatus: 'waiting_admin_approval',
    emailVerified: 'Verified', registered: '6/1/2026',
  },
]

const INITIAL_AWARDS = [
  { supplier: 'Kenthcharles Repollo', project: 'computer',     amount: '₱1,000',   date: 'June 1, 2026', status: 'won' },
  { supplier: 'Kenthcharles Repollo', project: 'chair/table',  amount: '₱100,000', date: 'June 1, 2026', status: 'won' },
]

const EXPIRING_DOCS = [
  { company: 'PA co.', docType: "Mayor's Permit", date: '7/4/2026' },
  { company: 'PA co.', docType: 'Tax Clearance',  date: '7/3/2026' },
]

const STATUS_LABEL = {
  draft: 'Draft', pending_head: 'Pending', approved: 'Approved',
  published: 'Active', awarded: 'Awarded', closed: 'Closed', active: 'Active',
}
const STATUS_CLS = {
  draft: 'badge-gray', pending_head: 'badge-yellow', approved: 'badge-green',
  published: 'badge-blue', awarded: 'badge-awarded', active: 'badge-blue',
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ active }) {
  const navigate = useNavigate()
  return (
    <aside className="ad-sidebar">
      <div className="ad-sidebar-logo">
        <span className="ad-logo-icon"><Shield size={16} /></span>
        <div>
          <div className="ad-logo-name">E-Procurement</div>
          <div className="ad-logo-sub">Admin Workspace</div>
        </div>
      </div>

      <div className="ad-menu-section">
        <span className="ad-menu-label">MENU</span>
        <nav className="ad-sidebar-nav">
          {NAV.map(({ icon: Icon, label, to }) => (
            <Link key={to} to={to} className={`ad-nav-item${active === to ? ' active' : ''}`}>
              <Icon size={18} />
              <span>{label}</span>
              {active === to && <span className="ad-nav-dot" />}
            </Link>
          ))}
        </nav>
      </div>

      <div className="ad-sidebar-footer">
        <div className="ad-sidebar-user">
          <div className="ad-sidebar-avatar">S</div>
          <div className="ad-sidebar-user-info">
            <span className="ad-sidebar-user-name">System Administr...</span>
            <span className="ad-sidebar-user-email">admin@gmail.com</span>
          </div>
          <button
            className="ad-sidebar-expand"
            onClick={() => { localStorage.removeItem('role'); navigate('/login') }}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </aside>
  )
}

// ── Header ────────────────────────────────────────────────────────────────────

function Header({ title }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <header className="ad-header">
      <div className="ad-header-left">
        <div className="ad-workspace-label">ADMIN WORKSPACE</div>
        <h1 className="ad-page-title">{title}</h1>
      </div>
      <div className="ad-header-right">
        <div className="ad-search">
          <Search size={15} />
          <input placeholder="Search..." />
          <span className="ad-search-shortcut">Ctrl+4</span>
        </div>
        <button className="ad-notif">
          <Bell size={18} /><span className="ad-notif-dot" />
        </button>
        <div className="ad-user-wrap">
          <div className="ad-user" onClick={() => setOpen(o => !o)}>
            <div className="ad-avatar">S</div>
            <span className="ad-user-name">System Administrator</span>
            <div className="ad-avatar-dark">N</div>
          </div>
          {open && (
            <>
              <div className="ad-dropdown-backdrop" onClick={() => setOpen(false)} />
              <div className="ad-dropdown">
                <div className="ad-dropdown-header">
                  <div className="ad-avatar">S</div>
                  <div>
                    <div className="ad-dropdown-name">System Administrator</div>
                    <div className="ad-dropdown-email">admin@gmail.com</div>
                  </div>
                </div>
                <div className="ad-dropdown-divider" />
                <button className="ad-dropdown-item ad-dropdown-logout"
                  onClick={() => { localStorage.removeItem('role'); navigate('/login') }}>
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

// ── Dashboard Home ────────────────────────────────────────────────────────────

function DashboardHome({ projects, awards }) {
  const [tab, setTab] = useState('All')
  const TABS = ['All', 'Draft', 'Active', 'Closed', 'Awarded']

  const totalProjects    = projects.length
  const totalBids        = projects.reduce((s, p) => s + p.bids, 0)
  const activeBidding    = projects.filter(p => p.status === 'published' || p.status === 'active').length
  const awardedContracts = projects.filter(p => p.status === 'awarded').length

  const STATS = [
    { label: 'TOTAL PROJECTS',    value: totalProjects,    sub: 'All created procurement projects', icon: FolderOpen  },
    { label: 'TOTAL BIDS',        value: totalBids,        sub: 'Submitted bid entries',            icon: FileText    },
    { label: 'ACTIVE BIDDING',    value: activeBidding,    sub: 'Projects currently open',          icon: Activity    },
    { label: 'AWARDED CONTRACTS', value: awardedContracts, sub: 'Finalized awards',                 icon: UserCheck   },
  ]

  const filtered = projects.filter(p => {
    if (tab === 'All')     return true
    if (tab === 'Awarded') return p.status === 'awarded'
    if (tab === 'Active')  return p.status === 'published' || p.status === 'active'
    if (tab === 'Draft')   return p.status === 'draft'
    if (tab === 'Closed')  return p.status === 'closed'
    return true
  })

  return (
    <div className="ad-content">
      <div className="ad-stats">
        {STATS.map(({ label, value, sub, icon: Icon }) => (
          <div className="ad-stat-card" key={label}>
            <div className="ad-stat-top">
              <span className="ad-stat-label">{label}</span>
              <div className="ad-stat-icon-wrap"><Icon size={18} /></div>
            </div>
            <div className="ad-stat-value">{value}</div>
            <div className="ad-stat-sub">{sub}</div>
          </div>
        ))}
      </div>

      <div className="ad-dash-grid">
        <div className="ad-dash-main">
          <div className="ad-card">
            <div className="ad-card-header">
              <div>
                <h2>Recent Projects</h2>
                <p>Last 10 projects by status</p>
              </div>
            </div>
            <div className="ad-filter-pills">
              {TABS.map(t => (
                <button
                  key={t}
                  className={`ad-pill${tab === t ? ' ad-pill-active' : ''}`}
                  onClick={() => setTab(t)}
                >{t}</button>
              ))}
            </div>
            <div className="ad-project-list">
              {filtered.length === 0
                ? <div className="ad-empty-msg">No projects in this category.</div>
                : filtered.map(p => (
                  <div className="ad-project-row" key={p.id}>
                    <div>
                      <div className="ad-bold">{p.name}</div>
                      <div className="ad-muted ad-small">{p.budget} · {p.deadline}</div>
                    </div>
                    <span className={`badge ${STATUS_CLS[p.status] || 'badge-gray'}`}>
                      • {STATUS_LABEL[p.status] || p.status}
                    </span>
                  </div>
                ))
              }
            </div>
          </div>

          <div className="ad-card ad-card-mt">
            <div className="ad-card-header">
              <h2>Expiring Documents (30 days)</h2>
            </div>
            <div className="ad-expiring-list">
              {EXPIRING_DOCS.map((doc, i) => (
                <div className="ad-expiring-row" key={i}>
                  <div>
                    <div className="ad-bold">{doc.company}</div>
                    <div className="ad-muted ad-small">{doc.docType}</div>
                  </div>
                  <span className="ad-expiring-date">{doc.date}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="ad-dash-side">
          <div className="ad-card">
            <div className="ad-card-header">
              <h2>Next Actions</h2>
            </div>
            <div className="ad-next-actions">
              <Link to="/admin/projects" className="ad-next-action">
                <div>
                  <div className="ad-bold">Create or Manage Projects</div>
                  <div className="ad-muted ad-small">Review draft, active, and awarded projects</div>
                </div>
                <ChevronRight size={16} className="ad-action-arrow" />
              </Link>
              <Link to="/admin/suppliers" className="ad-next-action">
                <div>
                  <div className="ad-bold">Review Suppliers</div>
                  <div className="ad-muted ad-small">Check supplier profiles and approvals</div>
                </div>
                <ChevronRight size={16} className="ad-action-arrow" />
              </Link>
              <Link to="/admin/bids" className="ad-next-action">
                <div>
                  <div className="ad-bold">Evaluate Bids</div>
                  <div className="ad-muted ad-small">Open bid evaluation for submitted projects</div>
                </div>
                <ChevronRight size={16} className="ad-action-arrow" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Projects Page ─────────────────────────────────────────────────────────────

function ProjectsPage({ projects, onAdd }) {
  const [filterTab, setFilterTab] = useState('All')
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', budget: '', deadline: '', type: 'ICT Services', description: '' })
  const FILTER_TABS = ['All', 'Draft', 'Active', 'Closed', 'Awarded']
  const TYPES = ['ICT Services', 'IT Equipment', 'Infrastructure', 'Medical', 'Education', 'Other']

  const handleSubmit = (e) => {
    e.preventDefault()
    onAdd(form)
    setForm({ name: '', budget: '', deadline: '', type: 'ICT Services', description: '' })
    setShowForm(false)
  }

  const filtered = projects.filter(p => {
    const q = search.toLowerCase()
    const matchSearch = !q || p.name.toLowerCase().includes(q)
    const matchTab =
      filterTab === 'All'     ? true :
      filterTab === 'Awarded' ? p.status === 'awarded' :
      filterTab === 'Active'  ? (p.status === 'published' || p.status === 'active') :
      filterTab === 'Draft'   ? p.status === 'draft' :
      filterTab === 'Closed'  ? p.status === 'closed' : true
    return matchSearch && matchTab
  })

  return (
    <div className="ad-content">
      <div className="ad-card">
        <div className="ad-card-header">
          <div className="ad-filter-pills">
            {FILTER_TABS.map(t => (
              <button key={t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
            ))}
          </div>
          <div className="ad-toolbar">
            <div className="ad-search-inline">
              <Search size={14} />
              <input placeholder="Search projects" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <button className="ad-btn-primary" onClick={() => setShowForm(v => !v)}>
              <Plus size={14} /> {showForm ? 'Cancel' : 'Create Project'}
            </button>
          </div>
        </div>

        {showForm && (
          <div className="ad-form-wrap">
            <div className="ad-form-title">Create New Project</div>
            <form onSubmit={handleSubmit} className="ad-form-grid">
              <div className="ad-form-group">
                <label>Project Title</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="ad-form-group">
                <label>Budget</label>
                <input value={form.budget} onChange={e => setForm({ ...form, budget: e.target.value })} placeholder="e.g. ₱50,000" required />
              </div>
              <div className="ad-form-group">
                <label>Deadline</label>
                <input type="date" value={form.deadline} onChange={e => setForm({ ...form, deadline: e.target.value })} required />
              </div>
              <div className="ad-form-group">
                <label>Type</label>
                <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                  {TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div className="ad-form-group ad-form-full">
                <label>Description</label>
                <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={3} required />
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
              <th>TITLE</th><th>BUDGET</th><th>DEADLINE</th><th>TYPE</th>
              <th>ELIGIBLE TYPES</th><th>STATUS</th><th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0
              ? <tr><td colSpan={7} className="ad-empty-row">No projects found.</td></tr>
              : filtered.map(p => (
                <tr key={p.id}>
                  <td className="ad-bold">{p.name}</td>
                  <td>{p.budget}</td>
                  <td className="ad-muted">{p.deadline}</td>
                  <td>{p.type}</td>
                  <td><span className="badge badge-gray">{p.eligibleTypes}</span></td>
                  <td>
                    <span className={`badge ${STATUS_CLS[p.status] || 'badge-gray'}`}>
                      • {STATUS_LABEL[p.status] || p.status}
                    </span>
                  </td>
                  <td>
                    <div className="ad-actions">
                      <button className="ad-btn-view-sm"><Eye size={12} /> View Bids</button>
                      <button className="ad-btn-archive">Archive</button>
                    </div>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Planning Page ─────────────────────────────────────────────────────────────

function PlanningPage({ projects }) {
  const [search, setSearch] = useState('')
  const filtered = projects.filter(p => {
    const q = search.toLowerCase()
    return !q || p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q)
  })

  return (
    <div className="ad-content">
      <div className="ad-card">
        <div className="ad-card-header">
          <div className="ad-search-inline">
            <Search size={14} />
            <input placeholder="Search by title or type" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button className="ad-btn-primary"><Plus size={14} /> New Request</button>
        </div>
        <table className="ad-table">
          <thead>
            <tr>
              <th>PROJECT TITLE</th><th>BUDGET</th><th>TYPE</th>
              <th>DEADLINE</th><th>STATUS</th><th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0
              ? <tr><td colSpan={6} className="ad-empty-row">No planning requests found.</td></tr>
              : filtered.map(p => (
                <tr key={p.id}>
                  <td className="ad-bold">{p.name}</td>
                  <td>{p.budget}</td>
                  <td>{p.type}</td>
                  <td className="ad-muted">{p.deadline}</td>
                  <td><span className="badge badge-green">• Approved</span></td>
                  <td>
                    <div className="ad-actions">
                      <button className="ad-btn-view-sm"><Eye size={12} /> View Details</button>
                      <button className="ad-btn-publish">Published</button>
                    </div>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Suppliers Page ────────────────────────────────────────────────────────────

function SuppliersPage() {
  const [suppliers] = useState(INITIAL_SUPPLIERS)
  const [filterTab, setFilterTab] = useState('All')
  const [search, setSearch] = useState('')
  const TABS = ['All', 'Pending', 'Approved', 'Rejected']

  const QUAL_CLS = {
    verified: 'badge-green',
    waiting_admin_approval: 'badge-yellow',
    rejected: 'badge-red',
  }
  const SUP_STATUS_CLS = {
    draft: 'badge-gray', approved: 'badge-green',
    rejected: 'badge-red', pending: 'badge-yellow',
  }

  const filtered = suppliers.filter(s => {
    const q = search.toLowerCase()
    const matchSearch = !q || s.company.toLowerCase().includes(q) || s.contact.toLowerCase().includes(q)
    const matchTab =
      filterTab === 'All'      ? true :
      filterTab === 'Pending'  ? (s.status === 'draft' || s.status === 'pending') :
      filterTab === 'Approved' ? s.status === 'approved' :
      filterTab === 'Rejected' ? s.status === 'rejected' : true
    return matchSearch && matchTab
  })

  return (
    <div className="ad-content">
      <div className="ad-card">
        <div className="ad-card-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <div className="ad-filter-pills">
            {TABS.map(t => (
              <button key={t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
            ))}
          </div>
          <div className="ad-search-inline">
            <Search size={14} />
            <input placeholder="Search by company or name" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <table className="ad-table">
          <thead>
            <tr>
              <th>COMPANY</th><th>CONTACT</th><th>BUSINESS TYPE</th><th>STATUS</th>
              <th>QUALIFICATION STATUS</th><th>EMAIL VERIFIED</th><th>REGISTERED</th><th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0
              ? <tr><td colSpan={8} className="ad-empty-row">No suppliers found.</td></tr>
              : filtered.map(s => (
                <tr key={s.id}>
                  <td className="ad-bold">{s.company}</td>
                  <td>{s.contact}</td>
                  <td className="ad-muted" style={{ maxWidth: 200, wordBreak: 'break-all', fontSize: 12 }}>{s.businessType}</td>
                  <td>
                    <span className={`badge ${SUP_STATUS_CLS[s.status] || 'badge-gray'}`}>
                      • {s.status.toUpperCase()}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${QUAL_CLS[s.qualificationStatus] || 'badge-gray'}`}>
                      {s.qualificationStatus.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td><span className="badge badge-green">{s.emailVerified}</span></td>
                  <td className="ad-muted">{s.registered}</td>
                  <td><button className="ad-btn-view-sm">View</button></td>
                </tr>
              ))
            }
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Bids Page ─────────────────────────────────────────────────────────────────

function BidsPage({ projects }) {
  const [filterTab, setFilterTab] = useState('All')
  const TABS = ['All', 'Goods', 'Services', 'Infrastructure', 'More']

  const filtered = projects.filter(p => {
    if (filterTab === 'All')            return true
    if (filterTab === 'Services')       return p.type.includes('Services')
    if (filterTab === 'Goods')          return p.type.includes('Equipment') || p.type.includes('Goods')
    if (filterTab === 'Infrastructure') return p.type.includes('Infrastructure')
    return true
  })

  return (
    <div className="ad-content">
      <div>
        <h2 className="ad-bids-title">Select a Project to Evaluate</h2>
        <p className="ad-bids-sub">Click a project below to review and evaluate submitted bids.</p>
      </div>
      <div className="ad-filter-pills">
        {TABS.map(t => (
          <button key={t} className={`ad-pill${filterTab === t ? ' ad-pill-active' : ''}`} onClick={() => setFilterTab(t)}>{t}</button>
        ))}
      </div>
      <div className="ad-bid-cards">
        {filtered.length === 0
          ? <div className="ad-empty-msg">No projects found.</div>
          : filtered.map(p => (
            <div className="ad-bid-card" key={p.id}>
              <div className="ad-bid-card-top">
                <div className="ad-bid-card-icon"><FolderOpen size={18} /></div>
                <ChevronRight size={16} className="ad-bid-card-arrow" />
              </div>
              <div className="ad-bid-card-name">{p.name}</div>
              <div className="ad-bid-card-budget">{p.budget} budget</div>
              <span className="badge badge-blue ad-bid-card-type">{p.type}</span>
              <div className="ad-muted ad-small ad-bid-card-desc">
                Click to open the project, review submitted bids, and mark the winning supplier.
              </div>
              <div className="ad-bid-card-footer">
                <span className="ad-bid-card-count">{p.bids} bid{p.bids !== 1 ? 's' : ''}</span>
                <span className={`badge ${STATUS_CLS[p.status] || 'badge-gray'}`}>
                  • {STATUS_LABEL[p.status] || p.status}
                </span>
              </div>
            </div>
          ))
        }
      </div>
    </div>
  )
}

// ── Awards Page ───────────────────────────────────────────────────────────────

function AwardsPage({ awards }) {
  const [search, setSearch] = useState('')
  const filtered = awards.filter(a => {
    const q = search.toLowerCase()
    return !q || a.supplier.toLowerCase().includes(q) || a.project.toLowerCase().includes(q)
  })

  const totalAmount = awards.reduce((sum, a) => {
    return sum + (parseInt(a.amount.replace(/[^0-9]/g, ''), 10) || 0)
  }, 0)

  return (
    <div className="ad-content">
      <div className="ad-stats">
        <div className="ad-stat-card">
          <div className="ad-stat-label">TOTAL AWARDS</div>
          <div className="ad-stat-value ad-val-green">{awards.length}</div>
        </div>
        <div className="ad-stat-card">
          <div className="ad-stat-label">TOTAL AWARDED AMOUNT</div>
          <div className="ad-stat-value ad-val-blue">₱{totalAmount.toLocaleString()}</div>
        </div>
        <div className="ad-stat-card">
          <div className="ad-stat-label">DOCUMENTS AVAILABLE</div>
          <div className="ad-stat-value ad-val-purple">{awards.length * 3}</div>
        </div>
        <div className="ad-stat-card">
          <div className="ad-stat-label">LATEST AWARD DATE</div>
          <div className="ad-stat-value ad-val-yellow" style={{ fontSize: 18 }}>{awards[0]?.date || '—'}</div>
        </div>
      </div>

      <div className="ad-card">
        <div className="ad-card-header">
          <div className="ad-search-inline">
            <Search size={14} />
            <input
              placeholder="Search by supplier or project"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
        <table className="ad-table">
          <thead>
            <tr>
              <th>SUPPLIER</th><th>PROJECT</th><th>AWARD AMOUNT</th>
              <th>AWARD DATE</th><th>STATUS</th><th>DOCUMENTS</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a, i) => (
              <tr key={i}>
                <td className="ad-bold">{a.supplier}</td>
                <td>{a.project}</td>
                <td className="ad-bold">{a.amount}</td>
                <td className="ad-muted">{a.date}</td>
                <td><span className="badge badge-green">• WON</span></td>
                <td>
                  <div className="ad-doc-btns">
                    <button className="ad-doc-btn"><FileText size={12} /> NOA</button>
                    <button className="ad-doc-btn"><FileText size={12} /> NTP</button>
                    <button className="ad-doc-btn"><FileText size={12} /> Resolution</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ad-award-info">
        <Info size={18} className="ad-award-info-icon" />
        <div>
          <div className="ad-bold" style={{ marginBottom: 6 }}>About Award Documents</div>
          <p className="ad-muted ad-small" style={{ marginBottom: 8 }}>Once a winning bid is selected, three official documents are available:</p>
          <ul className="ad-award-info-list">
            <li><strong>NOA:</strong> Official notification to the winning supplier</li>
            <li><strong>NTP:</strong> Authorization for the supplier to begin work</li>
            <li><strong>Resolution:</strong> Official resolution documenting the award decision</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

// ── Reports Page ──────────────────────────────────────────────────────────────

function ReportsPage({ projects, awards }) {
  const [reportTab, setReportTab] = useState('procurement')

  const totalProjects  = projects.length
  const activePrj      = projects.filter(p => p.status === 'published' || p.status === 'active').length
  const awardedPrj     = projects.filter(p => p.status === 'awarded').length
  const totalBids      = projects.reduce((s, p) => s + p.bids, 0)
  const awardedAmount  = awards.reduce((sum, a) => sum + (parseInt(a.amount.replace(/[^0-9]/g, ''), 10) || 0), 0)

  const typeCount = projects.reduce((acc, p) => {
    acc[p.type] = (acc[p.type] || 0) + 1
    return acc
  }, {})

  return (
    <div className="ad-content">
      <div className="ad-report-bar">
        <div className="ad-report-tabs">
          <button
            className={`ad-report-tab${reportTab === 'procurement' ? ' active' : ''}`}
            onClick={() => setReportTab('procurement')}
          >Procurement Report</button>
          <button
            className={`ad-report-tab${reportTab === 'supplier' ? ' active' : ''}`}
            onClick={() => setReportTab('supplier')}
          >Supplier Report</button>
        </div>
        <div className="ad-export-btns">
          <button className="ad-btn-export-csv">Export CSV</button>
          <button className="ad-btn-primary">Export PDF</button>
        </div>
      </div>

      {reportTab === 'procurement' && (
        <>
          <div className="ad-report-stats">
            {[
              { label: 'TOTAL PROJECTS', value: totalProjects, cls: ''              },
              { label: 'ACTIVE',          value: activePrj,    cls: 'ad-val-blue'   },
              { label: 'AWARDED',         value: awardedPrj,   cls: 'ad-val-purple' },
              { label: 'TOTAL BIDS',      value: totalBids,    cls: 'ad-val-yellow' },
              { label: 'AWARDED AMOUNT',  value: `₱${awardedAmount.toLocaleString()}`, cls: 'ad-val-green' },
            ].map(({ label, value, cls }) => (
              <div className="ad-stat-card" key={label}>
                <div className="ad-stat-label">{label}</div>
                <div className={`ad-stat-value ${cls}`} style={{ fontSize: 22 }}>{value}</div>
              </div>
            ))}
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>By Procurement Type</h2></div>
            <table className="ad-table">
              <thead><tr><th>TYPE</th><th>COUNT</th></tr></thead>
              <tbody>
                {Object.entries(typeCount).map(([type, count]) => (
                  <tr key={type}><td>{type}</td><td>{count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>Recent Awards</h2></div>
            <table className="ad-table">
              <thead><tr><th>PROJECT</th><th>WINNER</th><th>AMOUNT</th><th>DATE</th></tr></thead>
              <tbody>
                {awards.map((a, i) => (
                  <tr key={i}>
                    <td>{a.project}</td>
                    <td>PA co.</td>
                    <td className="ad-bold">{a.amount}</td>
                    <td className="ad-muted">{a.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {reportTab === 'supplier' && (
        <div className="ad-card">
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--text-gray)', fontSize: 14 }}>
            Supplier report coming soon.
          </div>
        </div>
      )}
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const loc = useLocation()
  const idRef = useRef(3)
  const [projects, setProjects] = useState(INITIAL_PROJECTS)
  const [awards] = useState(INITIAL_AWARDS)

  const addProject = (form) => {
    setProjects(prev => [{
      id: `P-2026-00${idRef.current++}`,
      name: form.name, budget: form.budget, deadline: form.deadline,
      type: form.type, eligibleTypes: 'Open to All',
      bids: 0, status: 'draft', description: form.description,
    }, ...prev])
  }

  const PAGE_TITLES = {
    '/admin':           'Admin Dashboard',
    '/admin/projects':  'Project Management',
    '/admin/planning':  'Procurement Planning',
    '/admin/suppliers': 'Supplier Management',
    '/admin/bids':      'Bid Evaluation',
    '/admin/awards':    'Awarding',
    '/admin/reports':   'Reports & Analytics',
  }
  const title = PAGE_TITLES[loc.pathname] || 'Admin Dashboard'

  return (
    <div className="ad-layout">
      <Sidebar active={loc.pathname} />
      <div className="ad-main">
        <Header title={title} />
        <div className="ad-body">
          <Routes>
            <Route index element={<DashboardHome projects={projects} awards={awards} />} />
            <Route path="projects"  element={<ProjectsPage projects={projects} onAdd={addProject} />} />
            <Route path="planning"  element={<PlanningPage projects={projects} />} />
            <Route path="suppliers" element={<SuppliersPage />} />
            <Route path="bids"      element={<BidsPage projects={projects} />} />
            <Route path="awards"    element={<AwardsPage awards={awards} />} />
            <Route path="reports"   element={<ReportsPage projects={projects} awards={awards} />} />
            <Route path="*"         element={<DashboardHome projects={projects} awards={awards} />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
