// Exercise the setup page's real script with stand-ins for Vela and storage.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import protocol from './.build/protocol.mjs'
import { ROUTE } from './.build/launch.mjs'

const script = readFileSync(new URL('../src/pages/setup/setup.ux', import.meta.url), 'utf8')
  .split('<script>')[1].split('</script>')[0]
  .replace(/^import .*$/gm, '')
  .replace('export default', '')
const connect = { send(payload) { replies.push(payload) } }
const replies = []
const timers = new Map()
let navigations = 0
let nextTimer = 0
let saves = 0
let saveFails = false
let validate
const keepAwake = []
const state = { settings: { user: 'previous' } }
const page = runInNewContext('(' + script.trim() + ')', {
  protocol, state, console, ROUTE,
  interconnect: { instance: () => connect },
  api: { getCurrentUser: (settings) => validate(settings), configure() {} },
  store: {
    save: async (settings) => {
      saves++
      if (saveFails) throw new Error('storage write failed, code=13900001')
      return settings
    }
  },
  router: { replace: () => { navigations++ } },
  nav: { leave: () => { navigations++ } },
  brightness: { setKeepScreenOn: (options) => keepAwake.push(options.keepScreenOn) },
  setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer },
  clearTimeout: (id) => { timers.delete(id) }
})
Object.assign(page, page.data, { $t: (key) => key })
const request = (id) => JSON.stringify({
  v: 1, kind: 'credentials', request_id: id, user: 'alice',
  base_url: 'https://cloud.example.com', app_password: 'test'
})

page.onInit()
page.onShow()

// The ordering is the point: the credentials must already be on disk when
// validation starts, so nothing the network says can lose them.
validate = async () => {
  assert.equal(saves, 1, 'credentials are written before validation starts')
  throw new Error('invalid credentials')
}
connect.onmessage({ data: request('bad') })
await setImmediate()
assert.equal(saves, 1)
assert.equal(state.settings.user, 'alice', 'a rejected credential is still what the phone sent')
assert.deepEqual(keepAwake, [true, false], 'screen is kept on exactly while validating')
assert.equal(page.statusText, 'setup.savedUnverified')
assert.equal(page.statusClass, 'status-error')
assert.deepEqual(replies[0].data, { ok: false, message: 'setup.savedUnverified', display_name: '', request_id: 'bad' })

let finishValidation
validate = () => new Promise((resolve) => { finishValidation = resolve })
const oldListener = connect.onmessage
oldListener({ data: request('left') })
// The save is asynchronous, so validation only starts on the next tick.
await setImmediate()
assert.equal(typeof finishValidation, 'function', 'validation starts once the credentials are stored')
page.onHide()
assert.equal(connect.onmessage, null)
oldListener({ data: request('stale') })
finishValidation({ displayName: 'Alice' })
await setImmediate()
assert.equal(saves, 2, 'leaving mid-validation keeps the save and skips the optional rename')
assert.equal(replies.length, 1)

page.onShow()
validate = async () => ({ displayName: 'Alice' })
connect.onmessage({ data: request('good') })
await setImmediate()
assert.equal(saves, 4, 'one write for the credentials, one for the display name')
assert.equal(state.settings.user, 'alice')
assert.equal(state.settings.displayName, 'Alice')
assert.deepEqual(replies[1].data, { ok: true, message: 'setup.saved', display_name: 'Alice', request_id: 'good' })
assert.equal(timers.size, 0, 'wait until Vela accepts the reply before scheduling navigation')
replies[1].success()
assert.equal(timers.size, 1)
page.onDestroy()
assert.equal(timers.size, 0)
assert.equal(navigations, 0)
console.log('  ok   setup page saves before validating, sends object ACKs and detaches on exit')

// A network timeout must not be reported as "wrong credentials" — and it must
// not be reported as "nothing happened" either: the input is already stored.
keepAwake.length = 0
page.onShow()
validate = async () => {
  const err = new Error('网络请求超时')
  err.code = 'TIMEOUT'
  throw err
}
connect.onmessage({ data: request('slow') })
await setImmediate()
assert.deepEqual(replies[2].data, { ok: false, message: 'setup.savedUnverified', display_name: '', request_id: 'slow' })
assert.equal(page.statusText, 'setup.savedUnverified')
assert.equal(page.statusClass, 'status-error')
assert.equal(saves, 5)
assert.equal(state.settings.user, 'alice', 'a timed-out validation leaves the account configured')
assert.deepEqual(keepAwake, [true, false], 'a failed validation also releases the screen')
page.onDestroy()
console.log('  ok   a timed-out validation keeps the credentials and says they are saved')

// A write that never reached storage must not claim to have saved anything,
// and there is nothing to validate: the account cannot be kept either way.
keepAwake.length = 0
page.onShow()
saveFails = true
validate = async () => { throw new Error('validation must not run without a save') }
connect.onmessage({ data: request('nosave') })
await setImmediate()
assert.equal(page.statusText, 'storage write failed, code=13900001')
assert.deepEqual(replies[3].data, {
  ok: false, message: 'storage write failed, code=13900001', display_name: '', request_id: 'nosave'
})
assert.deepEqual(keepAwake, [true, false], 'the screen is released on a failed write too')
page.onDestroy()
console.log('  ok   a failed write reports the storage error instead of claiming a save')
