// Launch gate: the app must probe the network before any main page exists.
//
// Modelled on HyperBilibili's `pages/app/entry/splash`, which awaits
// NetworkCheck() and only then replaces to login/main. Here the entry page is
// `pages/splash` and the verdict comes from `common/scripts/network.js`.
//
// Two kinds of assertion:
//   1. the routing table, run for real (pure function, no watch runtime);
//   2. the page wiring, read as text — the bug this guards against is "the
//      gate runs after the list is already on screen", which is a structural
//      property, not a behavioural one.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ROUTE, routeAfterGate } from './.build/launch.mjs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const manifest = JSON.parse(read('../src/manifest.json'))
const splash = read('../src/pages/splash/splash.ux')
const index = read('../src/pages/index/index.ux')
const offline = read('../src/pages/offline/offline.ux')

const test = (name, fn) => {
  fn()
  console.log('  ok   ' + name)
}

test('offline never reaches setup or the list, whatever the account state', () => {
  assert.equal(routeAfterGate(false, true), ROUTE.offline)
  assert.equal(routeAfterGate(false, false), ROUTE.offline)
})

test('online without an account goes to the phone setup page', () => {
  assert.equal(routeAfterGate(true, false), ROUTE.setup)
})

test('online with an account goes to the conversation list', () => {
  assert.equal(routeAfterGate(true, true), ROUTE.home)
})

test('routes are page keys, exactly like the reference app', () => {
  // HyperBilibili (which navigates fine on the same watch) declares no custom
  // `path` and calls router.replace({ uri: "pages/app/features/main" }).
  // Custom paths made `replace('/')` never land on pages/index — the gate
  // looked like a loop instead of a navigation.
  assert.equal(manifest.router.entry, 'pages/splash')
  Object.keys(manifest.router.pages).forEach((key) => {
    assert.equal(manifest.router.pages[key].path, undefined, key + ' must not declare a path')
  })
  Object.keys(ROUTE).forEach((key) => {
    assert.ok(!ROUTE[key].startsWith('/'), 'ROUTE.' + key + ' must be a page key')
    assert.ok(manifest.router.pages[ROUTE[key]], 'ROUTE.' + key + ' must exist in manifest')
  })
  assert.equal(ROUTE.home, 'pages/index')
})

test('the gate probes the network and routes by its verdict', () => {
  assert.match(splash, /import network from '\.\.\/\.\.\/common\/scripts\/network'/)
  assert.match(splash, /network\.checkSignal\(/)
  assert.match(splash, /routeAfterGate\(signal\.online, store\.hasAccount/)
  // The verdict has to be published before the replace, otherwise the page
  // being entered bounces straight back here.
  // The verdict goes onto the app instance, not into this page's copy of
  // `state` (a module level flag is per page bundle and made index bounce back
  // to splash forever).
  // No verdict is published at all: reading it from another page is exactly
  // what looped. The gate routes and forgets.
  assert.ok(!splash.includes('gateOnline'), 'the gate must not publish a verdict')
  assert.ok(!splash.includes('launchAllowed'), 'not in module state either')
  // The probes are evidence, not a gate, and they must run *after* the route
  // decision (that was the "stuck on 没有网络" bug: a slow probe looked exactly
  // like a dead interface).
  assert.ok(!/launchAllowed = .*probe/.test(splash), 'the probe must not decide the launch')
  const routed = splash.indexOf('this.navigate(target)')
  const probed = splash.indexOf('this.probe()')
  assert.ok(routed > -1 && probed > routed, 'probe runs after the launch is routed')
  // Navigation is deferred off the onShow tick and retried once: a replace
  // issued too early can be dropped, which looks exactly like a hung gate.
  assert.match(splash, /navigate\(target\) \{[\s\S]*setTimeout\(/)
  assert.match(splash, /still on splash after replace, retrying/)
  // The stage line is what makes a stuck launch readable on the watch itself.
  assert.match(splash, /\{\{ stage \|\| \$t\('splash\.checking'\) \}\}/)
  // bilibili is the control, the configured server is the target; both land in
  // shared state so the first request's error can say which one failed.
  assert.match(splash, /network\.probeTargets\(/)
  assert.match(splash, /shared\.controlProbe = result\.control/)
  assert.match(splash, /shared\.serverProbe = result\.server/)
})

test('cross-page verdict lives on the app instance, not module state', () => {
  const app = readFileSync(new URL('../src/app.ux', import.meta.url), 'utf8')
  // Each page is its own webpack entry and gets its own copy of common
  // modules, so a module level flag is invisible across pages. app.ux is the
  // only object every page can reach.
  assert.match(app, /shared: shared,/)
  assert.match(app, /controlProbe: null/)
  // backgroundSummary was removed with the keeper service (1.0.20): nothing
  // produces it any more, and index must not pretend to read it.
  assert.ok(!app.includes('backgroundSummary'), 'no retained-summary slot on shared')
  assert.ok(!readFileSync(new URL('../src/pages/index/index.ux', import.meta.url), 'utf8').includes('backgroundSummary'))
  // No gate verdict on the shared object: nothing may read one.
  assert.ok(!app.includes('gateOnline'), 'no cross-page gate verdict')
  const helper = readFileSync(new URL('../src/common/scripts/shared.js', import.meta.url), 'utf8')
  assert.match(helper, /export function sharedOf/, 'sharedOf resolves $app.$def.shared')
  assert.ok(!helper.includes('blockedByGate'), 'no cross-page verdict helper')
  for (const page of [splash, index]) {
    assert.ok(!/launchAllowed|gateOnline|gateChecked/.test(page), 'no page may carry a gate verdict')
  }
})

test('the gate builds no main UI of its own', () => {
  for (const key of ['index.title', 'index.refresh', 'index.settings', 'settings.title']) {
    assert.ok(!splash.includes(key), `splash must not render ${key}`)
  }
})

test('the conversation list never bounces back to the gate', () => {
  // The guard that used to live here read a flag written by another bundle
  // (module state is per page), so it always saw "not allowed" and produced
  // 检查网络… → 进入 / → 检查网络… forever. Entering without the gate is fine:
  // pages/splash only diverts a definitive `none` to /offline before this page
  // exists, and every other problem surfaces as a request error here.
  assert.ok(!index.includes('blockedByGate'), 'no gate check in the list page')
  assert.ok(!index.includes('ROUTE.splash'), 'the list must never navigate back to splash')
  assert.match(index, /this\.refresh\(\)/, 'it fetches regardless')
  // The probe belongs to the gate; a second one here would be paid again on
  // every return from the chat page.
  assert.ok(!index.includes('checkNetwork'), 'index does not probe the network itself')
})

test('retry goes back through the gate instead of straight to the list', () => {
  assert.match(offline, /router\.replace\(\{ uri: ROUTE\.splash \}\)/)
  assert.ok(!offline.includes('checkNetwork'), 'offline owns no probe of its own')
})

console.log('launch gate checks passed')
