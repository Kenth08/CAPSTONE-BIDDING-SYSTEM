// What to do when a save's answer never arrives.
//
// The live host cuts any request at 30 seconds and answers with an error the
// browser can't even read, so fetch() just fails. The server usually goes on
// and finishes. Before this, the page said "Cannot reach the server" about a
// procurement, bid or registration that had been saved, people sent it again,
// and duplicates followed (2026-11-10).
//
// Now every write carries a random Idempotency-Key. When the answer is lost, the
// page asks the server how that request ended (GET /auth/requests/<key>/; see
// backend/accounts/idempotency.py) and continues as if the answer had arrived.

/** Status codes the host's router sends when it, not the app, gave up. */
export const LOST_ANSWER_STATUSES = new Set([502, 503, 504])

export const POLL_EVERY_MS = 3_000
// How long to wait for a request that is still running. The host has already
// given up, so this only decides how long the page keeps the spinner up.
export const WAIT_FOR_PENDING_MS = 3 * 60_000
// A request the server has never heard of may still be queued behind others on
// the server; after this long it is taken as never received.
export const WAIT_FOR_UNKNOWN_MS = 45_000

export const STILL_RUNNING_MESSAGE =
  'The server is still working on this. It may already be saved, so refresh the page in a minute ' +
  'and check before submitting again.'
export const UNCONFIRMED_MESSAGE =
  'The connection to the server was lost, so this could not be confirmed. It may already be saved: ' +
  'refresh the page when you are back online and check before submitting again.'
export const NOT_RECEIVED_MESSAGE =
  'The connection dropped before the server received this. Please check your connection and try again.'

/** A random key for one submission. */
export function newRequestKey() {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  const bytes = new Uint8Array(16)
  c.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ask until the request sent with `key` is known to have ended.
 *
 * `fetchStatus()` resolves to the server's {state, status?, body?}, or rejects
 * when the poll itself failed (a flaky network: it is simply tried again).
 *
 * Resolves to {status, body} once the request finished; rejects with
 * STILL_RUNNING_MESSAGE, UNCONFIRMED_MESSAGE or NOT_RECEIVED_MESSAGE when it
 * didn't in time.
 */
export async function waitForOutcome(fetchStatus, {
  sleep = defaultSleep,
  now = Date.now,
  pollEveryMs = POLL_EVERY_MS,
  waitForPendingMs = WAIT_FOR_PENDING_MS,
  waitForUnknownMs = WAIT_FOR_UNKNOWN_MS,
} = {}) {
  const started = now()
  let seenRunning = false
  let reached = false   // got any answer from the status endpoint at all
  for (;;) {
    let outcome = null
    try {
      outcome = await fetchStatus()
      reached = true
    } catch {
      outcome = null
    }
    if (outcome?.state === 'done') return { status: outcome.status, body: outcome.body ?? null }
    if (outcome?.state === 'pending') seenRunning = true

    const waited = now() - started
    if (seenRunning || !reached) {
      // Running (or we can't ask yet): wait for it, up to the limit.
      if (waited >= waitForPendingMs) {
        throw new Error(seenRunning ? STILL_RUNNING_MESSAGE : UNCONFIRMED_MESSAGE)
      }
    } else if (waited >= waitForUnknownMs) {
      throw new Error(NOT_RECEIVED_MESSAGE)
    }
    await sleep(pollEveryMs)
  }
}
