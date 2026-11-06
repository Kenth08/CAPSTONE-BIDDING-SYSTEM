// The top of every public results page: one nav, plus a back bar on the pages
// below the listing. The bar stays in view while a long verification trail
// scrolls, so the way back to the listing is never out of reach.
import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ArrowLeft, LayoutDashboard, Shield } from 'lucide-react'

import { getRole, getToken } from '../api'

export function PublicNav({ children }) {
  const { pathname, search, hash } = useLocation()
  const role = getToken() ? getRole() : null

  // The router keeps the window's scroll position between pages. A #hash means
  // the page scrolls itself to that section.
  useEffect(() => {
    if (!hash) window.scrollTo(0, 0)
  }, [pathname, search, hash])

  return (
    <nav className="pub-nav" aria-label="Public pages">
      <Link to="/" className="lp-logo">
        <span className="lp-logo-icon"><Shield size={18} /></span>
        <div>
          <div className="lp-logo-name">E-Procurement</div>
          <div className="lp-logo-sub">Blockchain System</div>
        </div>
      </Link>
      <div className="pub-nav-right">
        {children}
        {role
          ? <Link to={`/${role}`} className="btn-primary pub-login-btn"><LayoutDashboard size={15} /> My Dashboard</Link>
          : <Link to="/login" className="btn-primary pub-login-btn">Login</Link>}
      </div>
    </nav>
  )
}

/** `parent` adds a second step back, e.g. to the procurement a record belongs to. */
export function PublicBackBar({ parent }) {
  return (
    <div className="pub-backbar">
      <div className="pub-backbar-inner">
        <Link to="/public" className="pub-back-btn"><ArrowLeft size={16} aria-hidden="true" /> Back to Public Results</Link>
        {parent && <Link to={parent.to} className="pub-back-parent">{parent.label}</Link>}
      </div>
    </div>
  )
}
