import { Link } from 'react-router-dom'
import { Shield, ArrowLeft } from 'lucide-react'
import '../style/PublicResultsPage.css'
import '../style/LegalPage.css'

// Shared chrome for the static legal pages (Terms of Service, Privacy Policy).
// Reuses the public-page nav/header styling so it matches the rest of the
// unauthenticated site instead of introducing a third visual language.
export default function LegalPageLayout({ title, updated, children }) {
  return (
    <div className="pub">
      <nav className="pub-nav">
        <Link to="/" className="lp-logo">
          <span className="lp-logo-icon"><Shield size={18} /></span>
          <div>
            <div className="lp-logo-name">E-Procurement</div>
            <div className="lp-logo-sub">Blockchain System</div>
          </div>
        </Link>
        <div className="pub-nav-right">
          <Link to="/" className="pub-back"><ArrowLeft size={15} /> Back to Home</Link>
        </div>
      </nav>

      <header className="pub-header" style={{ textAlign: 'left', maxWidth: 820 }}>
        <h1>{title}</h1>
      </header>

      <main className="pub-main legal-main">
        <p className="legal-updated">Last updated: {updated}</p>
        {children}
      </main>
    </div>
  )
}
