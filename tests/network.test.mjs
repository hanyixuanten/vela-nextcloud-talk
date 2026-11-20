// Startup network gate: interface type first, then a fetch probe at the
// configured server. Run through tests/run.sh (module specifiers rewritten).
import assert from 'node:assert/strict'
import http from 'node:http'
import { reset, state } from './.build/network-double.mjs'
import { checkNetwork, probeServer } from './.build/network.mjs'

const SENT = []
const server = http.createServer((req, res) => {
  SENT.push(req.url)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('{"installed":true}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

// A second server that refuses every request with 401: an auth error still
// proves the network works, so the gate must not treat it as offline.
const denied = http.createServer((req, res) => {
  res.writeHead(401)
  res.end('unauthorized')
})
await new Promise((resolve) => denied.listen(0, '127.0.0.1', resolve))
const deniedBase = 'http://127.0.0.1:' + denied.address().port

const test = async (name, fn) => {
  try {
    await fn()
    console.log('  ok   ' + name)
  } catch (err) {
    console.log('  FAIL ' + name)
    throw err
  } finally {
    SENT.length = 0
  }
}

await test('a "none" interface is offline and never probes the server', async () => {
  reset('none')
  assert.equal(await checkNetwork({ baseUrl: base }), false)
  assert.deepEqual(SENT, [])
})

await test('an unknown interface type counts as offline', async () => {
  reset('')
  assert.equal(await checkNetwork({ baseUrl: base }), false)
  assert.deepEqual(SENT, [])
})

await test('a failed getType counts as offline', async () => {
  reset('wifi')
  state.fail = true
  assert.equal(await checkNetwork({ baseUrl: base }), false)
  state.fail = false
  assert.deepEqual(SENT, [])
})

await test('without a server address the type check is enough', async () => {
  reset('wifi')
  assert.equal(await checkNetwork({}), true)
  assert.deepEqual(SENT, [], 'no request is made before an account exists')
})

await test('the probe hits /status.php and any answer means online', async () => {
  reset('wifi')
  assert.equal(await checkNetwork({ baseUrl: base + '/' }), true)
  assert.deepEqual(SENT, ['/status.php'])
})

await test('a 401 still proves the network is up', async () => {
  reset('wifi')
  assert.equal(await probeServer(deniedBase), true)
})

await test('an unreachable server is offline, even with a live interface', async () => {
  reset('wifi')
  assert.equal(await checkNetwork({ baseUrl: 'https://127.0.0.1:1' }), false)
})

await test('a hanging request is cut off by the probe timeout', async () => {
  reset('wifi')
  const started = Date.now()
  const value = await probeServer(base + '/hang', 60)
  assert.equal(value, false)
  assert.ok(Date.now() - started < 2000, 'the probe must not wait for the platform')
})

server.close()
denied.close()
console.log('network gate checks passed')
