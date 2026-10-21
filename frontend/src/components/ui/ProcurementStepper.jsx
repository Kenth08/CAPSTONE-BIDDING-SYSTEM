import { AlertTriangle, Check, Link2, XCircle } from 'lucide-react'
import { fmtDate } from '../../utils/format'

/**
 * The real lifecycle of a procurement in this system, in order. `stages` are
 * the BlockchainAnchor stages that witness each step on-chain (a step shows the
 * chain icon once any of them has a confirmed transaction).
 */
export const PROCUREMENT_STAGES = [
  { key: 'draft',      label: 'Draft',              stages: [] },
  { key: 'head',       label: 'Head Review',        stages: ['SUBMITTED', 'HEAD_APPROVED', 'HEAD_REJECTED', 'REVISION_REQUESTED'] },
  { key: 'published',  label: 'Published',          sub: 'Bidding open', stages: ['BIDDING_OPEN'] },
  { key: 'evaluation', label: 'Evaluation',         stages: ['BID_QUALIFIED', 'BID_DISQUALIFIED'] },
  { key: 'awarded',    label: 'Awarded',            stages: ['AWARDED'] },
  { key: 'resolution', label: 'BAC Resolution',     stages: ['RESOLUTION_ISSUED'] },
  { key: 'noa',        label: 'Notice of Award',    stages: ['NOA_ISSUED'] },
  { key: 'ntp',        label: 'Notice to Proceed',  stages: ['NTP_ISSUED'] },
]

const AFTER_APPROVAL = ['approved', 'published', 'closed', 'awarded']
const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Work out each stage's state from the project's own timestamps.
 * project: raw API fields { status, created_at, reviewed_at, published_at,
 *          deadline, awarded_at, anchors }
 * award:   optional award record ({ documents: [{ stage, issued_at }] })
 * Returns [{ ...stage, state: done|current|attention|error|upcoming, date, anchored }].
 */
export function procurementSteps(project, award) {
  if (!project) return PROCUREMENT_STAGES.map((s) => ({ ...s, state: 'upcoming' }))
  const st = project.status
  const anchors = project.anchors || []
  const anchored = (stages) => anchors.some((a) => a.anchored && stages.includes(a.stage))
  const docs = Object.fromEntries((award?.documents || []).map((d) => [d.stage, d]))
  const biddingOver = st === 'closed' || st === 'awarded' || (st === 'published' && project.deadline && project.deadline < todayIso())

  const done = {
    draft: st !== 'draft',
    head: AFTER_APPROVAL.includes(st),
    published: ['published', 'closed', 'awarded'].includes(st) && biddingOver,
    evaluation: st === 'awarded',
    awarded: st === 'awarded',
    resolution: !!docs.RESOLUTION_ISSUED?.issued_at,
    noa: !!docs.NOA_ISSUED?.issued_at,
    ntp: !!docs.NTP_ISSUED?.issued_at,
  }
  const dates = {
    draft: project.created_at,
    head: project.reviewed_at,
    published: project.published_at,
    evaluation: biddingOver ? project.deadline : null,
    awarded: project.awarded_at,
    resolution: docs.RESOLUTION_ISSUED?.issued_at,
    noa: docs.NOA_ISSUED?.issued_at,
    ntp: docs.NTP_ISSUED?.issued_at,
  }

  let currentFound = false
  return PROCUREMENT_STAGES.map((s) => {
    let state
    if (done[s.key]) state = 'done'
    else if (!currentFound) {
      currentFound = true
      state = s.key === 'head' && st === 'rejected' ? 'error'
        : s.key === 'head' && st === 'needs_revision' ? 'attention'
        : 'current'
    } else state = 'upcoming'
    return { ...s, state, date: state === 'done' || state === 'current' ? dates[s.key] : null, anchored: anchored(s.stages) }
  })
}

const STATE_TEXT = {
  done: 'completed', current: 'current stage', attention: 'needs revision',
  error: 'rejected', upcoming: 'not reached yet',
}

/**
 * Horizontal lifecycle stepper. Highlights the current stage, shows the date
 * under each completed one, and a chain icon on stages anchored on Sepolia.
 * Without `project` it renders the plain process (used on the landing page).
 */
export default function ProcurementStepper({ project, award, label = 'Procurement lifecycle', compact = false }) {
  const steps = procurementSteps(project, award)
  return (
    <ol className={`rf-pstep${compact ? ' is-compact' : ''}${project ? '' : ' is-static'}`} aria-label={label}>
      {steps.map((s, i) => (
        <li key={s.key} className={`rf-pstep-item is-${s.state}`} aria-current={s.state === 'current' || s.state === 'attention' ? 'step' : undefined}>
          <span className="rf-pstep-dot" aria-hidden="true">
            {s.state === 'done' ? <Check size={14} />
              : s.state === 'error' ? <XCircle size={14} />
              : s.state === 'attention' ? <AlertTriangle size={13} />
              : i + 1}
          </span>
          <span className="rf-pstep-label">
            {s.label}
            {s.anchored && (
              <span className="rf-pstep-chain" title="Recorded on the Sepolia blockchain">
                <Link2 size={11} aria-hidden="true" /><span className="sr-only"> (anchored on-chain)</span>
              </span>
            )}
          </span>
          {s.sub && !project && <span className="rf-pstep-date">{s.sub}</span>}
          {project && <span className="rf-pstep-date">{s.date ? fmtDate(s.date) : s.state === 'error' ? 'Rejected' : s.state === 'attention' ? 'Revision requested' : ' '}</span>}
          {project && <span className="sr-only">({STATE_TEXT[s.state]})</span>}
        </li>
      ))}
    </ol>
  )
}
