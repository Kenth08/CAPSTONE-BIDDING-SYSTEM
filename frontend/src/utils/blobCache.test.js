import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ENTRIES, cachedBlob, clearBlobCache } from './blobCache.js'

function counter(value = 'blob') {
  const fetcher = async () => { fetcher.calls += 1; return value }
  fetcher.calls = 0
  return fetcher
}

test('the same photo is downloaded once and shared', async () => {
  clearBlobCache()
  const fetcher = counter()
  const [a, b] = await Promise.all([cachedBlob('/img/1/', fetcher), cachedBlob('/img/1/', fetcher)])
  await cachedBlob('/img/1/', fetcher)
  assert.equal(fetcher.calls, 1)
  assert.equal(a, b)
})

test('a failed download is tried again next time', async () => {
  clearBlobCache()
  const failing = async () => { throw new Error('offline') }
  await assert.rejects(cachedBlob('/img/2/', failing))
  const fetcher = counter()
  await cachedBlob('/img/2/', fetcher)
  assert.equal(fetcher.calls, 1)
})

test('clearing empties it, and it never grows past its limit', async () => {
  clearBlobCache()
  const fetcher = counter()
  await cachedBlob('/img/3/', fetcher)
  clearBlobCache()
  await cachedBlob('/img/3/', fetcher)
  assert.equal(fetcher.calls, 2)

  clearBlobCache()
  const first = counter()
  await cachedBlob('/img/first/', first)
  for (let i = 0; i < MAX_ENTRIES; i += 1) await cachedBlob(`/img/n${i}/`, counter())
  await cachedBlob('/img/first/', first)
  assert.equal(first.calls, 2, 'the oldest entry was dropped')
})
