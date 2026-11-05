// Page data kept for the current login, so going back to a page shows what it
// showed last time instead of a skeleton, while it refreshes in the background.
//
// Memory only, never localStorage: a browser reload starts empty, and nothing
// outlives the tab. Pages must still fetch on every visit. This cache decides
// what to show meanwhile; it never replaces asking the server.
//
// Data belongs to whoever was signed in when it was requested, so a sign-in,
// sign-out or expired session empties it. `generation` covers the request still
// running at that moment: its answer is for the previous user and isn't kept.
const entries = new Map()
const resetListeners = new Set()
let generation = 0

export const sessionGeneration = () => generation

/** The last value for `key`, or undefined when this session has none yet. */
export const getCached = (key) => entries.get(key)

export const dropCached = (key) => { entries.delete(key) }

/** Runs `fetcher` and keeps its result, unless the session changed meanwhile. */
export function loadCached(key, fetcher) {
  const startedIn = generation
  return fetcher().then((value) => {
    if (startedIn === generation) entries.set(key, value)
    return value
  })
}

/** Applies a local change to an existing entry. Does nothing if there is none. */
export function updateCached(key, update) {
  if (entries.has(key)) entries.set(key, update(entries.get(key)))
}

/** Stores that keep their own state register here to be emptied with this one. */
export function onSessionReset(listener) {
  resetListeners.add(listener)
  return () => resetListeners.delete(listener)
}

export function resetSessionCache() {
  generation += 1
  entries.clear()
  resetListeners.forEach((listener) => listener())
}

// Signing in or out in another tab changes the account this tab's tokens belong
// to. `key` is null when the other tab called localStorage.clear().
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'user' || e.key === null) resetSessionCache()
  })
}
