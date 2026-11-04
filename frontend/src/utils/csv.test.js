import { test } from 'node:test'
import assert from 'node:assert/strict'
import { csvCell } from './csv.js'

test('formula-looking cells are neutralised', () => {
  assert.equal(csvCell('=1+1'), "'=1+1")
  assert.equal(csvCell('+63 912'), "'+63 912")
  assert.equal(csvCell('-cmd'), "'-cmd")
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)")
  assert.equal(csvCell('\t=1'), "'\t=1")
  assert.equal(csvCell('=HYPERLINK("http://evil/","x")'), `"'=HYPERLINK(""http://evil/"",""x"")"`)
})

test('ordinary values are unchanged or just quoted', () => {
  assert.equal(csvCell('Acme Trading Corp.'), 'Acme Trading Corp.')
  assert.equal(csvCell('₱1,000.00'), '"₱1,000.00"')
  assert.equal(csvCell(42), '42')
  assert.equal(csvCell(null), '')
  assert.equal(csvCell('PC-7K4M-Q9XT-3HWD'), 'PC-7K4M-Q9XT-3HWD')
})
