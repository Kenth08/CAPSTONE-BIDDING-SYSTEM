// Remembers GET answers for a short time, so moving between pages doesn't ask the
// server again for data it sent a moment ago. Two pages that want the same data at
// once also share one request.
//
// Any change made through the API empties this (see apiFetch), so a person always
// sees the result of their own actions. Changes by someone else show up within
// FRESH_MS. Memory only: a browser reload starts empty.
export const FRESH_MS = 30_000

const entries = new Map()
// Moves on when the cache is emptied, so a request already running at that moment
// can't store an answer from before the change.
let epoch = 0

// Each caller gets its own copy, because pages are free to change what they receive.
const copy = (value) => (value === null || typeof value !== 'object' ? value : structuredClone(value))

export function clearRecentGets() {
  epoch += 1
  entries.clear()
}

/** The remembered answer for `key`, or `fetcher()`'s. `fresh` skips the remembered one. */
export function recentGet(key, fetcher, { fresh = false, now = Date.now } = {}) {
  if (fresh) entries.delete(key)
  const known = entries.get(key)
  if (known && (known.pending || now() - known.at < FRESH_MS)) {
    return known.promise.then(copy)
  }

  const startedIn = epoch
  const entry = { pending: true, at: 0, promise: null }
  entry.promise = Promise.resolve().then(fetcher).then(
    (value) => {
      if (startedIn === epoch && entries.get(key) === entry) {
        entry.pending = false
        entry.at = now()
      }
      return value
    },
    (error) => {
      // A failure is never remembered: the next visit or Retry asks again.
      if (entries.get(key) === entry) entries.delete(key)
      throw error
    },
  )
  entries.set(key, entry)
  return entry.promise.then(copy)
}
