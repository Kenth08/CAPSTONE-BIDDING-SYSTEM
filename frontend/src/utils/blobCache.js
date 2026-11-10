// Protected images (reference photos, product photos) kept for this login, so a
// page that shows the same photo again doesn't download it again.
//
// The server marks these files no-store (they are permission-checked), so the
// browser's own cache never keeps them, and every dashboard visit fetched every
// photo once more: on a slow network, minutes per page (2026-11-10). This keeps
// them in memory only, for the current login. Emptied on sign-in or sign-out,
// and by any upload, which is the only way a photo behind an address changes.
export const MAX_ENTRIES = 40

const entries = new Map()   // key -> Promise<Blob>, oldest first

/** The Blob for `key`, fetched once and shared until the cache is emptied. */
export function cachedBlob(key, fetcher) {
  if (entries.has(key)) {
    const known = entries.get(key)
    entries.delete(key)          // move to the end: most recently used
    entries.set(key, known)
    return known
  }
  const promise = Promise.resolve().then(fetcher)
  entries.set(key, promise)
  // A failure isn't kept: the next viewer tries again.
  promise.catch(() => { if (entries.get(key) === promise) entries.delete(key) })
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
  return promise
}

export function clearBlobCache() {
  entries.clear()
}
