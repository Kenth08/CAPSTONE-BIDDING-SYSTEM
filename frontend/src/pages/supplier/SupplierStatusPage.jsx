import { FileText, Clock, CheckCircle2, Trophy } from 'lucide-react'
import StatusBadge from '../../components/ui/StatusBadge'
import {
  EmailVerifyBanner, fmtDate,
} from './shared'

export default function SupplierStatusPage({ bids, profile, eligible, setToast }) {
  const qs = profile?.qualification_status
  const verifyDate =
    qs === 'verified' ? (profile?.reviewed_at ? fmtDate(profile.reviewed_at) : 'Approved')
    : qs === 'needs_revision' ? 'Revision requested'
    : qs === 'rejected' ? 'Rejected'
    : 'Pending review'
  const steps = [
    {
      label: 'Account Registered',
      date: fmtDate(profile?.registered) || '—',
      done: true,
      desc: 'Account created and submitted for review.',
    },
    {
      label: 'Admin Verification',
      date: verifyDate,
      done: qs === 'verified',
      desc: 'The admin reviews your details and documents.',
    },
    {
      label: 'Eligible to Bid',
      date: eligible ? 'Active' : 'Locked until approved',
      done: !!eligible,
      desc: 'Once approved, you can bid on published projects.',
    },
    {
      label: 'Bids Submitted',
      date: bids.length > 0 ? `${bids.length} bid${bids.length > 1 ? 's' : ''} total` : 'No bids yet',
      done: bids.length > 0,
      desc: 'Listed under My Bids.',
    },
    {
      // "Shortlisted" = the Admin marked a bid Qualified. A bid holds one status,
      // and a winner moves on from qualified to winner, so a winning bid was
      // shortlisted too. Checking only `qualified` left this step pending for the
      // supplier who won.
      label: 'Bid Shortlisted',
      date: bids.some(b => b.status === 'qualified' || b.status === 'winner') ? 'Active' : 'Pending evaluation',
      done: bids.some(b => b.status === 'qualified' || b.status === 'winner'),
      desc: 'A bid is shortlisted for final evaluation.',
    },
    {
      label: 'Contract Awarded',
      date: bids.some(b => b.status === 'winner') ? 'Awarded!' : 'Awaiting decision',
      done: bids.some(b => b.status === 'winner'),
      desc: 'A winner is selected for the project.',
    },
  ]

  return (
    <div className="sd-content">
      <EmailVerifyBanner profile={profile} setToast={setToast} />
      <div className="sd-stats">
        {[
          { label: 'Bids Submitted',  value: String(bids.length),                                             icon: FileText,     color: 'blue'   },
          { label: 'Under Review',    value: String(bids.filter(b => b.status === 'under_review').length),    icon: Clock,        color: 'yellow' },
          { label: 'Shortlisted',     value: String(bids.filter(b => b.status === 'qualified').length),       icon: CheckCircle2, color: 'green'  },
          { label: 'Won',             value: String(bids.filter(b => b.status === 'winner').length),          icon: Trophy,       color: 'purple' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div className="sd-stat-card" key={label}>
            <div className="sd-stat-top">
              <span className="sd-stat-label">{label}</span>
              <div className={`sd-stat-icon sd-icon-${color}`}><Icon size={17} /></div>
            </div>
            <div className="sd-stat-value">{value}</div>
          </div>
        ))}
      </div>

      <div className="sd-card">
        <div className="sd-card-header">
          <div><h2>Account & Bid Timeline</h2></div>
          <StatusBadge tone={steps.every(st => st.done) ? 'success' : 'neutral'} dot={false}
            label={`${steps.filter(st => st.done).length} of ${steps.length} complete`} />
        </div>
        <div className="sd-timeline">
          {steps.map((step, i) => (
            <div className={`sd-timeline-step ${step.done ? 'done' : 'pending'}`} key={i}>
              <div className="sd-tl-left">
                <div className="sd-tl-dot">{step.done ? <CheckCircle2 size={16} /> : <Clock size={16} />}</div>
                {i < steps.length - 1 && <div className="sd-tl-line" />}
              </div>
              <div className="sd-tl-body">
                <div className="sd-tl-title">{step.label}</div>
                <div className="sd-tl-date">{step.date}</div>
                <div className="sd-tl-desc">{step.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
