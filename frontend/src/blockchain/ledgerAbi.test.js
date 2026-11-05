// The contract's ABI exists in three places: contracts/ (the source), the backend
// (Heroku deploys backend/ alone, so it needs its own copy) and contract.js. If
// they drift, one side encodes or decodes the ledger differently from the other.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const source = JSON.parse(read('../../../contracts/ProcurementLedger.abi.json'))
const backend = JSON.parse(read('../../../backend/procurement/ProcurementLedger.abi.json'))

// contract.js reads import.meta.env at load time, so it can't be imported under
// node --test. Its ABI is the last statement in the file: a plain array literal.
const MARKER = 'export const LEDGER_ABI = '
const contractJs = read('./contract.js')
const frontend = new Function(`return ${contractJs.slice(contractJs.indexOf(MARKER) + MARKER.length)}`)()

test('the ABI source has the functions the app calls', () => {
  const names = source.map((entry) => entry.name)
  for (const name of ['recordEvent', 'getAnchor', 'getAnchorsByRef', 'AnchorRecorded']) {
    assert.ok(names.includes(name), `${name} is missing`)
  }
})

test('the backend and frontend ABI copies are identical', () => {
  assert.deepStrictEqual(backend, frontend)
})

test('both copies match contracts/ProcurementLedger.abi.json', () => {
  assert.deepStrictEqual(backend, source)
  assert.deepStrictEqual(frontend, source)
})
