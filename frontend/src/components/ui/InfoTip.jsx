import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

const TIP_HALF_WIDTH = 140
const EDGE = 8

/**
 * A small "i" that reveals one piece of secondary information on hover, keyboard
 * focus or tap. Rendered in a portal so a card's or table's overflow can't clip it.
 * Not for anything a user must read to act safely: warnings stay on the page.
 */
export default function InfoTip({ text, label = 'More information', size = 14 }) {
  const [pos, setPos] = useState(null)
  const btn = useRef(null)
  const id = useId()

  const show = () => {
    const r = btn.current.getBoundingClientRect()
    const min = TIP_HALF_WIDTH + EDGE
    const left = Math.min(Math.max(r.left + r.width / 2, min), window.innerWidth - min)
    const above = r.bottom > window.innerHeight - 140
    setPos({ left, top: above ? r.top - EDGE : r.bottom + EDGE, above })
  }
  const hide = () => setPos(null)

  useEffect(() => {
    if (!pos) return undefined
    const onKey = (e) => { if (e.key === 'Escape') hide() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', hide, true)
    }
  }, [pos])

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="ui-tip"
        aria-label={label}
        aria-describedby={pos ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        // A tap also focuses the button, so this must show, not toggle. The
        // tip may sit inside a clickable row or a label: don't trigger those.
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); show() }}
      >
        <Info size={size} aria-hidden="true" />
      </button>
      {pos && createPortal(
        <div
          id={id}
          role="tooltip"
          className={`ui-tip-box${pos.above ? ' is-above' : ''}`}
          style={{ left: pos.left, top: pos.top, maxWidth: TIP_HALF_WIDTH * 2 }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  )
}
