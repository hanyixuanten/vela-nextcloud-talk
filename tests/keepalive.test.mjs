// What is left of "background retention" (1.0.20): the crown-exit floating
// icon. Background message sync is gone — no micro service, no background
// download ticker — and these tests pin both halves of that decision:
//
//   1. the keep-alive audio is wired correctly (it is what puts the media
//      entry on the watch face, HyperBilibili-style);
//   2. the machinery it replaced stays removed, so a future refactor cannot
//      quietly reintroduce a background poller the user explicitly declined;
//   3. foreground polling is intact (index refreshes on show, chat polls while
//      visible).

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

let passed = 0
const queue = []

function test(name, fn) {
  queue.push({ name, fn })
}

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const manifest = JSON.parse(read('../src/manifest.json'))
const app = read('../src/app.ux')
const keepAlive = read('../src/common/scripts/keepAliveAudio.js')

test('the manifest declares only the audio it uses in the background', () => {
  const features = (manifest.features || []).map((item) => item.name)
  assert.ok(features.includes('system.audio'), 'system.audio must be in features')
  const background = manifest.config && manifest.config.background
  assert.ok(background && Array.isArray(background.features), 'config.background.features is required')
  assert.deepEqual(background.features, ['system.audio'],
    'no background interface may be declared that nothing runs any more')
  assert.equal(manifest.services, undefined, 'the keeper micro service stays removed')
  assert.ok(!features.includes('system.serviceclient'), 'no serviceclient feature')
  assert.equal(existsSync(new URL('../src/services', import.meta.url).pathname), false,
    'the services directory stays removed')
})

test('the keep-alive audio is wired to hide/show like the media-card entry needs', () => {
  // The floating resume icon on the watch face exists while audio plays, so
  // onHide must start it and onShow must stop it — and the feature must be
  // resolved lazily: a module-level import of a missing feature takes app.ux
  // down with it (the 1.0.17 serviceclient lesson).
  assert.match(keepAlive, /require\('@system\.audio'\)/, 'lazy require, never a module-level import')
  assert.match(keepAlive, /catch/, 'the resolution is caught')
  assert.match(keepAlive, /loop = true/, 'a loop, or the silence ends and the process dies with it')
  assert.match(keepAlive, /keepalive\.wav/, 'a packaged silent file, not a network stream')
  assert.match(app, /keepAliveAudio\.start\(\)/, 'onHide starts the loop')
  const show = app.slice(app.indexOf('onShow() {'), app.indexOf('onDestroy() {'))
  assert.match(show, /keepAliveAudio\.stop\(\)/, 'onShow stops it')
  const destroy = app.slice(app.indexOf('onDestroy() {'))
  assert.match(destroy, /keepAliveAudio\.stop\(\)/, 'teardown stops it')
})

test('the removed background machinery stays removed', () => {
  for (const name of ['keeperClient', 'bgKeeper', 'BG_SYNC_MS', 'createKeeper', 'request.download']) {
    assert.ok(!app.includes(name), 'app.ux must not reference ' + name)
  }
  for (const file of [
    '../src/common/scripts/keeper.js',
    '../src/common/scripts/keeperClient.js',
    '../src/common/scripts/bgSync.js',
    '../src/common/scripts/summary.js',
    '../src/services/keeper.js'
  ]) {
    assert.equal(existsSync(new URL(file, import.meta.url).pathname), false, file + ' stays deleted')
  }
})

test('foreground polling is intact', () => {
  const index = read('../src/pages/index/index.ux')
  const chat = read('../src/pages/chat/chat.ux')
  // index refreshes the list when it becomes visible…
  assert.match(index, /this\.refresh\(\)/, 'index refreshes on show')
  assert.ok(!index.includes('keeperClient'), 'index no longer subscribes to the service')
  // …and chat runs its own message poll while visible.
  assert.match(chat, /schedulePoll/, 'chat keeps its visible-only message poll')
})

let failedCount = 0
for (const item of queue) {
  try {
    await item.fn()
    passed += 1
    console.log('  ok   ' + item.name)
  } catch (err) {
    failedCount += 1
    console.log('  FAIL ' + item.name)
    console.log('       ' + ((err && err.message) || err))
  }
}
console.log('\n' + passed + ' passed, ' + failedCount + ' failed')
if (failedCount > 0) process.exitCode = 1
