// Guest (public conversation) support in api.js.
//
// The mode has one property an account does not: nothing identifies the guest
// except the Nextcloud session cookie, so these tests are about the cookie and
// about what happens when the server forgets the session.
//
// Run with: sh tests/run.sh
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { start, seen, reset, forgetSessions, rejectChat } from './public-server.mjs'
import api from './.build/api.mjs'
import { behaviour } from './.build/storage-double.mjs'

const server = await start()
const port = server.address().port
const base = 'https://127.0.0.1:' + port

// A real (in-memory) @system.storage, so the guest session record that api.js
// writes can be inspected the way the next page bundle would read it.
const disk = new Map()
behaviour.get = (options) => options.success(disk.get(options.key) || '')
behaviour.set = (options) => {
  disk.set(options.key, options.value)
  options.success()
}
behaviour.clear = (options) => {
  disk.clear()
  options.success()
}

api.setTranslator((key) => ({
  'public.errPassword': '聊天室密码不正确',
  'public.errNotFound': '聊天室不存在，或未开放访客访问',
  'public.sessionLost': '访客会话已失效，请重试',
  'public.errNoRoom': '尚未设置聊天室',
  'public.noList': '公开聊天室没有会话列表',
  'index.fetchError': '网络请求失败',
  'chat.timeoutError': '网络请求超时'
}[key] || key))

let passed = 0
let failed = 0

async function test(name, fn) {
  reset()
  disk.clear()
  // Point the module at the other mode first: configure() drops the live guest
  // session whenever the target changes, which is what isolates the tests.
  api.configure({ mode: 'account', baseUrl: base, user: 'alice', appPassword: 'app-pass-word' })
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

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await setImmediate()
}

const configurePublic = (overrides) => api.configure(Object.assign({
  mode: 'public',
  baseUrl: base,
  roomToken: 'pubaaa',
  roomPassword: '',
  roomDisplayName: '小明'
}, overrides || {}))

const joined = () => seen.filter((entry) => entry.url.indexOf('/participants/active') >= 0)
const chats = () => seen.filter((entry) => entry.url.indexOf('/api/v1/chat/') >= 0)
const stored = () => {
  const raw = disk.get('nctalk.settings')
  return raw ? JSON.parse(raw) : {}
}

console.log('api.js — public conversations')

await test('configures and joins as a guest without an Authorization header', async () => {
  configurePublic()
  assert.equal(api.isConfigured(), true)
  assert.equal(api.getMode(), 'public')

  const room = await api.joinPublicRoom()
  assert.equal(room.token, 'pubaaa')
  assert.equal(room.name, '公开群')
  assert.match(room.actorId, /^[0-9a-f]{40}$/)

  const join = joined()[0]
  assert.equal(join.method, 'POST')
  assert.equal(join.url, '/ocs/v2.php/apps/spreed/api/v4/room/pubaaa/participants/active')
  assert.equal(join.auth, undefined, 'a guest must not send Basic auth')
  assert.equal(join.cookie, '', 'the first join has no session yet')
  assert.deepEqual(JSON.parse(join.body), { force: true })

  // The display name is set separately: a join does not carry one.
  const rename = seen.find((entry) => entry.url.indexOf('/api/v1/guest/pubaaa/name') >= 0)
  assert.ok(rename, 'the guest name is sent after joining')
  assert.deepEqual(JSON.parse(rename.body), { displayName: '小明' })
  assert.match(rename.cookie, /nc_session_id=/)
})

await test('the session cookie is replayed on later requests', async () => {
  configurePublic()
  const room = await api.joinPublicRoom()
  // The join itself has no cookie; the guest-name call right after it already
  // carries the one the join response set.
  const rename = seen.find((entry) => entry.cookie)
  const cookie = /nc_session_id=([0-9a-f]+)/.exec(rename.cookie)[1]

  seen.length = 0
  const history = await api.getMessages('pubaaa', { limit: 12 })
  assert.deepEqual(history.messages, [])
  const request = chats()[0]
  assert.match(request.cookie, new RegExp('nc_session_id=' + cookie))
  assert.equal(request.auth, undefined)
  assert.equal(room.actorId, api.getSession().actorId)
})

