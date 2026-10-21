import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Shield, ArrowLeft, Eye, Gavel, Trophy, Calendar, MapPin,
  Tag, Users, Inbox, AlertCircle, Lock, LayoutDashboard,
} from 'lucide-react'
import { apiPublicProcurement, apiGetMySupplier, getToken, getRole } from '../api'
import PublicVerifier from '../components/PublicVerifier'
import '../style/PublicResultsPage.css'

const peso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH')
const fmtDate = (v) =>
  v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

const PENDING_MSG =
  'Your supplier account is pending admin approval. You can view this procurement, ' +
  'but you cannot submit a bid until your account is approved.'

export default function PublicResultsPage() {
  const navigate = useNavigate()
  const [data, setData] = useState({ biddings: [], winners: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // This page is public, but a signed-in user can open it too (e.g. a supplier
  // from their dashboard). Read the session so the page doesn't look as if they
  // were logged out, and so "Join to Bid" respects their approval status.
  const role = getToken() ? getRole() : null
  const [qualStatus, setQualStatus] = useState(null)
  const [bidNotice, setBidNotice] = useState('')

  useEffect(() => {
    let alive = true
    apiPublicProcurement()
      .then((d) => { if (alive) setData({ biddings: d.biddings || [], winners: d.winners || [] }) })
      .catch((e) => { if (alive) setError(e.message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (role !== 'supplier') return
    let alive = true
    apiGetMySupplier()
      .then((p) => { if (alive) setQualStatus(p?.qualification_status || null) })
      .catch(() => {})
    return () => { alive = false }
  }, [role])

  const supplierApproved = qualStatus === 'verified'
  // Still loading or not approved — either way bidding stays locked for now.
  const supplierLocked = role === 'supplier' && !supplierApproved

  // Guests go to the login (which links onward to registration). An approved
  // supplier goes to their dashboard's bid list. A pending supplier stays here,
  // still signed in, and sees why they can't bid yet.
  const goBid = () => {
    if (!role) return navigate('/login')
    if (role !== 'supplier') return
    if (supplierApproved) return navigate('/supplier/projects')
    setBidNotice(PENDING_MSG)
  }

  const { biddings, winners } = data

  return (
    <div className="pub">
      {/* Nav */}
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
          {role
            ? <Link to={`/${role}`} className="btn-primary pub-login-btn"><LayoutDashboard size={15} /> My Dashboard</Link>
            : <Link to="/login" className="btn-primary pub-login-btn">Login</Link>}
        </div>
      </nav>

      {/* Header */}
      <header className="pub-header">
        <div className="pub-badge"><Eye size={14} /> Public View</div>
        <h1>Public Procurement Results</h1>
        <p>
          Browse every procurement open for bidding and every awarded contract — fully
          transparent, no account required. Want to compete? Log in or register as a supplier to place a bid.
        </p>
      </header>

      <main className="pub-main">
        {error && (
          <div className="pub-error"><AlertCircle size={18} /> {error}</div>
        )}
        {supplierLocked && qualStatus && (bidNotice || biddings.length > 0) && (
          <div className="pub-notice" role="status"><Lock size={18} /> {bidNotice || PENDING_MSG}</div>
        )}

        {/* Available biddings */}
        <section className="pub-section">
          <div className="pub-section-head">
            <div className="pub-section-title">
              <Gavel size={20} className="pub-ico-green" />
              <h2>Available Biddings</h2>
            </div>
            {!loading && <span className="pub-count">{biddings.length} open</span>}
          </div>

          {loading ? (
            <div className="pub-cards">
              {[0, 1, 2].map((i) => (
                <div className="pub-card pub-card-skel" key={i}>
                  <span className="skel" style={{ width: '40%' }} />
                  <span className="skel" style={{ width: '80%', height: 18 }} />
                  <span className="skel" style={{ width: '60%' }} />
                  <span className="skel" style={{ width: '100%', height: 38 }} />
                </div>
              ))}
            </div>
          ) : biddings.length === 0 ? (
            <div className="pub-empty">
              <span className="pub-empty-icon" aria-hidden="true"><Inbox size={22} /></span>
              <strong className="pub-empty-title">No open biddings right now</strong>
              <p>No procurements are open for bidding right now. Check back soon.</p>
              <Link to="/register" className="pub-empty-link">Register as a supplier</Link>
            </div>
          ) : (
            <div className="pub-cards">
              {biddings.map((b) => (
                <article className="pub-card" key={b.code}>
                  <div className="pub-card-top">
                    <span className="pub-card-code">{b.code}</span>
                    <span className="pub-open-chip"><span className="ui-badge-dot" aria-hidden="true" /> Open for Bidding</span>
                  </div>
                  <h3 className="pub-card-name">{b.name}</h3>
                  <div className="pub-card-meta">
                    {b.category && <span><Tag size={13} /> {b.category}</span>}
                    {b.type && <span className="pub-card-type">{b.type}</span>}
                  </div>
                  <div className="pub-card-budget">
                    <span className="pub-card-budget-label">Approved Budget</span>
                    <span className="pub-card-budget-val">{peso(b.budget)}</span>
                  </div>
                  <ul className="pub-card-details">
                    <li><Calendar size={14} /> Deadline: <strong>{fmtDate(b.deadline)}</strong></li>
                    {b.delivery_location && <li><MapPin size={14} /> {b.delivery_location}</li>}
                    <li><Users size={14} /> {b.bids} bid{b.bids === 1 ? '' : 's'} submitted</li>
                  </ul>
                  {role === 'supplier' && supplierLocked ? (
                    <button className="pub-bid-btn is-locked" onClick={goBid} aria-disabled="true"
                      title="Bidding unlocks once the admin approves your account">
                      <Lock size={15} /> Pending Approval
                    </button>
                  ) : (!role || role === 'supplier') && (
                    <button className="pub-bid-btn" onClick={goBid}>
                      <Gavel size={15} /> {role ? 'Bid on this Project' : 'Join to Bid'}
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Winners */}
        <section className="pub-section">
          <div className="pub-section-head">
            <div className="pub-section-title">
              <Trophy size={20} className="pub-ico-gold" />
              <h2>Awarded Contracts</h2>
            </div>
            {!loading && <span className="pub-count">{winners.length} awarded</span>}
          </div>

          {loading ? (
            <div className="pub-table-wrap">
              <div className="pub-card-skel" style={{ padding: 20 }}>
                {[0, 1, 2].map((i) => <span className="skel" style={{ width: '100%', marginBottom: 12 }} key={i} />)}
              </div>
            </div>
          ) : winners.length === 0 ? (
            <div className="pub-empty">
              <span className="pub-empty-icon" aria-hidden="true"><Trophy size={22} /></span>
              <strong className="pub-empty-title">No awarded contracts yet</strong>
              <p>No contracts have been awarded yet.</p>
            </div>
          ) : (
            <div className="pub-table-wrap">
              <table className="pub-table">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Project</th>
                    <th>Category</th>
                    <th>Winning Supplier</th>
                    <th>Date Awarded</th>
                  </tr>
                </thead>
                <tbody>
                  {winners.map((w) => (
                    <tr key={w.code}>
                      <td className="pub-mono">{w.code}</td>
                      <td className="pub-strong">{w.name}</td>
                      <td>{w.category || '—'}</td>
                      <td>
                        <span className="pub-winner"><Trophy size={13} /> {w.winner}</span>
                      </td>
                      <td>{fmtDate(w.awarded_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Independent verification: replay any procurement's history straight
            from the Sepolia ledger, and check a document against its anchored
            hash. Read-only — no account, no wallet, no gas. */}
        <PublicVerifier />

        {/* CTA — only for visitors who aren't signed in */}
        {!role && <section className="pub-cta">
          <h2>Ready to compete for these contracts?</h2>
          <p>Register as a supplier to submit bids, or log in if you already have an account.</p>
          <div className="pub-cta-btns">
            <Link to="/register" className="btn-primary">Register as Supplier</Link>
            <Link to="/login" className="btn-outline">Login</Link>
          </div>
        </section>}
      </main>
    </div>
  )
}
