import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { apiListNotifications, apiMarkNotificationsRead } from '../api'
import './NotificationBell.css'

// Action verbs that follow an actor name (e.g. "pacia company submitted a bid on ...")
// so the actor can be bolded along with quoted project names and (CODE) references.
const ACTOR_VERBS = ['submitted a bid on', 'updated their bid on', 're-submitted']
const ENTITY_RE = new RegExp(
  `^[^.]+?(?=\\s+(?:${ACTOR_VERBS.join('|')}))|"[^"]+"|\\([A-Z][A-Z0-9-]*\\)`,
  'g'
)

function highlightMessage(message) {
  const parts = []
  let lastIndex = 0
  let match
  while ((match = ENTITY_RE.exec(message)) !== null) {
    if (match.index > lastIndex) parts.push(message.slice(lastIndex, match.index))
    parts.push(<strong key={match.index}>{match[0]}</strong>)
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < message.length) parts.push(message.slice(lastIndex))
  return parts
}

// Shared bell used by every dashboard. Fetches the signed-in user's own
// notifications (the API scopes them server-side), polls so new ones appear
// without a manual refresh, and marks them read when the dropdown is opened.
export default function NotificationBell() {
  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const timer = useRef(null)

  const load = () => { apiListNotifications().then(setItems).catch(() => {}) }

  useEffect(() => {
    load()
    timer.current = setInterval(load, 30000) // refresh every 30s
    return () => clearInterval(timer.current)
  }, [])

  const unread = items.filter(n => !n.is_read).length

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && unread > 0) {
      apiMarkNotificationsRead()
        .then(() => setItems(prev => prev.map(n => ({ ...n, is_read: true }))))
        .catch(() => {})
    }
  }

  const go = (link) => {
    setOpen(false)
    if (link) navigate(link)
  }

  return (
    <div className="nbell-wrap">
      <button className="nbell-btn" onClick={toggle} aria-label="Notifications">
        <Bell size={18} />
        {unread > 0 && <span className="nbell-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <>
          <div className="nbell-backdrop" onClick={() => setOpen(false)} />
          <div className="nbell-dropdown">
            <div className="nbell-head">Notifications</div>
            {items.length === 0 ? (
              <div className="nbell-empty">No notifications yet.</div>
            ) : (
              items.map(n => (
                <button
                  key={n.id}
                  className={`nbell-item${n.is_read ? '' : ' unread'}${n.link ? ' clickable' : ''}`}
                  onClick={() => go(n.link)}
                >
                  <div className="nbell-msg">{highlightMessage(n.message)}</div>
                  <div className="nbell-time">{new Date(n.created_at).toLocaleString()}</div>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
