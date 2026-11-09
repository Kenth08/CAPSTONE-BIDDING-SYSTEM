// Shared list of procurement categories: the built-in ones plus any the Admin
// added (GET /api/categories/). Starts with the built-in list so forms work
// instantly and still work if the request fails; refreshed once per page load.
import { useEffect, useSyncExternalStore } from 'react'
import { apiAddCategory, apiListCategories } from '../api'
import { CATEGORIES } from '../constants/categories'

let categories = CATEGORIES
let inflight = null
let loaded = false
const listeners = new Set()

function setCategories(next) {
  if (!Array.isArray(next) || !next.length) return
  categories = next
  listeners.forEach(fn => fn())
}

export function loadCategories({ force = false } = {}) {
  if (inflight) return inflight
  if (loaded && !force) return Promise.resolve(categories)
  inflight = apiListCategories()
    .then(data => { loaded = true; setCategories(data?.categories); return categories })
    .catch(() => categories)        // keep the built-in list; the server re-validates anyway
    .finally(() => { inflight = null })
  return inflight
}

// Admin only. Returns the stored name (an existing one if it matched).
export async function addCategory(name) {
  const data = await apiAddCategory(name)
  setCategories(data?.categories)
  return data?.name || name
}

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }

export function useCategories() {
  useEffect(() => { loadCategories() }, [])
  return useSyncExternalStore(subscribe, () => categories)
}
