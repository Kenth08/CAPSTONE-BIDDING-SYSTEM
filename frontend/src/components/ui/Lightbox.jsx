import { useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react'

/**
 * Full-size image viewer. Esc or a click outside closes it, ←/→ flip through
 * `images`, focus moves into the dialog and returns to the opener on close.
 * images: [{ url, caption }]. `reference` ({ url, caption }) is shown beside
 * the current image for side-by-side comparison (e.g. the project's reference
 * image next to a bidder's product photo).
 */
export default function Lightbox({ images = [], index = 0, onIndex, onClose, title, reference }) {
  const closeRef = useRef(null)
  const img = images[index]

  useEffect(() => {
    const opener = document.activeElement
    closeRef.current?.focus()
    return () => opener?.focus?.()
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      else if (e.key === 'ArrowRight' && index < images.length - 1) onIndex?.(index + 1)
      else if (e.key === 'ArrowLeft' && index > 0) onIndex?.(index - 1)
      else if (e.key === 'Tab') {
        // Keep focus inside the dialog.
        const nodes = [...document.querySelectorAll('.rf-lightbox button, .rf-lightbox a')]
        if (nodes.length === 0) return
        const first = nodes[0], last = nodes[nodes.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, images.length, onIndex, onClose])

  if (!img) return null
  return (
    <div className="rf-lightbox" role="dialog" aria-modal="true" aria-label={title || 'Image viewer'} onClick={onClose}>
      <div className={`rf-lightbox-inner${reference ? ' has-ref' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="rf-lightbox-head">
          <span className="rf-lightbox-title">{title}</span>
          <button ref={closeRef} type="button" className="ui-icon-btn rf-lightbox-close" onClick={onClose} aria-label="Close image viewer">
            <X size={18} />
          </button>
        </div>
        <div className="rf-lightbox-stage">
          {reference?.url && (
            <figure className="rf-lightbox-fig is-ref">
              <img src={reference.url} alt={reference.caption || 'Project reference image'} />
              <figcaption><strong>Reference</strong> {reference.caption}</figcaption>
            </figure>
          )}
          <figure className="rf-lightbox-fig">
            <img src={img.url} alt={img.caption || `Image ${index + 1} of ${images.length}`} />
            <figcaption>
              {img.caption || <span className="rf-muted">No caption</span>}
              {images.length > 1 && <span className="rf-muted"> · {index + 1} of {images.length}</span>}
            </figcaption>
          </figure>
        </div>
        <div className="rf-lightbox-bar">
          <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={index === 0}
            onClick={() => onIndex?.(index - 1)} aria-label="Previous image"><ChevronLeft size={14} /> Previous</button>
          <a className="ui-btn ui-btn--ghost ui-btn--sm" href={img.url} target="_blank" rel="noreferrer">
            <ExternalLink size={13} /> Open original
          </a>
          <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={index >= images.length - 1}
            onClick={() => onIndex?.(index + 1)} aria-label="Next image">Next <ChevronRight size={14} /></button>
        </div>
      </div>
    </div>
  )
}
