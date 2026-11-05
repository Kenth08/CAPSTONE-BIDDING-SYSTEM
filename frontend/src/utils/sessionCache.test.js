import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dropCached, getCached, loadCached, onSessionReset, resetSessionCache, sessionGeneration, updateCached,
} from './sessionCache.js'

test('a loaded value is available to the next visit', async () => {
  resetSessionCache()
  assert.equal(getCached('k'), undefined)
  assert.equal(await loadCached('k', async () => 'v1'), 'v1')
  assert.equal(getCached('k'), 'v1')
})

test('an empty result still counts as loaded, so it shows no skeleton', async () => {
  resetSessionCache()
  await loadCached('k', async () => [])
  assert.deepEqual(getCached('k'), [])
})

test('a refresh replaces the value, and a failed one keeps the old value', async () => {
  resetSessionCache()
  await loadCached('k', async () => 'old')
  await loadCached('k', async () => 'new')
  assert.equal(getCached('k'), 'new')
  await assert.rejects(loadCached('k', async () => { throw new Error('offline') }), /offline/)
  assert.equal(getCached('k'), 'new')
})

test('a reset removes every entry', async () => {
  resetSessionCache()
  await loadCached('a', async () => 1)
  await loadCached('b', async () => 2)
  resetSessionCache()
  assert.equal(getCached('a'), undefined)
  assert.equal(getCached('b'), undefined)
})

test("a response that arrives after sign-out does not reach the next user's cache", async () => {
  resetSessionCache()
  let finish
  const pending = loadCached('k', () => new Promise((resolve) => { finish = resolve }))
  resetSessionCache()
  finish("previous user's data")
  // The page that asked still gets its answer; it just isn't kept.
  assert.equal(await pending, "previous user's data")
  assert.equal(getCached('k'), undefined)
})

test('a reset moves the generation on and tells registered stores', () => {
  let calls = 0
  const stop = onSessionReset(() => { calls += 1 })
  const before = sessionGeneration()
  resetSessionCache()
  assert.equal(sessionGeneration(), before + 1)
  assert.equal(calls, 1)
  stop()
  resetSessionCache()
  assert.equal(calls, 1)
})

test('updateCached changes an existing entry and never creates one', async () => {
  resetSessionCache()
  updateCached('k', () => 'created')
  assert.equal(getCached('k'), undefined)
  await loadCached('k', async () => 1)
  updateCached('k', (n) => n + 1)
  assert.equal(getCached('k'), 2)
})

test('dropCached removes one entry and leaves the others', async () => {
  resetSessionCache()
  await loadCached('a', async () => 1)
  await loadCached('b', async () => 2)
  dropCached('a')
  assert.equal(getCached('a'), undefined)
  assert.equal(getCached('b'), 2)
})
