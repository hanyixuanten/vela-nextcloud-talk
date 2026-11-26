// Tests for the credential protocol shared with the AstroBox plugin.
// Run with: sh tests/run.sh

import assert from 'node:assert/strict'
import protocol from './.build/protocol.mjs'  // default export mirrors the .ux usage

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

const VALID = JSON.stringify({
  v: 1,
  kind: 'credentials',
  base_url: ' https://cloud.example.com/ ',
  user: ' alice ',
  app_password: ' app-pass '
})

console.log('protocol.js')

test('parses a valid message and normalises fields', () => {
  const result = protocol.parseCredentialMessage(VALID)
  assert.equal(result.ok, true)
  assert.equal(result.config.baseUrl, 'https://cloud.example.com')
  assert.equal(result.config.user, 'alice')
  assert.equal(result.config.appPassword, 'app-pass')
})

test('keeps a server path prefix', () => {
  const raw = JSON.stringify({
    v: 1,
    kind: 'credentials',
    base_url: 'https://example.com/nextcloud/',
    user: 'bob',
    app_password: 'x'
  })
  assert.equal(protocol.parseCredentialMessage(raw).config.baseUrl, 'https://example.com/nextcloud')
})

test('rejects an empty payload', () => {
  const result = protocol.parseCredentialMessage('')
  assert.equal(result.ok, false)
  assert.ok(result.error.length > 0)
})

test('stays silent for unrelated traffic', () => {
  // Interconnect is a shared channel: other apps' messages must not raise errors
  // the user would see.
  assert.equal(protocol.parseCredentialMessage('not json').silent, true)
  assert.equal(protocol.parseCredentialMessage('[]').silent, true)
  assert.equal(
    protocol.parseCredentialMessage(JSON.stringify({ kind: 'something-else' })).silent,
    true
  )
})

test('rejects a protocol version mismatch loudly', () => {
  const raw = JSON.stringify({
    v: 99,
    kind: 'credentials',
    base_url: 'https://a.b',
    user: 'u',
    app_password: 'p'
  })
  const result = protocol.parseCredentialMessage(raw)
  assert.equal(result.ok, false)
  assert.equal(result.silent, undefined)
  assert.match(result.error, /v99/)
})

test('rejects missing fields', () => {
  const raw = JSON.stringify({ v: 1, kind: 'credentials', base_url: 'https://a.b', user: 'u' })
  const result = protocol.parseCredentialMessage(raw)
  assert.equal(result.ok, false)
  assert.equal(result.silent, undefined)
})

test('rejects a bad scheme and plaintext HTTP', () => {
  for (const base_url of ['cloud.example.com', 'http://cloud.example.com']) {
    const raw = JSON.stringify({
      v: 1,
      kind: 'credentials',
      base_url,
      user: 'u',
      app_password: 'p'
    })
    assert.equal(protocol.parseCredentialMessage(raw).ok, false)
  }
})

test('ack always carries the three fields', () => {
  const ok = protocol.buildAck({ ok: true, message: '已保存', displayName: 'Alice' })
  assert.deepEqual(ok, { ok: true, message: '已保存', display_name: 'Alice' })

  // Missing optional fields must still produce a well-formed ack.
  const sparse = protocol.buildAck({ ok: false })
  assert.deepEqual(sparse, { ok: false, message: '', display_name: '' })
})

test('ack coerces ok to a boolean', () => {
  assert.equal(protocol.buildAck({ ok: 1 }).ok, true)
  assert.equal(protocol.buildAck({}).ok, false)
})

test('accepts a Vela object and echoes request_id on success and failure', () => {
  const message = { ...JSON.parse(VALID), request_id: 'cfg-2' }
  const success = protocol.parseCredentialMessage(message)
  const failure = protocol.parseCredentialMessage({ ...message, v: 99 })
  assert.equal(success.ok, true)
  assert.equal(failure.ok, false)
  assert.equal(protocol.buildAck(success).request_id, 'cfg-2')
  assert.equal(protocol.buildAck(failure).request_id, 'cfg-2')
})

