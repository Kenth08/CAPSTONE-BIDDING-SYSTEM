import { test } from 'node:test'
import assert from 'node:assert/strict'
import { protectedFilePath } from './fileUrls.js'

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
