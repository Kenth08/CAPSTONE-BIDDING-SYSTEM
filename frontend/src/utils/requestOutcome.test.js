import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NOT_RECEIVED_MESSAGE, STILL_RUNNING_MESSAGE, UNCONFIRMED_MESSAGE, newRequestKey, waitForOutcome,
} from './requestOutcome.js'

// A fake clock: each sleep moves time forward instead of waiting.
function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms } }
}

function answers(...states) {
  const fetchStatus = async () => {
    fetchStatus.calls += 1
    const next = states.length > 1 ? states.shift() : states[0]
    if (next instanceof Error) throw next
    return next
  }
  fetchStatus.calls = 0
  return fetchStatus
}

test('a request that finished while the answer was lost resolves to its stored answer', async () => {
  const c = clock()
  const fetchStatus = answers({ state: 'pending' }, { state: 'done', status: 201, body: { id: 79 } })
  assert.deepEqual(await waitForOutcome(fetchStatus, c), { status: 201, body: { id: 79 } })
  assert.equal(fetchStatus.calls, 2)
})

test('a stored failure is passed on like any other answer', async () => {
  const c = clock()
  const out = await waitForOutcome(answers({ state: 'done', status: 400, body: { detail: 'No.' } }), c)
  assert.deepEqual(out, { status: 400, body: { detail: 'No.' } })
})

test('a request the server never heard of is reported as not received, after a grace period', async () => {
  const c = clock()
  await assert.rejects(waitForOutcome(answers({ state: 'unknown' }), c), { message: NOT_RECEIVED_MESSAGE })
  assert.ok(c.now() >= 45_000, 'it waits in case the request is still queued')
  assert.ok(c.now() < 60_000)
})

test('a request that arrives late (queued behind others) is still picked up', async () => {
  const c = clock()
  const fetchStatus = answers({ state: 'unknown' }, { state: 'unknown' }, { state: 'pending' },
    { state: 'done', status: 201, body: {} })
  assert.equal((await waitForOutcome(fetchStatus, c)).status, 201)
})

test('a request still running after the limit says so instead of claiming failure', async () => {
  const c = clock()
  await assert.rejects(waitForOutcome(answers({ state: 'pending' }), c), { message: STILL_RUNNING_MESSAGE })
  assert.ok(c.now() >= 3 * 60_000)
})

test('failed polls are retried, and with no answer at all nothing is claimed either way', async () => {
  const c = clock()
  const flaky = answers(new Error('offline'), new Error('offline'), { state: 'done', status: 200, body: null })
  assert.equal((await waitForOutcome(flaky, c)).status, 200)

  const c2 = clock()
  await assert.rejects(waitForOutcome(answers(new Error('offline')), c2), { message: UNCONFIRMED_MESSAGE })
})

test('request keys are random and match the format the server accepts', () => {
  const a = newRequestKey()
  const b = newRequestKey()
  assert.notEqual(a, b)
  assert.match(a, /^[A-Za-z0-9-]{16,64}$/)
})
