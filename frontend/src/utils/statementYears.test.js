import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statementYearOptions } from './statementYears.js'

test('offers the last two completed years, newest first', () => {
  assert.deepEqual(statementYearOptions(new Date(2026, 10, 10)), [2025, 2024])
})

test('moves forward on the first day of a new year', () => {
  assert.deepEqual(statementYearOptions(new Date(2027, 0, 1)), [2026, 2025])
  assert.deepEqual(statementYearOptions(new Date(2026, 11, 31)), [2025, 2024])
})
