// The manual login page must persist typed credentials before it validates
// them: the app password comes from a watch keyboard, and a failed round trip
// (wrong password, timeout, flaky Wi-Fi) must not throw it away.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import { ROUTE } from './.build/launch.mjs'

// The page script declares a helper before `export default`, so it is wrapped
// in a function to keep the helper local and hand back the component object.
const script = readFileSync(new URL('../src/pages/login/login.ux', import.meta.url), 'utf8')
  .split('<script>')[1].split('</script>')[0]
  .replace(/^import .*$/gm, '')
  .replace('export default', 'return')

let saves = 0
let saveFails = false
let validate
let navigations = 0
let toasts = 0
const configured = []
const state = { settings: null, ready: false }
const page = runInNewContext('(function () {\n' + script.trim() + '\n})()', {
  state, console, ROUTE,
  api: {
    configure: (settings) => configured.push(settings),
    getCurrentUser: (settings) => validate(settings)
  },
  store: {
    DEFAULT_SETTINGS: { baseUrl: '', user: '', appPassword: '', displayName: '' },
    load: async () => ({ baseUrl: '', user: '', appPassword: '', displayName: '', keyboardType: 'QWERTY' }),
    save: async (settings) => {
      saves++
      if (saveFails) throw new Error('storage write failed, code=13900001')
      return settings
    }
  },
  router: { replace: () => { navigations++ } },
  prompt: { showToast: () => { toasts++ } }
})
Object.assign(page, page.data, { $t: (key) => key })

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await setImmediate()
}

await page.onInit()
flush()

const type = (overrides) => {
  Object.assign(page, {
    server: 'https://cloud.example.com',
    user: 'alice',
    appPassword: 'app-password',
    submitting: false,
    error: ''
  }, overrides || {})
}

// A rejected password is still what the user typed: it stays on disk.
type()
validate = async (settings) => {
  assert.equal(saves, 1, 'the credentials are written before validation starts')
  assert.equal(settings.user, 'alice')
  assert.equal(settings.appPassword, 'app-password')
  throw new Error('账号或应用密码错误')
}
page.submit()
await flush()
assert.equal(saves, 1)
assert.equal(state.settings.user, 'alice')
assert.equal(state.ready, true)
assert.equal(page.submitting, false)
assert.equal(page.error, 'login.savedUnverified')
assert.equal(navigations, 0, 'a failed login stays on the page so the field can be fixed')
assert.equal(configured[configured.length - 1].appPassword, 'app-password')

// A working password only adds the display name on top of the stored account.
type({ appPassword: 'fixed-password' })
validate = async () => ({ displayName: 'Alice' })
page.submit()
await flush()
assert.equal(saves, 3, 'one write for the credentials, one for the display name')
assert.equal(state.settings.displayName, 'Alice')
assert.equal(state.settings.appPassword, 'fixed-password')
assert.equal(navigations, 1)
assert.equal(toasts, 1)

// A write that fails must not be described as saved, and must not validate:
// there would be nothing left to log in with.
type({ appPassword: 'third-try' })
saveFails = true
validate = async () => { throw new Error('validation must not run without a save') }
page.submit()
await flush()
assert.equal(page.error, 'storage write failed, code=13900001')
assert.equal(state.settings.appPassword, 'fixed-password', 'the previous account is untouched')
assert.equal(navigations, 1)
console.log('  ok   manual login saves before validating and keeps a rejected password')
