import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Shield, ArrowLeft, Eye, Gavel, Trophy, Calendar, MapPin,
  Tag, Users, Inbox, AlertCircle,
} from 'lucide-react'
import { apiPublicProcurement } from '../api'
import '../style/PublicResultsPage.css'

const peso = (v) => '₱' + Number(v || 0).toLocaleString('en-PH')
const fmtDate = (v) =>
  v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

export default function PublicResultsPage() {
  const navigate = useNavigate()
  const [data, setData] = useState({ biddings: [], winners: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    apiPublicProcurement()
      .then((d) => { if (alive) setData({ biddings: d.biddings || [], winners: d.winners || [] }) })
      .catch((e) => { if (alive) setError(e.message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  // Bidding requires a verified supplier account — send guests to the login,
  // which links onward to registration if they don't have one yet.
  const goBid = () => navigate('/login')

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
          <Link to="/login" className="btn-primary pub-login-btn">Login</Link>
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
              <Inbox size={28} />
              <p>No procurements are open for bidding right now. Check back soon.</p>
            </div>
          ) : (
            <div className="pub-cards">
              {biddings.map((b) => (
                <article className="pub-card" key={b.code}>
                  <div className="pub-card-top">
                    <span className="pub-card-code">{b.code}</span>
                    <span className="badge badge-green">Open</span>
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
                  <button className="pub-bid-btn" onClick={goBid}>
                    <Gavel size={15} /> Join to Bid
                  </button>
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
              <Trophy size={28} />
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

        {/* CTA */}
        <section className="pub-cta">
          <h2>Ready to compete for these contracts?</h2>
          <p>Register as a supplier to submit bids, or log in if you already have an account.</p>
          <div className="pub-cta-btns">
            <Link to="/register" className="btn-primary">Register as Supplier</Link>
            <Link to="/login" className="btn-outline">Login</Link>
          </div>
        </section>
      </main>
    </div>
  )
}
