import { test } from 'node:test'
import assert from 'node:assert/strict'
import { protectedFilePath, shouldInterceptFileLink } from './fileUrls.js'

test('extracts the API path from absolute and relative file URLs', () => {
  assert.equal(protectedFilePath('https://api.example.com/api/files/bid/7/quotation_document/'),
    '/files/bid/7/quotation_document/')
  assert.equal(protectedFilePath('/api/files/supplier/3/valid_id/'), '/files/supplier/3/valid_id/')
})

test('drops any query string or fragment and normalises the trailing slash', () => {
  assert.equal(protectedFilePath('http://x/api/files/award/1/notice_of_award/?t=abc'),
    '/files/award/1/notice_of_award/')
  assert.equal(protectedFilePath('http://x/api/files/award/1/notice_of_award#x'),
    '/files/award/1/notice_of_award/')
})

test('anything that is not a protected file is ignored', () => {
  for (const url of [null, undefined, 42, '', 'blob:http://x/123', '/images/hero.webp',
    'https://sepolia.etherscan.io/tx/0xabc', 'https://api.example.com/api/public/procurement/PC-1/notice-of-award/']) {
    assert.equal(protectedFilePath(url), null, String(url))
  }
})

test('clicks on protected links are intercepted, but never the one-time link itself', () => {
  const addr = 'https://api.example.com/api/files/bid/7/quotation_document/'
  assert.equal(shouldInterceptFileLink(addr), true)
  // The generated download link is also an /api/files/ URL; intercepting it
  // looped forever requesting new links (caught by the end-to-end browser run).
  assert.equal(shouldInterceptFileLink(`${addr}?t=abc`, { oneTime: true }), false)
  assert.equal(shouldInterceptFileLink('https://sepolia.etherscan.io/tx/0x1'), false)
})
