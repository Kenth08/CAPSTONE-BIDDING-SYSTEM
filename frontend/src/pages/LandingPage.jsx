import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowRight, Building2, CheckCircle, ClipboardCheck, Eye, FileCheck2, Gavel, Globe, Link2,
  Scale, Search, Shield, ShieldCheck, Trophy, Users,
} from 'lucide-react'
import { apiPublicSummary } from '../api'
import { readLedgerTotal } from '../blockchain/anchor'
import Countdown from '../components/ui/Countdown'
import EmptyState from '../components/ui/EmptyState'
import ProcurementStepper from '../components/ui/ProcurementStepper'
import Thumbnail from '../components/ui/Thumbnail'
import { Skeleton } from '../components/Skeleton'
import { fmtDate, peso, pesoCompact } from '../utils/format'
import '../style/LandingPage.css'

// What actually happens at each lifecycle stage in this system.
const STAGE_NOTES = [
  ['Draft', 'The BAC Secretariat files the procurement with its ABC and the five required documents.'],
  ['Head Review', 'The Approving Authority approves it, rejects it, or flags documents for revision.'],
  ['Published', 'Bidding opens to verified suppliers in the matching category; the deadline is set.'],
  ['Evaluation', 'Each bid is qualified or disqualified against the published evaluation criteria.'],
  ['Awarded', 'A qualified bid is selected and every bidder is notified.'],
  ['BAC Resolution · NOA · NTP', 'The post-award documents are issued, each with its own issue date.'],
]

const FEATURES = [
  { icon: Link2, title: 'Tamper-evident records', desc: 'Each lifecycle step is hashed and recorded on Ethereum Sepolia. Changing a record afterwards breaks its hash.' },
  { icon: ClipboardCheck, title: 'Head approval before bidding', desc: 'Nothing is published until the Approving Authority has reviewed the procurement and its documents.' },
  { icon: Users, title: 'Category-matched suppliers', desc: 'Verified suppliers only see and bid on procurements in the categories they registered for.' },
  { icon: Scale, title: 'Documented evaluation', desc: 'Bids are compared against the ABC and qualified or disqualified with every document on record.' },
  { icon: FileCheck2, title: 'Post-award documents', desc: 'BAC Resolution, Notice of Award and Notice to Proceed are issued and anchored in order.' },
  { icon: Globe, title: 'Public verification', desc: 'Anyone can replay a procurement’s trail from the blockchain and check a document’s hash — no account needed.' },
]

const ROLES = [
  {
    icon: Shield, title: 'Admin', subtitle: 'BAC Secretariat',
    perks: ['Files procurements and required documents', 'Verifies supplier registrations', 'Publishes approved procurements', 'Evaluates bids and selects the winner', 'Issues BAC Resolution, NOA and NTP'],
    cta: 'Log in', to: '/login', variant: 'dark',
  },
  {
    icon: ClipboardCheck, title: 'Head', subtitle: 'Approving Authority',
    perks: ['Reviews each procurement before it is published', 'Approves, rejects, or requests document revisions', 'Sees every decision’s on-chain record'],
    cta: 'Log in', to: '/login', variant: 'light',
  },
  {
    icon: Building2, title: 'Supplier', subtitle: 'Registered bidder',
    perks: ['Registers with compliance documents', 'Bids on procurements in its categories', 'Tracks evaluation results', 'Receives the award documents when it wins'],
    cta: 'Register', to: '/register', variant: 'light',
  },
  {
    icon: Eye, title: 'Public', subtitle: 'No account needed',
    perks: ['Browses open biddings and awarded contracts', 'Verifies any procurement against the blockchain', 'Checks a document’s hash in the browser'],
    cta: 'View public results', to: '/public', variant: 'light',
  },
]

