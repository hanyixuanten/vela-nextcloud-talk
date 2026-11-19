// Integration tests for src/common/scripts/api.js against tests/mock-server.mjs.
//
// Run with: sh tests/run.sh
// Requires Node >= 18 (global fetch + node:http).

import assert from 'node:assert/strict'
import { start, seen } from './mock-server.mjs'
import api from './.build/api.mjs'

const server = await start()
const base = 'http://127.0.0.1:' + server.address().port

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (err) {
    failed += 1
    console.log('  FAIL ' + name)
    console.log('       ' + ((err && err.message) || err))
  }
}

console.log('api.js')

await test('getCurrentUser returns id and display name', async () => {
  api.configure({ baseUrl: base + '/', user: 'alice', appPassword: 'app-pass-word' })
  const user = await api.getCurrentUser()
  assert.equal(user.id, 'alice')
  assert.equal(user.displayName, 'Alice A.')
})

await test('validating a rejected candidate preserves the live account', async () => {
  await assert.rejects(api.getCurrentUser({ baseUrl: base, user: 'alice', appPassword: 'wrong' }))
  assert.equal((await api.getCurrentUser()).id, 'alice')
})

await test('listConversations sorts by lastActivity desc', async () => {
  const rooms = await api.listConversations()
  assert.equal(rooms.length, 2)
  assert.equal(rooms[0].token, 'tokA')
  assert.equal(rooms[1].token, 'tokB')
})

await test('requests carry OCS-APIRequest and Accept headers', async () => {
  const request = seen.find((entry) => entry.url.indexOf('/api/v4/room') >= 0)
  assert.equal(request.ocs, 'true')
  assert.equal(request.accept, 'application/json')
})

await test('Authorization is Basic base64(user:appPassword)', async () => {
  const request = seen.find((entry) => entry.url.indexOf('/api/v4/room') >= 0)
  const expected = 'Basic ' + Buffer.from('alice:app-pass-word', 'utf8').toString('base64')
  assert.equal(request.auth, expected)
})

await test('baseUrl trailing slash is stripped', async () => {
  const request = seen.find((entry) => entry.url.indexOf('/api/v4/room') >= 0)
  assert.equal(request.url, '/ocs/v2.php/apps/spreed/api/v4/room?includeStatus=0')
})

await test('getMessages follows the history cursor', async () => {
  const history = await api.getMessages('tokA', { limit: 1 })
  assert.equal(history.messages[0].id, 11)
  assert.equal(history.lastGiven, 11)
  const older = await api.getMessages('tokA', { lastKnownMessageId: history.lastGiven })
  assert.deepEqual(older.messages.map((row) => row.id), [10])
  assert.equal(older.lastGiven, 10)
  const request = new URL(seen.at(-1).url, base).searchParams
  assert.equal(request.get('lookIntoFuture'), '0')
  assert.equal(request.get('setReadMarker'), '0')
  assert.equal(request.get('markNotificationsAsRead'), '0')
  assert.equal(request.get('timeout'), null)
})

await test('forward polling waits zero seconds and handles 304', async () => {
  const poll = await api.getMessages('tokA', { lastKnownMessageId: 10, lookIntoFuture: 1 })
  assert.deepEqual(poll.messages.map((row) => row.id), [11])
  assert.equal(poll.lastGiven, 11)
  const request = new URL(seen.at(-1).url, base).searchParams
  assert.equal(request.get('lookIntoFuture'), '1')
  assert.equal(request.get('timeout'), '0')
  const empty = await api.getMessages('tokA', { lastKnownMessageId: 11, lookIntoFuture: 1 })
  assert.deepEqual(empty, { messages: [], lastGiven: 0, notModified: true })
})

await test('sendMessage omits undefined replyTo and accepts OCS 201 Created', async () => {
  const created = await api.sendMessage('tokA', '你好', undefined)
  assert.equal(created.id, 12)
  assert.equal(created.message, '你好')
  assert.equal(created.parent, undefined)

  const request = seen.at(-1)
  assert.equal(request.method, 'POST')
  assert.equal(request.body, JSON.stringify({ message: '你好' }))
})

await test('sendMessage posts a numeric replyTo and returns the embedded parent', async () => {
  const created = await api.sendMessage('tokA', '收到', 10)
  const request = seen.at(-1)
  assert.equal(request.method, 'POST')
  assert.equal(request.url, '/ocs/v2.php/apps/spreed/api/v1/chat/tokA')
  assert.deepEqual(JSON.parse(request.body), { message: '收到', replyTo: 10 })
  assert.equal(created.id, 13)
  assert.equal(created.message, '收到')
  assert.equal(created.parent.id, 10)
  assert.equal(created.parent.actorDisplayName, 'Ann')
  assert.equal(created.parent.message, 'first')
  assert.equal(created.parent.parent, undefined)

  const poll = await api.getMessages('tokA', { lastKnownMessageId: 12, lookIntoFuture: 1 })
  assert.deepEqual(poll.messages, [created])
})

await test('sendMessage surfaces an invalid reply target without retrying as a plain send', async () => {
  const before = seen.length
  await assert.rejects(api.sendMessage('tokA', 'orphan', 999), (err) => {
    assert.equal(err.status, 400)
    assert.equal(err.payload.ocs.data.error, 'reply-to')
    return true
  })
  assert.equal(seen.length, before + 1)
})

await test('markRead sends a POST with lastReadMessage', async () => {
  await api.markRead('tokA', 11)
  const request = seen.at(-1)
  assert.equal(request.method, 'POST')
  assert.ok(request.url.endsWith('/chat/tokA/read'))
  assert.equal(request.body, JSON.stringify({ lastReadMessage: 11 }))
})

await test('markRead without an id is a no-op', async () => {
  const before = seen.length
  await api.markRead('tokA', 0)
  assert.equal(seen.length, before)
})

await test('401 maps to a credential error', async () => {
  api.configure({ baseUrl: base, user: 'alice', appPassword: 'wrong' })
  await assert.rejects(
    () => api.getCurrentUser(),
    (err) => {
      assert.equal(err.status, 401)
      assert.equal(err.message, '账号或应用密码错误')
      return true
    }
  )
})

await test('404 prefers the server message', async () => {
  api.configure({ baseUrl: base, user: 'alice', appPassword: 'app-pass-word' })
  await assert.rejects(
    () => api.getMessages('notfound', {}),
    (err) => {
      assert.equal(err.status, 404)
      assert.equal(err.message, 'Conversation not found')
      return true
    }
  )
})

await test('unreachable host reports a network error', async () => {
  api.configure({ baseUrl: 'http://127.0.0.1:1', user: 'a', appPassword: 'b' })
  await assert.rejects(
    () => api.getCurrentUser(),
    (err) => {
      assert.equal(err.status, 0)
      assert.ok(err.message.indexOf('网络请求失败') === 0)
      return true
    }
  )
})

await test('missing baseUrl is rejected before any request', async () => {
  api.configure({ baseUrl: '', user: '', appPassword: '' })
  assert.equal(api.isConfigured(), false)
  await assert.rejects(
    () => api.getCurrentUser(),
    (err) => err.message === '尚未设置服务器地址'
  )
})

server.close()

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
