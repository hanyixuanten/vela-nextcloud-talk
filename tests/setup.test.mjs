// Exercise the setup page's real script with stand-ins for Vela and storage.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import protocol from './.build/protocol.mjs'

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
let validate
const state = { settings: { user: 'previous' } }
const page = runInNewContext('(' + script.trim() + ')', {
  protocol, state, console,
  interconnect: { instance: () => connect },
  api: { getCurrentUser: (settings) => validate(settings), configure() {} },
  store: { save: async (settings) => { saves++; return settings } },
  router: { replace: () => { navigations++ } },
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
validate = async () => { throw new Error('invalid credentials') }
connect.onmessage({ data: request('bad') })
await setImmediate()
assert.equal(saves, 0)
assert.equal(state.settings.user, 'previous')
assert.deepEqual(replies[0].data, { ok: false, message: 'invalid credentials', display_name: '', request_id: 'bad' })

let finishValidation
validate = () => new Promise((resolve) => { finishValidation = resolve })
const oldListener = connect.onmessage
oldListener({ data: request('left') })
page.onHide()
assert.equal(connect.onmessage, null)
oldListener({ data: request('stale') })
finishValidation({ displayName: 'Alice' })
await setImmediate()
assert.equal(saves, 0)
assert.equal(replies.length, 1)

page.onShow()
validate = async () => ({ displayName: 'Alice' })
connect.onmessage({ data: request('good') })
await setImmediate()
assert.equal(saves, 1)
assert.equal(state.settings.user, 'alice')
assert.deepEqual(replies[1].data, { ok: true, message: 'setup.saved', display_name: 'Alice', request_id: 'good' })
assert.equal(timers.size, 0, 'wait until Vela accepts the reply before scheduling navigation')
replies[1].success()
assert.equal(timers.size, 1)
page.onDestroy()
assert.equal(timers.size, 0)
assert.equal(navigations, 0)
console.log('  ok   setup page checks authentication, sends object ACKs and detaches on exit')
