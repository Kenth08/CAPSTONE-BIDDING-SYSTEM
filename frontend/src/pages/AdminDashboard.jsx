import { lazy, Suspense, useState, useEffect, useRef } from 'react'
import { ws, useBacStatus, canPrepare } from '../utils/workspace'
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, Calendar, Users, Pencil, Award, BarChart2, LogOut, Shield, Gavel, ScrollText, UserCog, Landmark,
} from 'lucide-react'
import { apiLogout } from '../api'
import AppSidebar from '../components/shell/AppSidebar'
import AppHeader, { storedUser } from '../components/shell/AppHeader'
import AnchorActivity from '../components/AnchorActivity'
import AdminHome from './admin/AdminHome'
import Toaster from '../components/ui/Toaster'
import { PageSkeleton } from '../components/Skeleton'
import '../style/AdminDashboard.css'

// Each section is its own download, loaded the first time it is opened.
const PlanningPage = lazy(() => import('./admin/PlanningPage'))
const ProjectsPage = lazy(() => import('./admin/ProjectsPage'))
const ProjectHistoryPage = lazy(() => import('./admin/ProjectHistoryPage'))
const SuppliersPage = lazy(() => import('./admin/SuppliersPage'))
const BidsPage = lazy(() => import('./admin/BidsPage'))
const BidEvaluationPage = lazy(() => import('./admin/BidEvaluationPage'))
const AwardsPage = lazy(() => import('./admin/AwardsPage'))
const ReportsPage = lazy(() => import('./admin/ReportsPage'))
const UsersPage = lazy(() => import('./admin/UsersPage'))
const BacCommitteePage = lazy(() => import('./admin/BacCommitteePage'))
const BacRecordsPage = lazy(() => import('./bac/BacRecordsPage'))
const BacMeetingsPage = lazy(() => import('./staff/BacMeetingsPage'))
const ProcurementRecordPage = lazy(() => import('../components/ProcurementRecord'))
const ProjectAnchorDetailPage = lazy(() =>
  import('../components/AnchorDetail').then((m) => ({ default: m.ProjectAnchorDetailPage })))

