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

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
