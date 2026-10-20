import { Inbox } from 'lucide-react'

// Friendly "nothing here yet" block: icon, title, one line of help, and an
// optional action. Use `compact` inside small cards; wrap in <TableEmpty> when
// it sits inside a <tbody>.
export default function EmptyState({ icon: Icon = Inbox, title, description, action, compact = false }) {
  return (
    <div className={`ui-empty${compact ? ' ui-empty--compact' : ''}`} role="status">
      <div className="ui-empty-icon" aria-hidden="true"><Icon size={compact ? 18 : 22} /></div>
      {title && <div className="ui-empty-title">{title}</div>}
      {description && <div className="ui-empty-desc">{description}</div>}
      {action && <div className="ui-empty-actions">{action}</div>}
    </div>
  )
}

// Same empty state, spanning every column of a table.
export function TableEmpty({ colSpan, ...props }) {
  return (
    <tr>
      <td colSpan={colSpan} className="ui-empty-cell">
        <EmptyState compact {...props} />
      </td>
    </tr>
  )
}