function HeroPhoto() {
  // Optional slot: frontend/public/images/hero.webp. Until it exists (or if it
  // fails to load) nothing is rendered and the hero stays single-column.
  const [state, setState] = useState('loading')
  if (state === 'missing') return null
  return (
    <figure className={`lpx-hero-photo${state === 'ok' ? ' is-ready' : ''}`} aria-hidden={state !== 'ok'}>
      <img src="/images/hero.webp" alt="" width="560" height="420" decoding="async"
        onLoad={() => setState('ok')} onError={() => setState('missing')} />
    </figure>
  )
}

function VerifyBox() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const submit = (e) => {
    e.preventDefault()
    const ref = code.trim().toUpperCase()
    navigate(ref ? `/public?verify=${encodeURIComponent(ref)}#verify` : '/public#verify')
  }
  return (
    <form className="lpx-verify" onSubmit={submit} role="search" aria-label="Verify a procurement">
      <label htmlFor="lpx-verify-input" className="lpx-verify-label">Verify a procurement</label>
      <div className="lpx-verify-row">
        <Search size={16} aria-hidden="true" />
        <input id="lpx-verify-input" value={code} onChange={(e) => setCode(e.target.value)}
          placeholder="Reference number, e.g. P-2026-001" autoComplete="off" spellCheck="false" />
        <button type="submit" className="btn-primary">Verify <ArrowRight size={14} /></button>
      </div>
    </form>
  )
}

function LiveStats({ data, loading, error, onChain }) {
  if (error) {
    return <p className="lpx-stats-note" role="status">Live procurement numbers are unavailable right now.</p>
  }
  const stats = [
    { value: data?.open_biddings, label: 'Open biddings' },
    { value: data?.awarded_contracts, label: 'Contracts awarded' },
    { value: data ? pesoCompact(data.total_published_abc) : null, title: data ? peso(data.total_published_abc) : '', label: 'Total ABC published' },
    // Hidden when the Sepolia RPC can't be reached, instead of showing 0.
    ...(onChain != null ? [{ value: onChain, label: 'Steps recorded on Ethereum Sepolia' }] : []),
  ]
  return (
    <div className="lp-stats-inner">
      {stats.map((s) => (
        <div className="lp-stat" key={s.label}>
          <div className="lp-stat-value" title={s.title}>
            {loading ? <Skeleton width={64} height={30} style={{ margin: '0 auto', opacity: 0.3 }} /> : s.value}
          </div>
          <div className="lp-stat-label">{s.label}</div>
        </div>
      ))}
    </div>
  )
}

