import test from 'node:test'
import assert from 'node:assert/strict'
import { clearRecentGets, FRESH_MS, recentGet } from './requestCache.js'

function counter(value = { rows: [1] }) {
  const fetcher = async () => { fetcher.calls += 1; return value }
  fetcher.calls = 0
  return fetcher
}

test('a repeat request within the fresh window does not reach the server', async () => {
  clearRecentGets()
  const fetcher = counter()
  await recentGet('/a/', fetcher)
  await recentGet('/a/', fetcher)
  assert.equal(fetcher.calls, 1)
})

test('two requests at the same moment share one', async () => {
  clearRecentGets()
  const fetcher = counter()
  await Promise.all([recentGet('/a/', fetcher), recentGet('/a/', fetcher)])
  assert.equal(fetcher.calls, 1)
})

test('after the fresh window the server is asked again', async () => {
  clearRecentGets()
  const fetcher = counter()
  let time = 1000
  const now = () => time
  await recentGet('/a/', fetcher, { now })
  time += FRESH_MS
  await recentGet('/a/', fetcher, { now })
  assert.equal(fetcher.calls, 2)
})

test('fresh skips the remembered answer and replaces it', async () => {
  clearRecentGets()
  const fetcher = counter()
  await recentGet('/a/', fetcher)
  await recentGet('/a/', fetcher, { fresh: true })
  assert.equal(fetcher.calls, 2)
  await recentGet('/a/', fetcher)
  assert.equal(fetcher.calls, 2)
})

test('clearing forgets everything', async () => {
  clearRecentGets()
  const fetcher = counter()
  await recentGet('/a/', fetcher)
  clearRecentGets()
  await recentGet('/a/', fetcher)
  assert.equal(fetcher.calls, 2)
})

test('an answer that began before a change is not kept for later', async () => {
  clearRecentGets()
  let finish
  const slow = () => new Promise((resolve) => { finish = resolve })
  const running = recentGet('/a/', slow)
  await Promise.resolve()
  clearRecentGets()
  finish('from before the change')
  assert.equal(await running, 'from before the change')

  const fetcher = counter('after the change')
  assert.equal(await recentGet('/a/', fetcher), 'after the change')
  assert.equal(fetcher.calls, 1)
})

test('a request made after a change does not join one from before it', async () => {
  clearRecentGets()
  let finish
  const running = recentGet('/a/', () => new Promise((resolve) => { finish = resolve }))
  await Promise.resolve()
  clearRecentGets()
  const fetcher = counter('new')
  assert.equal(await recentGet('/a/', fetcher), 'new')
  assert.equal(fetcher.calls, 1)
  finish('old')
  await running
})

test('a failure is not remembered', async () => {
  clearRecentGets()
  await assert.rejects(recentGet('/a/', async () => { throw new Error('down') }), /down/)
  const fetcher = counter('back')
  assert.equal(await recentGet('/a/', fetcher), 'back')
})

test('callers cannot change each other\'s data', async () => {
  clearRecentGets()
  const fetcher = counter({ rows: [1] })
  const first = await recentGet('/a/', fetcher)
  first.rows.push(2)
  assert.deepEqual((await recentGet('/a/', fetcher)).rows, [1])
})
