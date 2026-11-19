import assert from 'node:assert/strict'
import { BASELINE_COUNT, seedChat } from '../scripts/seed-watch-chat.mjs'

const opts = {
  baseUrl: 'https://example.test/cloud/', token: 'test_room',
  user: 'fixture', password: 'fake-password', run: 'trial-1'
}
const bodies = []
await seedChat({ ...opts, send: async (url, options) => {
  assert.equal(url, 'https://example.test/cloud/ocs/v2.php/apps/spreed/api/v1/chat/test_room')
  assert.equal(options.method, 'POST')
  assert.equal(options.redirect, 'error')
  assert.equal(options.headers['OCS-APIRequest'], 'true')
  assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('fixture:fake-password').toString('base64'))
  bodies.push(JSON.parse(options.body).message)
  return new Response(null, { status: 201 })
} })
assert.equal(bodies.length, BASELINE_COUNT)
for (const [i, msg] of bodies.entries()) {
  assert.ok(msg.startsWith(`[watch-baseline trial-1 ${String(i + 1).padStart(3, '0')}/${BASELINE_COUNT}]`))
  assert.equal(msg.length > 512, (i + 1) % 6 === 0)
  assert.ok(msg.length < 4000)
}

let requests = 0
await assert.rejects(seedChat({ ...opts, count: 3, send: async () => {
  requests++
  return new Response(null, { status: requests === 1 ? 201 : 429 })
} }), /Message 2\/3: HTTP 429/)
assert.equal(requests, 2)
await assert.rejects(seedChat({ ...opts, send: async () => {
  throw new Error('private-response-data')
} }), { message: 'Message 1/72: request failed, timed out, or was redirected. Stop and inspect the room before retrying.' })
for (const overrides of [{ baseUrl: 'http://example.test' }, { baseUrl: 'https://a:b@example.test' }, { token: '../room' }, { count: 73 }]) {
  await assert.rejects(seedChat({ ...opts, ...overrides, send: async () => { requests++ } }))
}
assert.equal(requests, 2)
console.log('  ok   watch baseline seed uses bounded, numbered synthetic messages and stops on errors')
