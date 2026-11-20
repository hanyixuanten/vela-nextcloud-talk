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

test('the router entry is the gate, not the conversation list', () => {
  assert.equal(manifest.router.entry, 'pages/splash')
  assert.equal(manifest.router.pages['pages/splash'].path, ROUTE.splash)
  assert.equal(manifest.router.pages['pages/index'].path, ROUTE.home)
})

test('the gate probes the network and routes by its verdict', () => {
  assert.match(splash, /import network from '\.\.\/\.\.\/common\/scripts\/network'/)
  assert.match(splash, /network\.checkNetwork\(/)
  assert.match(splash, /routeAfterGate\(online, store\.hasAccount/)
  // The verdict has to be published before the replace, otherwise the page
  // being entered bounces straight back here.
  assert.match(splash, /state\.launchAllowed = online\s*\n\s*const target/)
})

test('the gate builds no main UI of its own', () => {
  for (const key of ['index.title', 'index.refresh', 'index.settings', 'settings.title']) {
    assert.ok(!splash.includes(key), `splash must not render ${key}`)
  }
})

test('the conversation list refuses to open without a passed gate', () => {
  const guard = index.indexOf('state.launchAllowed')
  const refresh = index.indexOf('this.refresh()')
  assert.ok(guard > -1, 'index checks state.launchAllowed')
  assert.ok(guard < refresh, 'the guard runs before the list is fetched')
  assert.match(index, /router\.replace\(\{ uri: ROUTE\.splash \}\)/)
  // The probe belongs to the gate; a second one here would be paid again on
  // every return from the chat page.
  assert.ok(!index.includes('checkNetwork'), 'index does not probe the network itself')
})

test('retry goes back through the gate instead of straight to the list', () => {
  assert.match(offline, /router\.replace\(\{ uri: ROUTE\.splash \}\)/)
  assert.ok(!offline.includes('checkNetwork'), 'offline owns no probe of its own')
})

console.log('launch gate checks passed')
