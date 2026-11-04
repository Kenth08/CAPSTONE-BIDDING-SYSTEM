// Guards the security headers Vercel sends with the SPA (frontend/vercel.json).
// The CSP has to allow exactly what the app talks to; these tests fail if a
// header disappears or an unsafe source sneaks in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'))
const headers = Object.fromEntries(
  config.headers.find((h) => h.source === '/(.*)').headers.map((h) => [h.key, h.value]))
const csp = Object.fromEntries(headers['Content-Security-Policy'].split(';').map((d) => {
  const [name, ...values] = d.trim().split(/\s+/)
  return [name, values]
}))

test('every page gets the hardening headers', () => {
  assert.equal(headers['X-Frame-Options'], 'DENY')
  assert.equal(headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin')
  assert.match(headers['Strict-Transport-Security'], /max-age=31536000; includeSubDomains/)
  assert.match(headers['Permissions-Policy'], /camera=\(\)/)
})

test('scripts only come from our own origin', () => {
  assert.deepEqual(csp['script-src'], ["'self'"])
  assert.ok(!headers['Content-Security-Policy'].includes('unsafe-eval'))
  assert.deepEqual(csp['object-src'], ["'none'"])
  assert.deepEqual(csp['frame-ancestors'], ["'none'"])
})

test('the API and the default Sepolia RPC are reachable', () => {
  const contract = readFileSync(new URL('../blockchain/contract.js', import.meta.url), 'utf8')
  const defaultRpc = contract.match(/VITE_SEPOLIA_RPC_URL \|\| '([^']+)'/)[1]
  assert.ok(csp['connect-src'].includes(new URL(defaultRpc).origin), 'default RPC missing from connect-src')
  assert.ok(csp['connect-src'].some((src) => src.endsWith('.onrender.com')), 'API origin missing')
})

test('images allow data: (MFA QR code) and blob: (protected images)', () => {
  assert.ok(csp['img-src'].includes('data:'))
  assert.ok(csp['img-src'].includes('blob:'))
})
