import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

export const shortHash = (h, head = 10, tail = 6) =>
  h ? (h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h) : '—'

// Truncated monospace hash with a copy button. The full value is in the
// tooltip and is what gets copied.
export default function CopyHash({ value, head, tail, label = 'hash' }) {
  const [copied, setCopied] = useState(false)
  if (!value) return <span className="ui-hash"><span className="ui-hash-text">—</span></span>

  const copy = async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* Clipboard blocked — the value is still visible in the tooltip. */
    }
  }

  return (
    <span className="ui-hash" title={value}>
      <span className="ui-hash-text">{shortHash(value, head, tail)}</span>
      <button
        type="button"
        className={`ui-hash-copy${copied ? ' is-copied' : ''}`}
        onClick={copy}
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        title={copied ? 'Copied!' : `Copy full ${label}`}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  )
}