test('a v1 message still means an account', () => {
  // An older plugin must not be locked out by the new watch build.
  const result = protocol.parseCredentialMessage(VALID)
  assert.equal(result.ok, true)
  assert.equal(result.config.mode, 'account')
  assert.equal(result.config.roomToken, '')
})

test('v2 parses a public conversation from a link', () => {
  const raw = JSON.stringify({
    v: 2,
    kind: 'credentials',
    mode: 'public',
    room_link: 'https://cloud.example.com/index.php/call/ABC123?password=pa%20ss',
    display_name: ' 小明 ',
    request_id: 'cfg-pub'
  })
  const result = protocol.parseCredentialMessage(raw)
  assert.equal(result.ok, true)
  assert.equal(result.requestId, 'cfg-pub')
  assert.equal(result.config.mode, 'public')
  assert.equal(result.config.baseUrl, 'https://cloud.example.com')
  assert.equal(result.config.roomToken, 'abc123')
  assert.equal(result.config.roomPassword, 'pa ss')
  assert.equal(result.config.roomDisplayName, '小明')
  assert.equal(result.config.user, '')
  assert.equal(result.config.appPassword, '')
})

test('v2 accepts an explicit token and password instead of a link', () => {
  const raw = JSON.stringify({
    v: 2,
    kind: 'credentials',
    mode: 'public',
    base_url: 'https://example.com/nextcloud/',
    room_token: ' PubPass ',
    room_password: 'secret',
    display_name: '小明'
  })
  const result = protocol.parseCredentialMessage(raw)
  assert.equal(result.ok, true)
  assert.equal(result.config.baseUrl, 'https://example.com/nextcloud')
  assert.equal(result.config.roomToken, 'pubpass')
  assert.equal(result.config.roomPassword, 'secret')
})

test('a typed password wins over the one inside the link', () => {
  const raw = JSON.stringify({
    v: 2,
    kind: 'credentials',
    mode: 'public',
    room_link: 'https://cloud.example.com/call/abc123?password=from-link',
    room_password: 'typed',
    display_name: '小明'
  })
  assert.equal(protocol.parseCredentialMessage(raw).config.roomPassword, 'typed')
})

test('a public message is rejected field by field', () => {
  const base = { v: 2, kind: 'credentials', mode: 'public', base_url: 'https://cloud.example.com' }
  // No token at all.
  assert.match(protocol.parseCredentialMessage(JSON.stringify(Object.assign({}, base, { display_name: '小明' }))).error, /令牌/)
  // Token too short.
  assert.match(protocol.parseCredentialMessage(JSON.stringify(Object.assign({}, base, { room_token: 'ab', display_name: '小明' }))).error, /令牌/)
  // No name: an unnamed guest cannot be told apart from everyone else.
  assert.match(protocol.parseCredentialMessage(JSON.stringify(Object.assign({}, base, { room_token: 'abc123' }))).error, /显示名称/)
  // Plain http, like the account path.
  assert.equal(protocol.parseCredentialMessage(JSON.stringify(Object.assign({}, base, {
    base_url: 'http://cloud.example.com', room_token: 'abc123', display_name: '小明'
  }))).ok, false)
})

test('an unparsable link is a link error, not a token error', () => {
  const raw = JSON.stringify({
    v: 2, kind: 'credentials', mode: 'public', room_link: 'cloud.example.com/call/abc123', display_name: '小明'
  })
  assert.match(protocol.parseCredentialMessage(raw).error, /链接/)
})

test('the ack shape did not change with v2', () => {
  // ui.rs on the plugin side deserialises exactly these three keys.
  const ack = protocol.buildAck({ ok: true, message: '已保存', displayName: '小明', requestId: 'r1' })
  assert.deepEqual(ack, { ok: true, message: '已保存', display_name: '小明', request_id: 'r1' })
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