export default function LandingPage() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [onChain, setOnChain] = useState(null)

  useEffect(() => {
    let alive = true
    apiPublicSummary()
      .then((d) => { if (alive) setData(d) })
      .catch((e) => { if (alive) setError(e.message) })
      .finally(() => { if (alive) setLoading(false) })
    readLedgerTotal()
      .then((n) => { if (alive && Number.isFinite(n)) setOnChain(n) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  return (
    <div className="landing">
      <nav className="lp-nav">
        <Link to="/" className="lp-logo">
          <span className="lp-logo-icon"><Shield size={18} /></span>
          <div>
            <div className="lp-logo-name">E-Procurement</div>
            <div className="lp-logo-sub">Blockchain System</div>
          </div>
        </Link>
        <div className="lp-nav-links" id="nav-links">
          <a href="#open-biddings">Open Biddings</a>
          <a href="#awards">Awards</a>
          <a href="#how-it-works">How It Works</a>
          <a href="#roles">Roles</a>
        </div>
        <div className="lp-nav-right">
          <Link to="/public" className="lp-public-btn"><Eye size={14} /> Public Results</Link>
          <Link to="/login" className="btn-primary lp-login-btn">Login</Link>
        </div>
      </nav>

      <section className="lp-hero lpx-hero">
        <div className="lp-hero-grid" />
        <div className="lp-hero-glow" />
        <div className="lpx-hero-inner">
          <div className="lp-hero-content lpx-hero-content">
            <div className="lp-hero-badge">
              <span className="lp-dot" /> Aligned with RA 12009 (New Government Procurement Act)
            </div>
            <h1>
              Transparent Procurement,{' '}
              <span className="lp-accent">Secured by Blockchain</span>
            </h1>
            <p>
              Every step of a public procurement — from filing and approval to bidding, award and the
              Notice to Proceed — is recorded as a tamper-evident hash on Ethereum, so anyone can check it.
            </p>
            <div className="lp-hero-btns">
              <Link to="/login" className="btn-primary lp-hero-login"><Shield size={16} /> Login</Link>
              <Link to="/register" className="btn-outline lp-hero-register">Register as Supplier</Link>
            </div>
            <VerifyBox />
            <ul className="lp-hero-trust">
              <li><CheckCircle size={14} /> Tamper-evident records</li>
              <li><CheckCircle size={14} /> Public verification, no account</li>
              <li><CheckCircle size={14} /> Hashes only — no personal data on-chain</li>
            </ul>
          </div>
          <HeroPhoto />
        </div>
      </section>

      <section className="lp-stats" aria-label="Live procurement numbers">
        <LiveStats data={data} loading={loading} error={error} onChain={onChain} />
      </section>

      <div className="lpx-band">
      <section className="lp-section lpx-section" id="open-biddings" aria-labelledby="open-h">
        <div className="lpx-section-head">
          <div>
            <div className="lp-section-label">LIVE</div>
            <h2 className="lp-section-title" id="open-h">Open for bidding now</h2>
          </div>
          <Link to="/public" className="lpx-more">All public results <ArrowRight size={14} /></Link>
        </div>
        {loading ? (
          <div className="lpx-cards">{[0, 1, 2].map((i) => <Skeleton key={i} height={168} radius={12} />)}</div>
        ) : error || !data?.open?.length ? (
          <div className="lpx-empty">
            <EmptyState icon={Gavel} title={error ? 'Open biddings could not load' : 'No procurements are open for bidding right now'}
              description={error ? 'Please try again in a moment.' : 'New biddings appear here the moment they are published. Register now so you are ready to bid.'}
              action={<Link to="/register" className="ui-btn ui-btn--secondary ui-btn--sm">Register as a supplier</Link>} />
          </div>
        ) : (
          <div className="lpx-cards">
            {data.open.map((b) => (
              <Link to="/public" className="lpx-card" key={b.code}>
                <div className="lpx-card-top">
                  <Thumbnail size={56} category={b.category} alt="" />
                  <div style={{ minWidth: 0 }}>
                    <span className="rf-code">{b.code}</span>
                    <h3 className="lpx-card-title">{b.name}</h3>
                    <span className="lpx-card-cat">{b.category || 'Uncategorised'}</span>
                  </div>
                </div>
                <div className="lpx-card-foot">
                  <div>
                    <small>Approved budget (ABC)</small>
                    <strong>{peso(b.budget)}</strong>
                  </div>
                  <div className="lpx-card-side">
                    <Countdown deadline={b.deadline} />
                    <span>{b.bids} bid{b.bids === 1 ? '' : 's'} so far</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="lp-section lpx-section lpx-section-alt" id="awards" aria-labelledby="awards-h">
        <div className="lpx-section-head">
          <div>
            <div className="lp-section-label">RESULTS</div>
            <h2 className="lp-section-title" id="awards-h">Recently awarded</h2>
          </div>
          <Link to="/public" className="lpx-more">All awarded contracts <ArrowRight size={14} /></Link>
        </div>
        {loading ? (
          <Skeleton height={200} radius={12} />
        ) : error || !data?.awards?.length ? (
          <div className="lpx-empty">
            <EmptyState icon={Trophy} title={error ? 'Awards could not load' : 'No contracts awarded yet'}
              description={error ? 'Please try again in a moment.' : 'Awarded contracts, their winners and amounts are published here.'} />
          </div>
        ) : (
          <ul className="lpx-awards">
            {data.awards.map((a) => (
              <li key={a.code} className="lpx-award">
                <div style={{ minWidth: 0 }}>
                  <div className="lpx-award-title">{a.name}</div>
                  <div className="lpx-award-sub"><span className="rf-code">{a.code}</span> Awarded to <strong>{a.winner}</strong></div>
                </div>
                <div className="lpx-award-side">
                  <span className="rf-amount">{peso(a.amount)}</span>
                  <span className="lpx-award-date">{fmtDate(a.awarded_at)}</span>
                  {a.anchored && (
                    <a className="lpx-verified" href={a.explorer_url} target="_blank" rel="noopener noreferrer"
                      title="View the award transaction on Etherscan (opens in a new tab)">
                      <ShieldCheck size={13} aria-hidden="true" /> Verified on-chain
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="lp-section lp-hiw lpx-section" id="how-it-works" aria-labelledby="hiw-h">
        <div className="lp-section-label">PROCESS</div>
        <h2 className="lp-section-title" id="hiw-h">How a procurement moves</h2>
        <p className="lp-section-sub">The same eight stages every procurement in this system goes through. Each one is recorded on the blockchain when it happens.</p>
        <div className="lpx-stepper"><ProcurementStepper label="Procurement lifecycle stages" /></div>
        <ol className="lpx-stage-notes">
          {STAGE_NOTES.map(([title, desc]) => (
            <li key={title}><strong>{title}</strong><span>{desc}</span></li>
          ))}
        </ol>
      </section>

      </div>

      <section className="lp-section lp-features-sec" id="features">
        <div className="lp-section-label">CAPABILITIES</div>
        <h2 className="lp-section-title">What the system does</h2>
        <div className="lp-features-grid">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div className="lp-feature-card" key={title}>
              <div className="lp-feature-icon"><Icon size={20} /></div>
              <h3>{title}</h3>
              <p>{desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section lp-roles-sec" id="roles">
        <div className="lp-section-label">ACCESS</div>
        <h2 className="lp-section-title">Who uses it</h2>
        <p className="lp-section-sub">Three signed-in roles, plus the public — who can check everything without an account.</p>
        <div className="lp-roles-grid lpx-roles">
          {ROLES.map(({ icon: Icon, title, subtitle, perks, cta, to, variant }) => (
            <div className={`lp-role-card lp-role-${variant}`} key={title}>
              <div className={`lp-role-icon lp-role-icon-${variant}`}><Icon size={22} /></div>
              <h3>{title}</h3>
              <p className="lp-role-sub">{subtitle}</p>
              <ul className="lp-role-perks">
                {perks.map((p) => <li key={p}><CheckCircle size={15} className="lp-check" />{p}</li>)}
              </ul>
              <Link to={to} className={`lp-role-cta lp-role-cta-${variant}`}>{cta} →</Link>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-cta">
        <div className="lp-cta-badge"><span className="lp-dot" />Ready to bid?</div>
        <h2>Join the Platform</h2>
        <p>Register your company as a supplier to bid on procurements in your categories, or log in to your workspace.</p>
        <div className="lp-cta-btns">
          <Link to="/register" className="btn-primary"><Building2 size={16} /> Register as Supplier</Link>
          <Link to="/login" className="btn-outline">Login</Link>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-footer-top">
          <div className="lp-footer-brand">
            <Link to="/" className="lp-logo">
              <span className="lp-logo-icon"><Shield size={16} /></span>
              <div className="lp-logo-name">E-Procurement</div>
            </Link>
            <p>A procurement platform with a tamper-evident blockchain audit trail, aligned with RA 12009.</p>
          </div>
          <div className="lp-footer-col">
            <h4>PRODUCT</h4>
            <a href="#features">Features</a>
            <a href="#how-it-works">How It Works</a>
            <a href="#roles">Roles</a>
          </div>
          <div className="lp-footer-col">
            <h4>EXPLORE</h4>
            <Link to="/public">Public Results</Link>
            <Link to="/public#verify">Verify a Procurement</Link>
            <Link to="/register">Register as Supplier</Link>
          </div>
          <div className="lp-footer-col">
            <h4>LEGAL</h4>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
          </div>
        </div>
        <div className="lp-footer-bottom">
          <span>© 2026 E-Procurement Blockchain System. All rights reserved.</span>
          <div className="lp-footer-links">
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
