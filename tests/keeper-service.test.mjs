// Wiring checks for the `keeper` micro service.
//
// The service only works if four separate places agree: manifest.json declares
// it, the service file binds the platform, app.ux connects and toggles
// foreground/background, and the settings switch actually starts/stops it.
// A unit test cannot catch a typo in any of those, so pin them here.
//
// Run with: sh tests/run.sh

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const manifest = JSON.parse(read('src/manifest.json'))
const service = read('src/services/keeper.js')
const keeper = read('src/common/scripts/keeper.js')
const client = read('src/common/scripts/keeperClient.js')
const app = read('src/app.ux')
const index = read('src/pages/index/index.ux')
const settings = read('src/pages/settings/settings.ux')
const zh = JSON.parse(read('src/i18n/defaults.json'))
const en = JSON.parse(read('src/i18n/en.json'))

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (err) {
    failed += 1
    console.log('  FAIL ' + name)
    console.log('       ' + ((err && err.message) || err))
  }
}

console.log('keeper service wiring')

test('manifest declares the keeper service and serviceclient feature', () => {
  const services = manifest.services || []
  assert.equal(services.length, 1)
  assert.equal(services[0].name, 'keeper')
  assert.equal(services[0].path, 'services/keeper')
  assert.equal(services[0].autoStart, true)
  const features = (manifest.features || []).map((item) => item.name)
  assert.ok(features.includes('system.serviceclient'))
  // The service bundle calls fetch/storage/vibrator; those features must stay
  // declared at app level or the service cannot import them.
  ;['system.fetch', 'system.storage', 'system.vibrator'].forEach((name) => {
    assert.ok(features.includes(name), name + ' must stay declared')
  })
})

test('service entry file exists and binds lifecycle hooks', () => {
  assert.ok(existsSync(new URL('src/services/keeper.js', root)))
  ;['onCreate', 'onConnect', 'onDisConnect', 'onMessage', 'onDestroy'].forEach((hook) => {
    assert.ok(service.includes(hook + '(') || service.includes(hook + ' ('), hook + ' missing')
  })
  assert.ok(service.includes("from '../common/scripts/keeper'"))
  // The service must not reach for page-only APIs.
  assert.ok(!service.includes('@system.router'), 'a service cannot use system.router')
  assert.ok(!service.includes('@system.prompt'), 'a service cannot use system.prompt')
  assert.ok(!service.includes('@system.brightness'), 'a service cannot use system.brightness')
})

test('keeper.js stays platform free so it can be tested on Node', () => {
  assert.ok(!keeper.includes("from '@system."), 'keeper.js must not import @system modules')
})

test('client uses policy always and forwards foreground/background', () => {
  assert.ok(client.includes("policy: 'always'"))
  assert.ok(client.includes("type: active ? 'foreground' : 'background'"))
  assert.ok(client.includes('subscribe'))
})

test('app.ux connects the service and reports app visibility', () => {
  assert.ok(app.includes("from './common/scripts/keeperClient'"))
  assert.ok(app.includes('keeperClient.start('))
  assert.ok(app.includes('onShow()'))
  assert.ok(app.includes('onHide()'))
  assert.ok(app.includes('keeperClient.foreground(true)'))
  assert.ok(app.includes('keeperClient.foreground(false)'))
  // Retention must be switchable off: app.ux must not connect when disabled.
  assert.ok(app.includes('backgroundKeep === false'))
})

test('settings page toggles the service, not just the flag', () => {
  assert.ok(settings.includes('toggleBackground'))
  assert.ok(settings.includes('keeperClient.start({})'))
  assert.ok(settings.includes('keeperClient.stop()'))
  assert.ok(settings.includes("persist({ backgroundKeep: value })"))
})

test('conversation list pre-renders the retained summary', () => {
  assert.ok(index.includes('backgroundSummary'))
  assert.ok(index.includes('sharedOf(this, state)'), 'cross-page values come from the app instance')
  assert.ok(index.includes('applySummary('))
  assert.ok(index.includes('accountKey('), 'another account summary must be rejected')
})

test('both locales name the switch', () => {
  ;[zh, en].forEach((bundle, i) => {
    const where = i === 0 ? 'defaults' : 'en'
    ;['background', 'on', 'off'].forEach((key) => {
      assert.ok(bundle.settings[key], key + ' missing in ' + where)
    })
  })
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
