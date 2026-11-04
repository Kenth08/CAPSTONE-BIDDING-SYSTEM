import { test } from 'node:test'
import assert from 'node:assert/strict'
import { documentVerdict, findDocumentMatch } from './documentCheck.js'

const DOC = '0x' + 'ab'.repeat(32)
const row = (state, extra = {}) => ({ label: 'Notice of Award issued', documentHash: DOC, state, ...extra })

test('no file hash or no rows: nothing matches', () => {
  assert.equal(findDocumentMatch('', [row('verified')]), null)
  assert.equal(findDocumentMatch(DOC, []), null)
  assert.equal(findDocumentMatch(DOC, undefined), null)
})

test('matching is case-insensitive and ignores rows without a document hash', () => {
  const rows = [{ label: 'x', documentHash: '', state: 'verified' }, row('verified')]
  assert.equal(findDocumentMatch(DOC.toUpperCase(), rows), rows[1])
})

test('a different file is reported as no match, with the image re-encoding hint', () => {
  const v = documentVerdict('0x' + 'cd'.repeat(32), [row('verified')])
  assert.equal(v.tone, 'bad')
  assert.match(v.title, /No match/)
  assert.match(v.detail, /downloaded from this system/)
})

test('a verified step never claims the file itself is proven on-chain', () => {
  const v = documentVerdict(DOC, [row('verified')])
  assert.equal(v.tone, 'legacy')
  assert.match(v.title, /this system recorded/)
  assert.match(v.detail, /not this file’s hash directly/)
  assert.match(v.detail, /reported by this system’s database/)
  for (const s of [v.title, v.detail]) assert.doesNotMatch(s, /provabl|proven|attested/i)
})

test('no match in this box is green: it compares a hash the server reported', () => {
  const tones = Object.fromEntries(
    ['verified', 'server', 'reported', 'pending', 'unmatched', 'altered', 'weird']
      .map((s) => [s, documentVerdict(DOC, [row(s)]).tone]),
  )
  assert.deepEqual(tones, {
    verified: 'legacy', server: 'pending', reported: 'pending', pending: 'pending',
    unmatched: 'bad', altered: 'bad', weird: 'pending',
  })
})

test('altered and not-found steps are not described as "not yet anchored"', () => {
  for (const s of ['altered', 'unmatched']) {
    const v = documentVerdict(DOC, [row(s)])
    assert.doesNotMatch(v.detail, /not yet/)
    assert.match(v.detail, /unverified/)
  }
})

test('a superseded version is named as an earlier version', () => {
  const v = documentVerdict(DOC, [row('verified', { superseded: true })])
  assert.match(v.title, /earlier version/)
})