await test('the guest session record is persisted without losing the other settings', async () => {
  // The page saves the room before joining (see pages/login, pages/setup);
  // api.js adds the session record on top of whatever is already stored.
  disk.set('nctalk.settings', JSON.stringify({
    mode: 'public',
    baseUrl: base,
    roomToken: 'pubaaa',
    roomDisplayName: '小明',
    keyboardType: 'T9'
  }))
  configurePublic()
  const room = await api.joinPublicRoom()
  await flush()
  const settings = stored()
  assert.equal(settings.roomName, '公开群')
  assert.equal(settings.roomActorId, room.actorId)
  assert.match(settings.sessionCookies, /nc_session_id=/)
  assert.equal(settings.roomDisplayName, '小明', 'the room identity survives')
  assert.equal(settings.keyboardType, 'T9', 'the rest of the settings survives the write')
})

await test('rejoining reuses the stored cookie, so the guest identity is stable', async () => {
  configurePublic()
  const first = await api.joinPublicRoom()
  const second = await api.joinPublicRoom()
  assert.equal(second.actorId, first.actorId, 'the same guest, not a new one')
  const joins = joined()
  assert.equal(joins.length, 2)
  assert.match(joins[1].cookie, /nc_session_id=/)
})

await test('sent messages carry the guest name and the session actor id', async () => {
  configurePublic()
  const room = await api.joinPublicRoom()
  seen.length = 0
  const created = await api.sendMessage('pubaaa', '你好')
  assert.equal(created.message, '你好')
  assert.equal(created.actorId, room.actorId)
  assert.equal(created.actorDisplayName, '小明')
  const request = seen.find((entry) => entry.method === 'POST')
  const body = JSON.parse(request.body)
  assert.equal(body.message, '你好')
  assert.equal(body.actorDisplayName, '小明')
})

await test('a wrong room password is reported as such', async () => {
  configurePublic({ roomToken: 'pubpass', roomPassword: 'nope' })
  await assert.rejects(api.joinPublicRoom(), (err) => {
    assert.equal(err.status, 403)
    assert.equal(err.message, '聊天室密码不正确')
    return true
  })
})

await test('a room without a password joins with no password field', async () => {
  configurePublic({ roomToken: 'pubpass', roomPassword: 'room-pass' })
  const room = await api.joinPublicRoom()
  assert.equal(room.name, '加密群')
  const join = joined()[0]
  assert.deepEqual(JSON.parse(join.body), { force: true, password: 'room-pass' })
})

await test('an unknown token explains that guests are not allowed there', async () => {
  configurePublic({ roomToken: 'nosuch' })
  await assert.rejects(api.joinPublicRoom(), (err) => {
    assert.equal(err.status, 404)
    assert.equal(err.message, '聊天室不存在，或未开放访客访问')
    return true
  })
})

await test('a lost session is recovered by joining once and replaying the request', async () => {
  configurePublic()
  await api.joinPublicRoom()
  forgetSessions()
  seen.length = 0

  const history = await api.getMessages('pubaaa', { limit: 12 })
  assert.deepEqual(history.messages, [])
  const urls = seen.map((entry) => entry.url)
  assert.equal(urls.filter((url) => url.indexOf('/participants/active') >= 0).length, 1, 'one rejoin')
  assert.equal(urls.filter((url) => url.indexOf('/api/v1/chat/') >= 0).length, 2, 'the read is retried once')
})

await test('a server that rejects every session does not produce a join loop', async () => {
  rejectChat()
  configurePublic()
  await assert.rejects(api.getMessages('pubaaa', {}), (err) => {
    assert.equal(err.code, 'SESSION')
    assert.equal(err.message, '访客会话已失效，请重试')
    return true
  })
  const joins = joined().length
  // The first read joins (ensureSession) and then makes one recovery attempt.
  // Both fail; the second attempt is what arms the cooldown.
  assert.equal(joins, 2, 'one join, then at most one recovery')

  // The second read must not join again inside the cooldown window.
  await assert.rejects(api.getMessages('pubaaa', {}), (err) => err.code === 'SESSION')
  assert.equal(joined().length, joins, 'no second join inside the cooldown')
})

await test('account conversations are not a public-mode concept', async () => {
  configurePublic()
  await assert.rejects(api.listConversations(), (err) => err.message === '公开聊天室没有会话列表')
})

await test('switching rooms drops the old session instead of replaying it', async () => {
  configurePublic()
  const first = await api.joinPublicRoom()
  const firstCookie = api.getSession().cookies
  configurePublic({ roomToken: 'pubpass', roomPassword: 'room-pass' })
  const second = await api.joinPublicRoom()
  assert.notEqual(second.actorId, first.actorId)
  assert.ok(firstCookie.length > 0)
  assert.equal(joined()[0].cookie, '', 'a cookie for another room is never sent')
})

server.close()

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
