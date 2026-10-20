import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, Menu } from 'lucide-react'
import NotificationBell from '../NotificationBell'
import { initialOf } from '../../utils/format'

// The signed-in user saved at login (see saveSession in api.js). Read-only —
// used for display when a role has no profile endpoint of its own.
export function storedUser() {
  try { return JSON.parse(localStorage.getItem('user') || 'null') || {} } catch { return {} }
}

// User avatar + name + role, with a keyboard-usable dropdown.
// `menu` = [{ icon, label, onClick, danger? , divider? }]
function UserMenu({ user, menu }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const btnRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus() }
    }
    const onClick = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    // Move focus into the menu so it can be used from the keyboard.
    wrapRef.current?.querySelector('[role="menuitem"]')?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [open])

  const onMenuKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...wrapRef.current.querySelectorAll('[role="menuitem"]')]
    const i = items.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div className="app-user" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="app-user-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="app-avatar" aria-hidden="true">{initialOf(user.name)}</span>
        <span className="app-user-text">
          <span className="app-user-name">{user.name}</span>
          <span className="app-user-role">{user.role}</span>
        </span>
        <ChevronDown size={14} className="app-user-caret" aria-hidden="true" />
      </button>

      {open && (
        <div className="app-menu" role="menu" aria-label="Account" onKeyDown={onMenuKey}>
          <div className="app-menu-head">
            <span className="app-avatar app-avatar-lg" aria-hidden="true">{initialOf(user.name)}</span>
            <div className="app-menu-id">
              <div className="app-menu-name">{user.name}</div>
              {user.email && <div className="app-menu-email">{user.email}</div>}
              <div className="app-menu-rolechip">{user.role}</div>
            </div>
          </div>
          {menu.map((item, i) =>
            item.divider ? (
              <div className="app-menu-divider" key={`d${i}`} role="separator" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`app-menu-item${item.danger ? ' is-danger' : ''}`}
                onClick={() => { setOpen(false); item.onClick() }}
              >
                {item.icon && <item.icon size={15} aria-hidden="true" />} {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}

// Shared top bar: breadcrumbs + page title on the left; notifications and the
// single user menu on the right. Identical for every role.
export default function AppHeader({ title, breadcrumbs = [], onMenu, user, menu }) {
  return (
    <header className="app-header">
      <div className="app-header-left">
        <button type="button" className="app-menu-toggle" onClick={onMenu} aria-label="Open navigation menu">
          <Menu size={20} />
        </button>
        <div className="app-header-titles">
          {breadcrumbs.length > 0 && (
            <nav className="app-crumbs" aria-label="Breadcrumb">
              <ol>
                {breadcrumbs.map((c, i) => {
                  const last = i === breadcrumbs.length - 1
                  return (
                    <li key={`${c.label}-${i}`}>
                      {c.to && !last ? <Link to={c.to}>{c.label}</Link> : <span aria-current={last ? 'page' : undefined}>{c.label}</span>}
                      {!last && <ChevronRight size={11} aria-hidden="true" />}
                    </li>
                  )
                })}
              </ol>
            </nav>
          )}
          <h1 className="app-page-title">{title}</h1>
        </div>
      </div>
      <div className="app-header-right">
        <NotificationBell />
        <span className="app-header-sep" aria-hidden="true" />
        <UserMenu user={user} menu={menu} />
      </div>
    </header>
  )
}
