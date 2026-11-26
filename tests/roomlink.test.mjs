// Room link parsing (src/common/scripts/roomlink.js).
//
// A public conversation is shared as a URL, so the login form has to accept the
// URL people actually paste and split it into the server root and the token.
// The links below are the shapes Talk and its deployments produce.
//
// Run with: sh tests/run.sh
import assert from 'node:assert/strict'
import roomlink, { TOKEN_PATTERN, parseRoomLink, buildRoomLink, normaliseBaseUrl } from './.build/roomlink.mjs'

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

const ok = (input, fallback) => {
  const result = parseRoomLink(input, fallback)
  assert.equal(result.ok, true, 'expected a parsed link, got ' + JSON.stringify(result))
  return result
}

const bad = (input, fallback, error) => {
  const result = parseRoomLink(input, fallback)
  assert.equal(result.ok, false, 'expected a rejection, got ' + JSON.stringify(result))
  assert.equal(result.error, error)
}

console.log('roomlink.js')

test('the share link Talk hands out', () => {
  const result = ok('https://cloud.example.com/call/abc123')
  assert.equal(result.baseUrl, 'https://cloud.example.com')
  assert.equal(result.token, 'abc123')
  assert.equal(result.password, '')
})

test('/index.php in front of the conversation', () => {
  const result = ok('https://cloud.example.com/index.php/call/abc123')
  assert.equal(result.baseUrl, 'https://cloud.example.com')
})

test('the /apps/spreed form', () => {
  const result = ok('https://cloud.example.com/apps/spreed/call/abc123')
  assert.equal(result.baseUrl, 'https://cloud.example.com')
})

test('a deployment under a path prefix keeps the prefix', () => {
  const result = ok('https://example.com/nextcloud/index.php/call/abc123')
  assert.equal(result.baseUrl, 'https://example.com/nextcloud')
  assert.equal(result.token, 'abc123')
})

test('the token is lower-cased, because Talk tokens are', () => {
  const result = ok('https://cloud.example.com/call/ABC123')
  assert.equal(result.token, 'abc123')
  assert.equal(TOKEN_PATTERN.test(result.token), true)
})

test('?password= comes along and is decoded', () => {
  const result = ok('https://cloud.example.com/call/abc123?password=pa%20ss%26word')
  assert.equal(result.password, 'pa ss&word')
})

test('other query parameters leave the password empty', () => {
  const result = ok('https://cloud.example.com/call/abc123?foo=bar')
  assert.equal(result.password, '')
})

test('a trailing slash after the token is tolerated', () => {
  const result = ok('https://cloud.example.com/call/abc123/')
  assert.equal(result.baseUrl, 'https://cloud.example.com')
  assert.equal(result.token, 'abc123')
})

test('a bare token uses the server that is already known', () => {
  const result = ok('abc123', 'https://cloud.example.com/')
  assert.equal(result.baseUrl, 'https://cloud.example.com')
  assert.equal(result.token, 'abc123')
})

test('a bare token without a server is its own error', () => {
  // The form has to say "enter the server" rather than "invalid link".
  bad('abc123', '', 'base')
})

test('a link without a scheme says so', () => {
  bad('cloud.example.com/call/abc123', '', 'scheme')
})

test('http is refused: Talk links are https', () => {
  bad('http://cloud.example.com/call/abc123', '', 'scheme')
})

test('a 404 page pasted by mistake is not a token', () => {
  bad('https://cloud.example.com/call/', '', 'token')
  bad('https://cloud.example.com/', '', 'token')
})

test('a token that is too short or not alphanumeric is refused', () => {
  bad('https://cloud.example.com/call/abc', '', 'token')
  bad('https://cloud.example.com/call/abc-123', '', 'token')
  bad('https://cloud.example.com/call/' + 'a'.repeat(31), '', 'token')
})

test('a host with credentials or spaces is refused', () => {
  bad('https://user:pw@cloud.example.com/call/abc123', '', 'host')
  bad('https://cloud example.com/call/abc123', '', 'host')
})

test('empty input is not an error the user has to read', () => {
  bad('', 'https://cloud.example.com', 'empty')
  bad('   ', 'https://cloud.example.com', 'empty')
})

test('buildRoomLink is the inverse for display', () => {
  assert.equal(buildRoomLink('https://cloud.example.com/', 'abc123'), 'https://cloud.example.com/call/abc123')
  assert.equal(buildRoomLink('https://example.com/nextcloud', 'abc123'), 'https://example.com/nextcloud/call/abc123')
  assert.equal(buildRoomLink('', 'abc123'), '')
  assert.equal(buildRoomLink('https://cloud.example.com', ''), '')
})

test('normaliseBaseUrl drops trailing slashes only', () => {
  assert.equal(normaliseBaseUrl(' https://cloud.example.com// '), 'https://cloud.example.com')
  assert.equal(normaliseBaseUrl('https://example.com/nextcloud/'), 'https://example.com/nextcloud')
  assert.equal(normaliseBaseUrl(undefined), '')
})

test('the round trip keeps the prefix', () => {
  const parsed = ok(buildRoomLink('https://example.com/nextcloud', 'abc123'))
  assert.equal(parsed.baseUrl, 'https://example.com/nextcloud')
  assert.equal(parsed.token, 'abc123')
})

test('the default export mirrors the named ones', () => {
  assert.equal(roomlink.parseRoomLink, parseRoomLink)
  assert.equal(roomlink.buildRoomLink, buildRoomLink)
  assert.equal(roomlink.normaliseBaseUrl, normaliseBaseUrl)
  assert.equal(roomlink.TOKEN_PATTERN, TOKEN_PATTERN)
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
