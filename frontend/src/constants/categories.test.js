import test from 'node:test'
import assert from 'node:assert/strict'
import { CATEGORIES, findCategory, normalizeCategory } from './categories.js'

test('normalizeCategory trims and collapses spacing', () => {
  assert.equal(normalizeCategory('  Security   Services '), 'Security Services')
  assert.equal(normalizeCategory(null), '')
})

test('findCategory matches ignoring case and spacing', () => {
  assert.equal(findCategory(CATEGORIES, 'it  equipment'), 'IT Equipment')
  assert.equal(findCategory(CATEGORIES, 'Security Services'), null)
  assert.equal(findCategory(CATEGORIES, '   '), null)
})
