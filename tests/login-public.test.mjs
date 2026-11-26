// The public-conversation half of the manual login page.
//
// The acceptance case is "a room link, a password if the room has one, and a
// display name — no account". These tests pin the page side of that: what gets
// written, what the user is told when the join fails, and that a room change
// never replays the previous guest session.
//
// Run with: sh tests/run.sh
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import { ROUTE } from './.build/launch.mjs'
import { parseRoomLink, buildRoomLink } from './.build/roomlink.mjs'

const script = readFileSync(new URL('../src/pages/login/login.ux', import.meta.url), 'utf8')
  .split('<script>')[1].split('</script>')[0]
  .replace(/^import .*$/gm, '')
  .replace('export default', 'return')

const ACTOR = 'a'.repeat(40)
let loaded = {}
const saves = []
const configured = []
const shared = {}
let joinResult = { name: '公开群', token: 'pubaaa' }
let joinGate = null
let joinError = null
let session = { actorId: ACTOR, cookies: 'nc_session_id=abc' }
let navigations = 0
let toasts = 0
const state = { settings: null, ready: false }

const page = runInNewContext('(function () {\n' + script.trim() + '\n})()', {
  state,
  console,
  ROUTE,
  parseRoomLink,
  buildRoomLink,
  sharedOf: () => shared,
  api: {
    configure: (settings) => configured.push(settings),
    joinPublicRoom: async () => {
      if (joinGate) await joinGate
      if (joinError) throw joinError
      return joinResult
    },
    getSession: () => session,
    getCurrentUser: async () => ({ displayName: 'Alice' })
  },
  store: {
    DEFAULT_SETTINGS: { baseUrl: '', user: '', appPassword: '', displayName: '', mode: 'account' },
    load: async () => Object.assign({}, loaded),
    save: async (settings) => {
      saves.push(settings)
      loaded = Object.assign({}, settings)
      return settings
    }
  },
  router: { replace: () => { navigations++ } },
  prompt: { showToast: () => { toasts++ } }
})
Object.assign(page, page.data, { $t: (key) => key })

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await setImmediate()
}

const reset = () => {
  saves.length = 0
  configured.length = 0
  navigations = 0
  toasts = 0
  state.settings = null
  page.submitting = false
  page.error = ''
  joinError = null
  joinGate = null
  joinResult = { name: '公开群', token: 'pubaaa' }
  session = { actorId: ACTOR, cookies: 'nc_session_id=abc' }
}

// Switching through the page's own handler, not by assigning `mode`: the tab
// is what recomputes the button label.
const typePublic = (overrides) => {
  if (page.mode !== 'public') page.switchMode('public')
  return Object.assign(page, {
  roomLink: 'https://cloud.example.com/call/pubaaa',
  roomPassword: '',
  roomName: '小明',
  submitting: false,
  error: '',
  editing: false,
  activeIndex: -1
}, overrides || {})
}

let failedCount = 0

async function test(name, fn) {
  try {
    await fn()
    console.log('  ok   ' + name)
  } catch (err) {
    failedCount += 1
    console.log('  FAIL ' + name)
    console.log('       ' + ((err && err.message) || err))
  }
}

console.log('login.ux — public conversations')

await test('the room link opens the public tab on its own', async () => {
  reset()
  loaded = { mode: 'public', baseUrl: 'https://cloud.example.com', roomToken: 'pubaaa', roomDisplayName: '小明' }
  await page.onInit()
  await flush()
  assert.equal(page.mode, 'public')
  // The link is rebuilt from the stored halves, so the field shows something
  // the user can edit rather than an empty box.
  assert.equal(page.roomLink, 'https://cloud.example.com/call/pubaaa')
  assert.equal(page.roomName, '小明')
})

await test('a settings row can ask for the account tab explicitly', async () => {
  reset()
  loaded = { mode: 'public', baseUrl: 'https://cloud.example.com', roomToken: 'pubaaa' }
  shared.pendingMode = 'account'
  await page.onInit()
  await flush()
  assert.equal(page.mode, 'account')
  assert.equal(shared.pendingMode, null, 'the request is one-shot')
})

await test('link + name joins, writes the room and keeps the account', async () => {
  reset()
  loaded = {
    mode: 'account',
    baseUrl: 'https://cloud.example.com',
    user: 'alice',
    appPassword: 'app-password',
    displayName: 'Alice',
    keyboardType: 'T9'
  }
  await page.onInit()
  await flush()
  typePublic()
  page.submit()
  await flush()

  assert.equal(page.error, '')
  assert.equal(navigations, 1, 'a joined room goes to the conversation list')
  assert.equal(toasts, 1)

  const saved = saves[saves.length - 1]
  assert.equal(saved.mode, 'public')
  assert.equal(saved.baseUrl, 'https://cloud.example.com')
  assert.equal(saved.roomToken, 'pubaaa')
  assert.equal(saved.roomPassword, '')
  assert.equal(saved.roomDisplayName, '小明')
  assert.equal(saved.roomName, '公开群')
  assert.equal(saved.roomActorId, ACTOR)
  assert.equal(saved.sessionCookies, 'nc_session_id=abc')
  // Switching modes must not make the account unreachable.
  assert.equal(saved.user, 'alice')
  assert.equal(saved.appPassword, 'app-password')
  assert.equal(saved.keyboardType, 'T9')
})

await test('the button says what the tap will do, and what it is doing', async () => {
  reset()
  loaded = { mode: 'account', baseUrl: 'https://cloud.example.com', user: 'alice', appPassword: 'pw' }
  await page.onInit()
  await flush()
  assert.equal(page.submitLabel, 'login.connect', 'the account tab connects')
  typePublic()
  assert.equal(page.submitLabel, 'login.join', 'the public tab joins a room')

  // Hold the join open: the label has to change while the request runs, or a
  // slow server reads as an ignored tap.
  let release
  joinGate = new Promise((resolve) => {
    release = resolve
  })
  page.submit()
  await flush()
  assert.equal(page.submitLabel, 'login.joining')
  assert.equal(page.submitting, true)
  release()
  await flush()
  assert.equal(navigations, 1)
})