// The menu for whoever is signed in. This file serves both the Admin (/admin)
// and Procurement Staff (/staff). With separation of duties on
// (utils/workspace.useBacStatus) the Admin oversees and manages accounts and
// Staff prepare; with it off the Admin keeps every original page.
function navSections(role, workflowOn) {
  const prepare = canPrepare(role, workflowOn)
  const procurement = [
    ...(prepare ? [{ icon: Calendar, label: 'Planning', to: ws('/planning') }] : []),
    { icon: FolderOpen, label: 'Projects', to: ws('/projects') },
    { icon: Pencil,     label: 'Bids',     to: ws('/bids') },
    ...(role === 'staff' ? [{ icon: Gavel, label: 'BAC Meetings', to: ws('/bac-meetings') }] : []),
    { icon: Award,      label: 'Awards',   to: ws('/awards') },
    ...(role === 'admin' ? [{ icon: ScrollText, label: 'BAC Records', to: ws('/bac-records') }] : []),
  ]
  const management = [
    ...(role === 'admin' ? [
      { icon: UserCog,  label: 'Users',         to: ws('/users') },
      { icon: Landmark, label: 'BAC Committee', to: ws('/bac-committee') },
    ] : []),
    { icon: Users,     label: 'Suppliers', to: ws('/suppliers') },
    { icon: BarChart2, label: 'Reports',   to: ws('/reports') },
  ]
  return [
    { label: 'Overview', items: [{ icon: LayoutDashboard, label: 'Dashboard', to: ws('') }] },
    { label: role === 'admin' && workflowOn ? 'Oversight' : 'Procurement', items: procurement },
    { label: 'Management', items: management },
  ]
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function AdminDashboard({ workspace = 'admin' }) {
  const loc = useLocation()
  const navigate = useNavigate()
  const [navOpen, setNavOpen] = useState(false)
  const bacStatus = useBacStatus()
  const workflowOn = bacStatus.workflow_enabled
  const base = `/${workspace}`
  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setNavOpen(false) }, [loc.pathname])

  // The header stays put and only .ad-body scrolls, and that one element is
  // shared by every admin route — so without this, opening a project from a
  // scrolled list (or switching sections) landed part-way down the next page.
  // Keyed on the path only: query-string changes (list filters/pages) manage
  // their own scrolling.
  const bodyRef = useRef(null)
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0 }, [loc.pathname])

  const PAGE_TITLES = {
    '':           'Dashboard',
    '/projects':  'Projects',
    '/projects/history': 'Bidding History',
    '/planning':  'Planning',
    '/suppliers': 'Suppliers',
    '/bids':      'Bids',
    '/awards':    'Awards',
    '/reports':   'Reports',
    '/users':     'Users',
    '/bac-committee': 'BAC Committee',
    '/bac-records':   'BAC Records',
    '/bac-meetings':  'BAC Meetings',
  }
  const rel = loc.pathname.slice(base.length).replace(/\/$/, '')
  const title = PAGE_TITLES[rel]
    || (rel.startsWith('/bids/') ? 'Bid Evaluation'
      : rel.startsWith('/record/') ? 'Procurement Record' : 'Dashboard')

  // Breadcrumbs: Admin (or Staff) › Section › (sub-page)
  const CRUMB_SECTIONS = {
    projects: 'Projects', planning: 'Planning', suppliers: 'Suppliers',
    bids: 'Bids', awards: 'Awards', reports: 'Reports', record: 'Procurement Record',
    users: 'Users', 'bac-committee': 'BAC Committee', 'bac-records': 'BAC Records', 'bac-meetings': 'BAC Meetings',
  }
  const [, , section, sub] = loc.pathname.split('/')
  const crumbs = [{ label: workspace === 'staff' ? 'Staff' : 'Admin', to: base }]
  if (!section || !CRUMB_SECTIONS[section]) crumbs.push({ label: 'Dashboard' })
  else {
    // .../record has no index page of its own, so that crumb is plain text.
    crumbs.push({ label: CRUMB_SECTIONS[section], to: section === 'record' ? undefined : `${base}/${section}` })
    if (sub) crumbs.push({ label: section === 'bids' ? 'Evaluation' : section === 'record' ? `#${sub}` : sub === 'history' ? 'History' : sub })
  }

  // ".../projects/history" and ".../bids/:id" keep their parent highlighted.
  const isActive = (to) => to === base ? loc.pathname === base : loc.pathname === to || loc.pathname.startsWith(`${to}/`)

  const u = storedUser()
  const user = workspace === 'staff'
    ? { name: u.full_name || u.username || 'Procurement Staff', email: u.email || '', role: 'Procurement Staff' }
    : { name: u.full_name || u.username || 'System Administrator', email: u.email || '', role: 'Administrator' }

  return (
    <div className="ad-layout">
      <AppSidebar
        workspace={workspace === 'staff' ? 'Staff Workspace' : 'Admin Workspace'}
        logoIcon={Shield}
        sections={navSections(workspace, workflowOn)}
        isActive={isActive}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />
      {navOpen && <div className="ad-nav-backdrop" onClick={() => setNavOpen(false)} />}
      <div className="ad-main">
        <AppHeader
          title={title}
          breadcrumbs={crumbs}
          onMenu={() => setNavOpen(true)}
          user={user}
          menu={[{ icon: LogOut, label: 'Log out', danger: true, onClick: () => { apiLogout(); navigate('/login') } }]}
        />
        <div className="ad-body" ref={bodyRef}>
          {/* Only the page area waits for a section's code; the sidebar and
              header above stay on screen. */}
          <Suspense fallback={<PageSkeleton className="ad-content" />}>
          <Routes>
            <Route index element={<AdminHome />} />
            <Route path="projects"  element={<ProjectsPage />} />
            <Route path="projects/history" element={<ProjectHistoryPage />} />
            <Route path="planning"  element={<PlanningPage />} />
            <Route path="suppliers" element={<SuppliersPage />} />
            <Route path="bids"      element={<BidsPage />} />
            <Route path="bids/:id"  element={<BidEvaluationPage />} />
            <Route path="awards"    element={<AwardsPage />} />
            <Route path="record/:id" element={<ProcurementRecordPage className="ad-content" backTo={`${base}/awards`} backLabel="Back to awards" />} />
            <Route path="record/:id/anchor/:anchorId" element={<ProjectAnchorDetailPage className="ad-content" />} />
            <Route path="reports"   element={<ReportsPage />} />
            {workspace === 'admin' && <Route path="users" element={<UsersPage />} />}
            {workspace === 'admin' && <Route path="bac-committee" element={<BacCommitteePage />} />}
            {workspace === 'admin' && <Route path="bac-records" element={<BacRecordsPage className="ad-content" />} />}
            {workspace === 'staff' && <Route path="bac-meetings" element={<BacMeetingsPage />} />}
            <Route path="*"         element={<AdminHome />} />
          </Routes>
          </Suspense>
        </div>
      </div>
      {/* Blockchain anchoring feedback for every Admin transition (create,
          publish, qualify/disqualify, award). At the layout root so it survives
          route changes while a MetaMask prompt is open. */}
      <AnchorActivity />
      <Toaster />
    </div>
  )
}
