import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SIGNING_DISABLED_MESSAGE, isSigningOffFlag, signingBlockedReason, walletNetworkProblem,
} from './signingPolicy.js'

const SEPOLIA = 11155111

test('VITE_BLOCKCHAIN_SIGNING: only explicit "off" values disable signing; unset keeps it on', () => {
  for (const v of ['off', 'OFF', ' false ', '0', 'no', 'disabled']) assert.equal(isSigningOffFlag(v), true, v)
  for (const v of [undefined, null, '', 'on', 'true', '1']) assert.equal(isSigningOffFlag(v), false, String(v))
})

test('a read-only build blocks every anchor, whatever the backend says', () => {
  for (const anchor of [null, {}, { signing_enabled: true }, { signing_enabled: false }]) {
    assert.equal(signingBlockedReason(anchor, { buildSigningOff: true }), SIGNING_DISABLED_MESSAGE)
  }
})

test('the backend turning signing off blocks the anchor', () => {
  assert.equal(signingBlockedReason({ id: 3, signing_enabled: false }), SIGNING_DISABLED_MESSAGE)
})

test('production default is unchanged: enabled, or a field missing from an older backend, is allowed', () => {
  assert.equal(signingBlockedReason({ id: 3, signing_enabled: true }), '')
  assert.equal(signingBlockedReason({ id: 3 }), '')
})

test('the disabled message tells the user nothing was sent and why', () => {
  assert.match(SIGNING_DISABLED_MESSAGE, /disabled/i)
  assert.match(SIGNING_DISABLED_MESSAGE, /read-only/i)
  assert.match(SIGNING_DISABLED_MESSAGE, /No wallet was contacted/)
})

test('wallet on Sepolia: no network problem', () => {
  assert.equal(walletNetworkProblem('0xaa36a7', SEPOLIA), '')
  assert.equal(walletNetworkProblem('0xAA36A7', SEPOLIA), '')
})

test('wallet on another network: reported with its chain id, and the user is told to switch themselves', () => {
  const msg = walletNetworkProblem('0x4cef52', SEPOLIA)   // 5042002, e.g. a non-Sepolia testnet
  assert.match(msg, /chain ID 5042002/)
  assert.match(msg, /not Sepolia \(chain ID 11155111\)/)
  assert.match(msg, /Nothing was sent/)
  assert.match(msg, /Switch MetaMask to Sepolia yourself/)
  assert.notEqual(walletNetworkProblem('0x1', SEPOLIA), '')   // mainnet
})

test('a garbage chain id is a problem, not a pass', () => {
  for (const id of [undefined, null, '', 'sepolia']) assert.notEqual(walletNetworkProblem(id, SEPOLIA), '')
})

test('the app never asks the wallet to switch or add a network (anchor.js only reads eth_chainId)', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('./anchor.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /method:\s*['"]wallet_switchEthereumChain['"]/)
  assert.doesNotMatch(src, /method:\s*['"]wallet_addEthereumChain['"]/)
})
