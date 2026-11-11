// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeLocation, formatPesoInput } from './inputFormat.js'

test('peso input groups thousands and keeps two decimals', () => {
  assert.equal(formatPesoInput('1250000'), '1,250,000')
  assert.equal(formatPesoInput('₱1,250,000.505'), '1,250,000.50')
  assert.equal(formatPesoInput('abc'), '')
  assert.equal(formatPesoInput('0007'), '7')
  assert.equal(formatPesoInput('.5'), '0.5')
  assert.equal(formatPesoInput('12.3.4'), '12.34')
})

test('formatted pesos read back as the same number', () => {
  const parse = (s) => Number(String(s).replace(/[^\d.]/g, '')) || 0   // as store/projectsStore.js parseBudget
  assert.equal(parse(formatPesoInput('98765432.1')), 98765432.1)
})

test('location text joins the picked parts and prefixes the barangay once', () => {
  assert.equal(composeLocation({ place: ' Supply Office ', barangay: 'Apokon', city: 'City of Tagum', province: 'Davao Del Norte' }),
    'Supply Office, Brgy. Apokon, City of Tagum, Davao Del Norte')
  assert.equal(composeLocation({ barangay: 'Barangay 1', city: 'City of Manila' }), 'Barangay 1, City of Manila')
  assert.equal(composeLocation({ city: 'Quezon City' }), 'Quezon City')
})
