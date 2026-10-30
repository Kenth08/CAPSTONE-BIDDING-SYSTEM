// Recognising protected-file addresses in API responses.
//
// The backend serves every upload from /api/files/<kind>/<pk>/<field>/ and
// never hands out a URL that works on its own (see frontend/src/files.js).

/**
 * Should a click on this link be turned into a one-time download?
 * Yes for a protected-file address; no for the one-time link itself (marked
 * `oneTime`), which would otherwise request a new link on every click, forever.
 */
export function shouldInterceptFileLink(href, { oneTime = false } = {}) {
  return !oneTime && protectedFilePath(href) !== null
}

/** The API-relative path ("/files/…/") of a protected file URL, or null. */
export function protectedFilePath(url) {
  if (typeof url !== 'string') return null
  const i = url.indexOf('/api/files/')
  if (i === -1) return null
  const path = url.slice(i + '/api'.length).split(/[?#]/)[0]
  return path.endsWith('/') ? path : `${path}/`
}
