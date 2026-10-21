import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  AlertCircle, ArrowLeft, Eye, Gavel, LayoutDashboard, Lock, MapPin, Search, Shield, ShieldCheck, Trophy,
} from 'lucide-react'
import { apiPublicProcurement, apiGetMySupplier, getToken, getRole } from '../api'
import PublicVerifier from '../components/PublicVerifier'
import { readLedgerTotal } from '../blockchain/anchor'
import Countdown from '../components/ui/Countdown'
import DataTable from '../components/ui/DataTable'
import KpiCard, { KpiRow } from '../components/ui/KpiCard'
import StatusBadge from '../components/ui/StatusBadge'
import Thumbnail from '../components/ui/Thumbnail'
import { fmtDate, peso, pesoCompact } from '../utils/format'
import '../style/PublicResultsPage.css'

const PENDING_MSG =
  'Your supplier account is pending admin approval. You can view this procurement, ' +
  'but you cannot submit a bid until your account is approved.'

export default function PublicResultsPage() {
  const navigate = useNavigate()
  const loc = useLocation()
  const [params] = useSearchParams()
  const verifyCode = (params.get('verify') || '').trim().toUpperCase()
  const [data, setData] = useState({ biddings: [], winners: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [category, setCategory] = useState('all')
  // This page is public, but a signed-in user can open it too (e.g. a supplier
  // from their dashboard). Read the session so the page doesn't look as if they
  // were logged out, and so "Bid" respects their approval status.
  const role = getToken() ? getRole() : null
  const [qualStatus, setQualStatus] = useState(null)
  const [bidNotice, setBidNotice] = useState('')
  const [onChain, setOnChain] = useState(null)   // total anchors on the ledger; null = unreachable

  useEffect(() => {
    let alive = true
    apiPublicProcurement()
      .then((d) => { if (alive) setData({ biddings: d.biddings || [], winners: d.winners || [] }) })
      .catch((e) => { if (alive) setError(e.message) })
      .finally(() => { if (alive) setLoading(false) })
    readLedgerTotal().then((n) => { if (alive && Number.isFinite(n)) setOnChain(n) }).catch(() => {})
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

  // /public#verify (landing-page search, a row's Verify button) scrolls to the verifier.
  useEffect(() => {
    if (loc.hash === '#verify') document.getElementById('verify')?.scrollIntoView({ block: 'start' })
  }, [loc.hash, verifyCode])

  const supplierApproved = qualStatus === 'verified'
  // Still loading or not approved — either way bidding stays locked for now.
  const supplierLocked = role === 'supplier' && !supplierApproved

  // Guests go to the login (which links onward to registration). An approved
  // supplier goes to their dashboard's opportunities. A pending supplier stays
  // here, still signed in, and sees why they can't bid yet.
  const goBid = () => {
    if (!role) return navigate('/login')
    if (role !== 'supplier') return
    if (supplierApproved) return navigate('/supplier/projects')
    setBidNotice(PENDING_MSG)
  }

  const { biddings, winners } = data
  // One list for the table: open biddings and awarded contracts.
  const rows = useMemo(() => [
    ...biddings.map((b) => ({ ...b, key: `o-${b.code}`, state: 'open' })),
    ...winners.map((w) => ({ ...w, key: `a-${w.code}`, state: 'awarded' })),
  ], [biddings, winners])
  const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort()
  const visible = category === 'all' ? rows : rows.filter((r) => r.category === category)
  const openAbc = biddings.reduce((s, b) => s + Number(b.budget || 0), 0)

  const verify = (code) => navigate(`/public?verify=${encodeURIComponent(code)}#verify`)

  const columns = [
    {
      key: 'img', header: <span className="sr-only">Category</span>,
      render: (r) => <Thumbnail size={48} category={r.category} alt="" />,
    },
    {
      key: 'name', header: 'Procurement', mobileLabel: false, sortValue: (r) => r.name,
      render: (r) => (
        <div className="rf-cell-title">
          <div>
            <strong>{r.name}</strong>
            <small>
              <span className="rf-code">{r.code}</span>
              <span>{r.category || 'Uncategorised'}</span>
              {r.delivery_location && <span className="rf-hide-md"><MapPin size={11} aria-hidden="true" /> {r.delivery_location}</span>}
            </small>
          </div>
        </div>
      ),
    },
    {
      key: 'budget', header: 'ABC', align: 'right', sortValue: (r) => (r.budget ? Number(r.budget) : null),
      render: (r) => (r.budget ? <span className="rf-amount">{peso(r.budget)}</span> : <span className="rf-muted">—</span>),
    },
    {
      key: 'when', header: 'Deadline / Result', sortValue: (r) => r.deadline || r.awarded_at,
      render: (r) => (r.state === 'open'
        ? <div className="rf-stack-cell">
            <Countdown deadline={r.deadline} />
            <span className="rf-muted">{fmtDate(r.deadline)} · {r.bids} bid{r.bids === 1 ? '' : 's'}</span>
          </div>
        : <div className="rf-stack-cell">
            <span className="pub-winner"><Trophy size={13} aria-hidden="true" /> {r.winner}</span>
            <span className="rf-muted">Awarded {fmtDate(r.awarded_at)}</span>
          </div>),
    },
    {
      key: 'status', header: 'Status', sortValue: (r) => r.state,
      render: (r) => <StatusBadge domain="project" status={r.state === 'open' ? 'published' : 'awarded'} />,
    },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', className: 'rf-sticky-col',
      render: (r) => (
        <div className="rf-row-actions">
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => verify(r.code)}
            aria-label={`Verify ${r.code} on the blockchain`}>
            <ShieldCheck size={13} /> Verify
          </button>
          {r.state === 'open' && role === 'supplier' && supplierLocked ? (
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={goBid} aria-disabled="true"
              title="Bidding unlocks once the admin approves your account">
              <Lock size={13} /> Pending approval
            </button>
          ) : r.state === 'open' && (!role || role === 'supplier') && (
            <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" onClick={goBid}>
              <Gavel size={13} /> {role ? 'Bid' : 'Join to bid'}
            </button>
          )}
        </div>
      ),
    },
  ]

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
          {role
            ? <Link to={`/${role}`} className="btn-primary pub-login-btn"><LayoutDashboard size={15} /> My Dashboard</Link>
            : <Link to="/login" className="btn-primary pub-login-btn">Login</Link>}
        </div>
      </nav>

      <header className="pub-header">
        <div className="pub-badge"><Eye size={14} /> Public View</div>
        <h1>Public Procurement Results</h1>
        <p>
          Every procurement open for bidding and every awarded contract — no account required.
          Check any of them against the blockchain with the verifier below.
        </p>
      </header>

      <main className="pub-main rf-home">
        {error && <div className="pub-error" role="alert"><AlertCircle size={18} /> {error}</div>}
        {supplierLocked && qualStatus && (bidNotice || biddings.length > 0) && (
          <div className="pub-notice" role="status"><Lock size={18} /> {bidNotice || PENDING_MSG}</div>
        )}

        <KpiRow cols={onChain != null ? 4 : undefined}>
          <KpiCard label="Open for bidding" icon={Gavel} tone="info" loading={loading} value={biddings.length}
            context={biddings.length ? `${biddings.filter((b) => b.bids === 0).length} still without bids` : 'None right now'} />
          <KpiCard label="ABC open for bidding" icon={Search} loading={loading}
            value={pesoCompact(openAbc)} title={peso(openAbc)} context="Approved budgets of open biddings" />
          <KpiCard label="Contracts awarded" icon={Trophy} tone="success" loading={loading} value={winners.length}
            context={winners[0] ? `Latest ${fmtDate(winners[0].awarded_at)}` : 'None yet'} />
          {onChain != null && (
            <KpiCard label="Steps on Ethereum Sepolia" icon={ShieldCheck} to="/public#verify" value={onChain}
              context="Read live from the ledger contract" />
          )}
        </KpiRow>

        <section aria-labelledby="results-h" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 id="results-h" className="sr-only">All public procurements</h2>
          <DataTable
            caption="Public procurements"
            columns={columns}
            rows={visible}
            rowKey={(r) => r.key}
            loading={loading}
            initialSort={{ key: 'status', dir: 'desc' }}
            search={(r) => `${r.code} ${r.name} ${r.category || ''} ${r.winner || ''}`}
            searchPlaceholder="Search reference, title or winner"
            filters={[
              { key: 'all', label: 'All', test: () => true },
              { key: 'open', label: 'Open for bidding', test: (r) => r.state === 'open' },
              { key: 'awarded', label: 'Awarded', test: (r) => r.state === 'awarded' },
            ]}
            toolbar={categories.length > 0 && (
              <label className="rf-filterbar">
                <span className="sr-only">Category</span>
                <select className="rf-select" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="all">All categories</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
            empty={{
              icon: Gavel, title: error ? 'Results could not load' : 'No public procurements yet',
              description: error ? 'Please try again in a moment.' : 'Procurements appear here once they are published for bidding.',
              action: !role && <Link to="/register" className="ui-btn ui-btn--secondary ui-btn--sm">Register as a supplier</Link>,
            }}
          />
        </section>

        {/* Independent verification: replay any procurement's history straight
            from the Sepolia ledger, and check a document against its anchored
            hash. Read-only — no account, no wallet, no gas. */}
        <PublicVerifier key={verifyCode} initialCode={verifyCode} />

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
