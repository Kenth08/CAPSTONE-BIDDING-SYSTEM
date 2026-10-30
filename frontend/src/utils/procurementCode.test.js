import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXAMPLE_CODE, isProcurementCode, normalizeProcurementCode } from './procurementCode.js'

test('normalize trims and upper-cases every format', () => {
  assert.equal(normalizeProcurementCode('  p-2026-004 '), 'P-2026-004')
  assert.equal(normalizeProcurementCode('prc-2026-7k4m-q9xt'), 'PRC-2026-7K4M-Q9XT')
  assert.equal(normalizeProcurementCode('pc-7k4m-q9xt-3hwd\n'), 'PC-7K4M-Q9XT-3HWD')
  assert.equal(normalizeProcurementCode(null), '')
})

test('all three issued formats are recognised', () => {
  for (const code of ['P-2026-004', 'prc-2026-7k4m-q9xt', 'PC-7K4M-Q9XT-3HWD', EXAMPLE_CODE]) {
    assert.ok(isProcurementCode(code), code)
  }
})

test('non-codes are rejected', () => {
  for (const code of ['', 'hello', 'PC-7K4M', '4', 'P-20-1', 'PC-7K4M-Q9XT-3HWD-EXTRA']) {
    assert.ok(!isProcurementCode(code), code)
  }
})
