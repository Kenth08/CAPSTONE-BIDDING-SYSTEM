import { useEffect, useState } from 'react'
import { apiFetchFileBlob, protectedFilePath } from '../../api'

/**
 * The displayable src for an image that may be a protected file.
 *
 * Protected files (/api/files/…) need the JWT, which an <img src> can't send,
 * so they are fetched with it and shown from a short-lived blob: URL that is
 * revoked when the component unmounts. Anything else (a local preview blob,
 * a public asset) is passed straight through.
 */
export function useSecureSrc(src) {
  const isProtected = !!protectedFilePath(src)
  const [state, setState] = useState({ src: null, failed: false })

  useEffect(() => {
    if (!isProtected) return undefined
    let objectUrl = null
    let cancelled = false
    setState({ src: null, failed: false })
    apiFetchFileBlob(src)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setState({ src: objectUrl, failed: false })
      })
      .catch(() => { if (!cancelled) setState({ src: null, failed: true }) })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src, isProtected])

  if (!src) return { src: null, failed: false }
  return isProtected ? state : { src, failed: false }
}

/** Drop-in <img> that can display protected images. Same props as <img>. */
export default function SecureImg({ src, onError, ...props }) {
  const { src: shown, failed } = useSecureSrc(src)
  useEffect(() => { if (failed) onError?.() }, [failed, onError])
  if (!shown) return null
  return <img src={shown} onError={onError} {...props} />
}
