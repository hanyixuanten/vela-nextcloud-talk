// Startup network gate and its advisory probes.
//
// The verdict is the interface type, exactly like HyperBilibili's
// `NetworkCheck`. The probes (bilibili as control, `<baseUrl>/status.php` as the
// real target) are evidence only and must never delay or block the launch —
// that is what produced the "stuck on 没有网络" dead end.
//
// Run with: sh tests/run.sh
import assert from 'node:assert/strict'
import http from 'node:http'
import { reset, state } from './.build/network-double.mjs'
import {
  CONTROL_URL,
  checkNetwork,
  checkSignal,
  probeServer,
  probeServerDetailed,
  probeTargets,
  probeUrl
} from './.build/network.mjs'

const SENT = []
const server = http.createServer((req, res) => {
  SENT.push(req.url)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('{"installed":true}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

// A second server that refuses every request with 401: an auth error still
// proves the network works, so it must not be reported as a transport failure.
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

await test('the control probe defaults to bilibili, like the reference app', () => {
  assert.equal(CONTROL_URL, 'https://www.bilibili.com/')
})

await test('a "none" interface is offline and sends nothing', async () => {
  reset('none')
  assert.equal(await checkNetwork(), false)
  assert.deepEqual(SENT, [])
})

await test('an empty type is "unknown", not "offline"', async () => {
  // A firmware that answers "" (or fails, or never answers) is not evidence of
  // a dead network; blocking on it is what bricked the launch.
  reset('')
  const signal = await checkSignal()
  assert.equal(signal.online, true)
  assert.equal(signal.known, false)
  assert.deepEqual(SENT, [])
})

await test('a failed getType still lets the user in', async () => {
  reset('wifi')
  state.fail = true
  const signal = await checkSignal()
  state.fail = false
  assert.equal(signal.online, true)
  assert.equal(signal.known, false)
  assert.deepEqual(SENT, [])
})

await test('a getType that never calls back is cut off by the timeout', async () => {
  reset('wifi')
  state.hang = true
  const started = Date.now()
  const signal = await checkSignal({ typeTimeoutMs: 60 })
  state.hang = false
  assert.equal(signal.online, true, 'an unanswered API must not hang the launch')
  assert.equal(signal.known, false)
  assert.ok(Date.now() - started < 2000, 'the gate has to give up quickly')
})

await test('the verdict itself makes no request, so it cannot be slow', async () => {
  reset('wifi')
  const signal = await checkSignal()
  assert.equal(signal.online, true)
  assert.equal(signal.type, 'wifi')
  assert.equal(signal.known, true)
  assert.deepEqual(SENT, [], 'the gate must resolve without a round trip')
})

await test('probes cover bilibili first and the configured server second', async () => {
  reset('wifi')
  const result = await probeTargets({ baseUrl: base + '/' }, { controlUrl: base })
  assert.equal(result.control.ok, true)
  assert.equal(result.server.ok, true)
  assert.equal(result.server.status, 200)
  assert.ok(result.control.ms >= 0 && result.server.ms >= 0)
  assert.deepEqual(SENT.sort(), ['/', '/status.php'])
})

await test('no account yet: the control probe still runs, the server one does not', async () => {
  reset('wifi')
  const result = await probeTargets({}, { controlUrl: base })
  assert.equal(result.control.ok, true)
  assert.equal(result.server, null)
  assert.deepEqual(SENT, ['/'])
})

await test('a 401 counts as reached, not as a transport failure', async () => {
  reset('wifi')
  const probe = await probeServerDetailed(deniedBase)
  assert.equal(probe.ok, true)
  assert.equal(probe.status, 401)
  assert.equal(await probeServer(deniedBase), true)
})

await test('bilibili ok + server unreachable is the diagnosis, not "offline"', async () => {
  reset('wifi')
  assert.equal(await checkNetwork(), true, 'an unreachable host must not block the launch')
  const result = await probeTargets({ baseUrl: 'https://127.0.0.1:1' }, { controlUrl: base })
  assert.equal(result.control.ok, true, 'the watch does reach the internet')
  assert.equal(result.server.ok, false)
  assert.notEqual(String(result.server.code), '', 'the transport code is what explains it')
})

await test('a hanging probe is cut off and reported as a timeout', async () => {
  reset('wifi')
  const started = Date.now()
  const probe = await probeUrl(base + '/hang', 60)
  assert.equal(probe.ok, false)
  assert.equal(probe.timedOut, true)
  assert.equal(probe.code, 'TIMEOUT')
  assert.ok(Date.now() - started < 2000, 'the probe must not wait for the platform')
})

server.close()
denied.close()
console.log('network gate checks passed')
