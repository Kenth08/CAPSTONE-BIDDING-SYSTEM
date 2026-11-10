import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliveryLabel, deliveryPresetsFor, warrantyLabel } from './bidTerms.js'

// Must match backend procurement/bid_terms.py: the label is what the bid's
// delivery_timeline / warranty_period text fields store.
test('labels match the backend wording', () => {
  assert.equal(deliveryLabel(1), '1 calendar day')
  assert.equal(deliveryLabel(30), '30 calendar days')
  assert.equal(warrantyLabel(6), '6 months')
  assert.equal(warrantyLabel(12), '1 year')
  assert.equal(warrantyLabel(24), '2 years')
  assert.equal(warrantyLabel(18), '18 months')
})

test('delivery presets never exceed the delivery period', () => {
  assert.deepEqual(deliveryPresetsFor(30), [7, 15, 30])
  assert.equal(deliveryPresetsFor('').length, 10)
})
