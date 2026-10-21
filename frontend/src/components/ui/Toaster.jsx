import { useSyncExternalStore } from 'react'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'

// Tiny app-wide toast queue. Call toast.success('Saved') from any handler and
// render <Toaster /> once per layout.
let items = []
let seq = 0
const listeners = new Set()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l) }
const snapshot = () => items

function push(type, message, ms = 4500) {
  const id = ++seq
  items = [...items.slice(-3), { id, type, message }]
  emit()
  setTimeout(() => dismiss(id), ms)
  return id
}
export function dismiss(id) {
  items = items.filter((t) => t.id !== id)
  emit()
}

export const toast = {
  success: (m) => push('success', m),
  error: (m) => push('error', m, 7000),
  info: (m) => push('info', m),
}

const ICON = { success: CheckCircle2, error: AlertTriangle, info: Info }

export default function Toaster() {
  const list = useSyncExternalStore(subscribe, snapshot)
  return (
    <div className="rf-toaster" aria-live="polite" aria-relevant="additions">
      {list.map((t) => {
        const Icon = ICON[t.type]
        return (
          <div key={t.id} className={`rf-toast rf-toast--${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
            <Icon size={16} aria-hidden="true" />
            <span>{t.message}</span>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification"><X size={14} /></button>
          </div>
        )
      })}
    </div>
  )
}
