import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WrongNetworkError, assertChainId } from './network.js'

const SEPOLIA = 11155111

test('Sepolia passes, in the hex form eth_chainId returns or as a number', () => {
  assert.doesNotThrow(() => assertChainId('0xaa36a7', SEPOLIA))
  assert.doesNotThrow(() => assertChainId('0xAA36A7', SEPOLIA))
  assert.doesNotThrow(() => assertChainId(SEPOLIA, SEPOLIA))
})

test('any other network is refused', () => {
  for (const id of ['0x1', '0x4268', '0x7a69']) {   // mainnet, Holesky, a local node
    assert.throws(() => assertChainId(id, SEPOLIA), WrongNetworkError)
  }
})

test('a garbage answer is refused, not ignored', () => {
  for (const id of [undefined, null, '', 'sepolia', {}]) {
    assert.throws(() => assertChainId(id, SEPOLIA), WrongNetworkError)
  }
})
