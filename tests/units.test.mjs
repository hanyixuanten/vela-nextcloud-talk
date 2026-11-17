// Unit tests for the two pure helper modules.
//
// Run with: sh tests/run.sh

import assert from 'node:assert/strict'
import base64Encode from './.build/base64.mjs'
import fmt from './.build/format.mjs'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (err) {
    failed += 1
    console.log('  FAIL ' + name)
    console.log('       ' + ((err && err.message) || err))
  }
}

console.log('base64.js')

// Reference implementation: Buffer encodes UTF-8 then base64, exactly what
// Vela's btoa cannot do (btoa is Latin-1 only).
const SAMPLES = ['', 'a', 'ab', 'abc', 'alice:secret', '用户:密码', 'emoji😀:p', '😀😀😀', 'x'.repeat(100)]

SAMPLES.forEach((sample) => {
  test('matches Buffer for ' + JSON.stringify(sample).slice(0, 24), () => {
    assert.equal(base64Encode(sample), Buffer.from(sample, 'utf8').toString('base64'))
  })
})

test('null/undefined are treated as empty', () => {
  assert.equal(base64Encode(null), '')
  assert.equal(base64Encode(undefined), '')
})

console.log('\nformat.js')

test('renderMessage substitutes Rich Object placeholders', () => {
  const text = fmt.renderMessage({
    message: '你好 {user1} 看下 {file2}',
    messageParameters: { user1: { name: 'Alice' }, file2: { name: 'a.pdf' } }
  })
  assert.equal(text, '你好 Alice 看下 a.pdf')
})

test('renderMessage keeps unknown placeholders untouched', () => {
  assert.equal(fmt.renderMessage({ message: 'hi {ghost}' }), 'hi {ghost}')
})

test('renderMessage handles deleted messages', () => {
  assert.equal(fmt.renderMessage({ messageType: 'comment_deleted' }), '消息已删除')
})

test('renderMessage tolerates missing message', () => {
  assert.equal(fmt.renderMessage(null), '')
  assert.equal(fmt.renderMessage({}), '')
})

test('preview collapses newlines', () => {
  assert.equal(fmt.preview({ message: 'a\n\nb   c' }), 'a b c')
})

test('previewWithAuthor prefixes the author with a full-width colon', () => {
  assert.equal(
    fmt.previewWithAuthor({ actorDisplayName: 'Bob', message: 'hello' }),
    'Bob：hello'
  )
})

test('previewWithAuthor omits author for system messages', () => {
  assert.equal(
    fmt.previewWithAuthor({ actorDisplayName: 'Bob', message: 'Bob joined', systemMessage: 'user_added' }),
    'Bob joined'
  )
})

test('formatTime renders HH:MM for today', () => {
  const now = Math.floor(Date.now() / 1000)
  assert.match(fmt.formatTime(now), /^\d{2}:\d{2}$/)
})

test('formatTime renders 昨天 for yesterday', () => {
  const now = Math.floor(Date.now() / 1000)
  assert.equal(fmt.formatTime(now - 86400), '昨天')
})

test('formatTime renders year for old timestamps', () => {
  assert.equal(fmt.formatTime(1600000000), '2020/9/13')
})

test('formatTime returns empty for missing timestamp', () => {
  assert.equal(fmt.formatTime(0), '')
  assert.equal(fmt.formatTime(undefined), '')
})

test('initials falls back to #', () => {
  assert.equal(fmt.initials('alice'), 'A')
  assert.equal(fmt.initials('   '), '#')
  assert.equal(fmt.initials(null), '#')
})

test('colorFor is stable and always from the palette', () => {
  const color = fmt.colorFor('tokA')
  assert.equal(color, fmt.colorFor('tokA'))
  assert.match(color, /^#[0-9a-f]{6}$/)
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
