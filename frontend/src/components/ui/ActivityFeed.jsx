import {
  Activity, Award, CheckCircle2, FilePlus2, FileText, Gavel, Link2, Send, ShieldCheck, Trash2, UserCheck, XCircle,
} from 'lucide-react'
import EmptyState from './EmptyState'
import RelativeTime from './RelativeTime'

// Audit-log action key → icon + tone. Unknown actions fall back to a dot.
const ICONS = [
  [/^blockchain\./, Link2, 'info'],
  [/rejected|disqualif/, XCircle, 'danger'],
  [/deleted|withdraw/, Trash2, 'neutral'],
  [/revision/, FileText, 'warning'],
  [/approved|qualified|verified/, CheckCircle2, 'success'],
  [/published/, Send, 'info'],
  [/award|winner/, Award, 'success'],
  [/^bid\./, Gavel, 'info'],
  [/created|registered/, FilePlus2, 'neutral'],
  [/^supplier\./, UserCheck, 'neutral'],
  [/document/, ShieldCheck, 'neutral'],
]

function iconFor(action = '') {
  const hit = ICONS.find(([re]) => re.test(action))
  return hit ? { Icon: hit[1], tone: hit[2] } : { Icon: Activity, tone: 'neutral' }
}

/**
 * Who did what, when. items: [{ id, action, description, created_at,
 * actor: { name, role } }] — the audit-log shape from the admin summary.
 */
export default function ActivityFeed({ items = [], emptyText = 'Actions taken in the system will be listed here.' }) {
  if (items.length === 0) {
    return <EmptyState compact icon={Activity} title="No activity yet" description={emptyText} />
  }
  return (
    <ol className="rf-feed">
      {items.map((it) => {
        const { Icon, tone } = iconFor(it.action)
        return (
          <li key={it.id} className="rf-feed-item">
            <span className={`rf-feed-icon rf-tone-${tone}`} aria-hidden="true"><Icon size={14} /></span>
            <div className="rf-feed-body">
              <div className="rf-feed-text">{it.description || it.action}</div>
              <div className="rf-feed-meta">
                <span className="rf-feed-actor">{it.actor?.name || 'System'}</span>
                {it.actor?.role && <span className="rf-feed-role">{it.actor.role}</span>}
                <span aria-hidden="true">·</span>
                <RelativeTime value={it.created_at} />
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
