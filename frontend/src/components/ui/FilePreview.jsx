// Preview a protected document before downloading it.
//
// The file is fetched with the signed-in user's token through the same
// /api/files/... endpoint a download uses (procurement/files.py), so the server
// applies exactly the same permission check and audit log; nothing new is
// exposed. The bytes are shown from a local blob: URL: PDFs in a frame, images
// inline. Anything else (or a file that can't be read) offers the download.
import { useEffect, useRef, useState } from 'react'
import { Download, Eye, FileWarning, Loader2, X } from 'lucide-react'
import { apiFetchFileBlob } from '../../api'
import { downloadProtectedFile } from '../../files'
import '../../style/file-preview.css'

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

function kindOf(blob, name = '') {
  const type = (blob?.type || '').toLowerCase()
  const ext = name.toLowerCase().split('.').pop()
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (IMAGE_TYPES.includes(type) || ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'image'
  return 'other'
}

export function FilePreviewModal({ url, name, onClose }) {
  const [state, setState] = useState({ status: 'loading' })
  const closeRef = useRef(null)

  useEffect(() => {
    let alive = true
    let objectUrl = ''
    apiFetchFileBlob(url)
      .then(blob => {
        if (!alive) return
        const kind = kindOf(blob, name)
        // A PDF served as octet-stream still needs the right type to render.
        const typed = kind === 'pdf' && blob.type !== 'application/pdf'
          ? new Blob([blob], { type: 'application/pdf' }) : blob
        objectUrl = URL.createObjectURL(typed)
        setState({ status: 'ready', kind, src: objectUrl })
      })
      .catch(() => { if (alive) setState({ status: 'error' }) })
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [url, name])

  useEffect(() => {
    const opener = document.activeElement
    closeRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); opener?.focus?.() }
  }, [onClose])

  return (
    <div className="fp-overlay" onClick={onClose}>
      <div className="fp-dialog" role="dialog" aria-modal="true" aria-label={`Preview of ${name || 'document'}`}
        onClick={e => e.stopPropagation()}>
        <div className="fp-head">
          <span className="fp-name" title={name}>{name || 'Document'}</span>
          <div className="fp-actions">
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => downloadProtectedFile(url)}>
              <Download size={13} aria-hidden="true" /> Download
            </button>
            <button type="button" ref={closeRef} className="ui-icon-btn" onClick={onClose} aria-label="Close preview">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="fp-body">
          {state.status === 'loading' && (
            <div className="fp-center" role="status"><Loader2 size={22} className="ui-spin" aria-hidden="true" /> Loading preview…</div>
          )}
          {state.status === 'ready' && state.kind === 'pdf' && (
            <iframe className="fp-frame" src={state.src} title={`PDF preview of ${name || 'document'}`} />
          )}
          {state.status === 'ready' && state.kind === 'image' && (
            <img className="fp-image" src={state.src} alt={name || 'Document image'} />
          )}
          {(state.status === 'error' || (state.status === 'ready' && state.kind === 'other')) && (
            <div className="fp-center">
              <FileWarning size={28} aria-hidden="true" />
              <p>{state.status === 'error'
                ? 'This document could not be previewed. You may not have access to it, or it is no longer available.'
                : 'This file type can\'t be previewed here. Download it to open it.'}</p>
              {state.status !== 'error' && (
                <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => downloadProtectedFile(url)}>
                  <Download size={13} aria-hidden="true" /> Download
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function PreviewButton({ url, name, className = 'ui-btn ui-btn--ghost ui-btn--sm' }) {
  const [open, setOpen] = useState(false)
  if (!url) return null
  return (
    <>
      <button type="button" className={className}
        onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(true) }}
        aria-label={`Preview ${name || 'document'}`}>
        <Eye size={13} aria-hidden="true" /> Preview
      </button>
      {open && <FilePreviewModal url={url} name={name} onClose={() => setOpen(false)} />}
    </>
  )
}