await test('a prefix and ?password= in the link are both understood', async () => {
  reset()
  loaded = { mode: 'public' }
  await page.onInit()
  await flush()
  typePublic({
    roomLink: 'https://example.com/nextcloud/index.php/call/ABC123?password=pa%20ss',
    roomName: '小明'
  })
  page.submit()
  await flush()
  const saved = saves[saves.length - 1]
  assert.equal(saved.baseUrl, 'https://example.com/nextcloud')
  assert.equal(saved.roomToken, 'abc123')
  assert.equal(saved.roomPassword, 'pa ss')
  assert.equal(navigations, 1)
})

await test('a typed password wins over the one in the link', async () => {
  reset()
  loaded = { mode: 'public' }
  await page.onInit()
  await flush()
  typePublic({
    roomLink: 'https://cloud.example.com/call/abc123?password=from-link',
    roomPassword: 'typed',
    roomName: '小明'
  })
  page.submit()
  await flush()
  assert.equal(saves[saves.length - 1].roomPassword, 'typed')
})

await test('a bare token works when a server is already known', async () => {
  reset()
  loaded = { mode: 'account', baseUrl: 'https://cloud.example.com', user: 'alice', appPassword: 'pw' }
  await page.onInit()
  await flush()
  typePublic({ roomLink: 'abc123' })
  page.submit()
  await flush()
  const saved = saves[saves.length - 1]
  assert.equal(saved.baseUrl, 'https://cloud.example.com')
  assert.equal(saved.roomToken, 'abc123')
  assert.equal(navigations, 1)
})

await test('a bare token without a server asks for the server', async () => {
  reset()
  loaded = { mode: 'public', baseUrl: '', roomToken: '' }
  await page.onInit()
  await flush()
  typePublic({ roomLink: 'abc123' })
  page.submit()
  await flush()
  assert.equal(page.error, 'login.errRoomBase')
  assert.equal(saves.length, 0, 'nothing is written for input that cannot work')
  assert.equal(navigations, 0)
})

await test('a display name is required', async () => {
  reset()
  loaded = { mode: 'public' }
  await page.onInit()
  await flush()
  typePublic({ roomName: '   ' })
  page.submit()
  await flush()
  assert.equal(page.error, 'login.errRoomName')
  assert.equal(saves.length, 0)
})

await test('a wrong password keeps the room on disk and stays on the page', async () => {
  reset()
  loaded = { mode: 'account', baseUrl: 'https://cloud.example.com', user: 'alice', appPassword: 'pw' }
  await page.onInit()
  await flush()
  joinError = Object.assign(new Error('聊天室密码不正确'), { status: 403 })
  typePublic()
  page.submit()
  await flush()

  assert.equal(page.submitting, false)
  assert.equal(page.error, 'login.savedUnverified')
  assert.equal(navigations, 0, 'the user fixes the password on this page')
  // Written before the join, so a retry only has to correct the password.
  const saved = saves[saves.length - 1]
  assert.equal(saved.mode, 'public')
  assert.equal(saved.roomToken, 'pubaaa')
  assert.equal(state.settings.roomToken, 'pubaaa')
  // The API client points back at what is on disk, not at the failed candidate.
  assert.equal(configured[configured.length - 1].roomToken, saved.roomToken)
})

await test('chatting in the same room keeps the guest session', async () => {
  reset()
  loaded = {
    mode: 'public',
    baseUrl: 'https://cloud.example.com',
    roomToken: 'pubaaa',
    roomPassword: '',
    roomDisplayName: '小明',
    roomName: '公开群',
    roomActorId: ACTOR,
    sessionCookies: 'nc_session_id=abc'
  }
  await page.onInit()
  await flush()
  typePublic({ roomName: '小明' })
  page.submit()
  await flush()
  // The link field is the source of truth for the token, and it is the same
  // room: the session belongs to it and there is no reason to drop it.
  const first = saves[0]
  assert.equal(first.roomActorId, ACTOR)
  assert.equal(first.sessionCookies, 'nc_session_id=abc')
})

await test('another room starts as a new guest', async () => {
  reset()
  loaded = {
    mode: 'public',
    baseUrl: 'https://cloud.example.com',
    roomToken: 'pubaaa',
    roomDisplayName: '小明',
    roomName: '公开群',
    roomActorId: ACTOR,
    sessionCookies: 'nc_session_id=abc'
  }
  await page.onInit()
  await flush()
  typePublic({ roomLink: 'https://cloud.example.com/call/pubpass', roomName: '小明' })
  page.submit()
  await flush()
  const first = saves[0]
  assert.equal(first.roomToken, 'pubpass')
  // Replaying the old cookie would be a session for a different conversation.
  assert.equal(first.roomActorId, '')
  assert.equal(first.sessionCookies, '')
  assert.equal(first.roomName, '')
})

await test('the switch back to the account tab does not touch the form', async () => {
  reset()
  loaded = { mode: 'public', baseUrl: 'https://cloud.example.com', roomToken: 'pubaaa' }
  await page.onInit()
  await flush()
  typePublic()
  page.switchMode('account')
  assert.equal(page.mode, 'account')
  assert.equal(page.roomLink, 'https://cloud.example.com/call/pubaaa')
  page.switchMode('public')
  assert.equal(page.mode, 'public')
})

console.log('')
process.exit(failedCount === 0 ? 0 : 1)
