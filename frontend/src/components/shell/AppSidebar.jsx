import { useEffect } from 'react'
import { Link } from 'react-router-dom'

// Shared dark sidebar for the Admin, Head and Supplier workspaces.
// `sections` = [{ label, items: [{ icon, label, to, badge? }] }]
// `isActive(to)` decides which item is highlighted (each role keeps its own rule).
// Desktop: full width. 769–1024px: icon rail (labels move to tooltips).
// ≤768px: off-canvas drawer controlled by `open` / `onClose`.
export default function AppSidebar({ workspace, logoIcon: LogoIcon, sections, isActive, open, onClose }) {
  // Esc closes the mobile drawer.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <aside className={`app-sidebar${open ? ' open' : ''}`} aria-label={`${workspace} navigation`}>
      <div className="app-sidebar-brand">
        <span className="app-sidebar-logo" aria-hidden="true"><LogoIcon size={17} /></span>
        <div className="app-sidebar-brand-text">
          <div className="app-sidebar-name">E-Procurement</div>
          <div className="app-sidebar-role">{workspace}</div>
        </div>
      </div>

      <nav className="app-sidebar-nav">
        {sections.map((section) => (
          <div className="app-nav-section" key={section.label}>
            <div className="app-nav-label">{section.label}</div>
            {section.items.map(({ icon: Icon, label, to, badge }) => {
              const active = isActive(to)
              return (
                <Link
                  key={to}
                  to={to}
                  className={`app-nav-item${active ? ' active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={onClose}
                  title={label}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span className="app-nav-text">{label}</span>
                  {badge > 0 && <span className="app-nav-badge" aria-label={`${badge} pending`}>{badge > 99 ? '99+' : badge}</span>}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="app-sidebar-foot">
        <span className="app-sidebar-chain" aria-hidden="true" />
        <span className="app-nav-text">Blockchain audit trail · Sepolia</span>
      </div>
    </aside>
  )
}
