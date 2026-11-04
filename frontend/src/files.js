// Downloading protected documents.
//
// The backend never hands out a file URL that works on its own. The `url` on a
// document in any API response is just an address; opening it without a login
// returns 404. When a user clicks one:
//
//   1. we POST /files/<kind>/<pk>/<field>/link/ with their JWT, and the backend
//      re-checks that THIS user may read THIS file;
//   2. it answers with a one-time link that expires after 2 minutes;
//   3. we navigate to it, the browser saves the file, and the backend logs the
//      download. A copied link is already spent, so sharing it achieves nothing.
//
// Rather than rewrite every <a href={doc.url}> in the dashboards, one listener
// (installProtectedFileLinks, called from main.jsx) intercepts clicks on any
// link that points at /api/files/ and runs the flow above.
import { apiFileDownloadLink } from './api'
import { shouldInterceptFileLink } from './utils/fileUrls'
import { toast } from './components/ui/Toaster'

/** Start a download of a protected file the signed-in user may read. */
export async function downloadProtectedFile(url) {
  try {
    const link = await apiFileDownloadLink(url)
    const a = document.createElement('a')
    a.href = link
    a.rel = 'noopener noreferrer'
    // Marked so onClick below lets this click through: its href is also an
    // /api/files/ URL, and intercepting it would request a new link forever.
    a.dataset.oneTimeLink = 'true'
    // The response is `Content-Disposition: attachment`, so the browser saves
    // the file and the page itself never navigates away.
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (err) {
    toast.error(err?.message || 'This document could not be downloaded.')
  }
}

function protectedAnchor(event) {
  const a = event.target?.closest?.('a[href]')
  if (!a) return null
  return shouldInterceptFileLink(a.getAttribute('href'), { oneTime: !!a.dataset.oneTimeLink }) ? a : null
}

function onClick(event) {
  // Only the primary/middle button; leave modified clicks on other links alone.
  if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return
  const a = protectedAnchor(event)
  if (!a) return
  event.preventDefault()
  event.stopPropagation()
  downloadProtectedFile(a.getAttribute('href'))
}

let installed = false

/** Route every click on a protected-file link through downloadProtectedFile. */
export function installProtectedFileLinks() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('click', onClick, true)
  document.addEventListener('auxclick', onClick, true)   // middle-click "open in new tab"
}
