// "Background retention" final form (1.0.21): a manifest declaration and
// nothing else. HyperBilibili's 挂后台 never played silent audio — its git
// history shows `system.audio` only as a manifest declaration — and these
// tests pin that shape:
//
//   1. the background declaration is present (it is what keeps the process
//      alive after the crown exit, so the watch-face entry can return to the
//      untouched UI);
//   2. no playback machinery exists — a silent loop was shipped in 1.0.20 and
//      removed in 1.0.21; these assertions keep it out;
//   3. the removed background-sync machinery stays removed;
//   4. foreground polling is intact (index refreshes on show, chat polls while
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

test('the manifest declares the background audio feature, and only that', () => {
  const features = (manifest.features || []).map((item) => item.name)
  assert.ok(features.includes('system.audio'), 'system.audio must be in features')
  const background = manifest.config && manifest.config.background
  assert.ok(background && Array.isArray(background.features), 'config.background.features is required')
  // This declaration is the whole keep-alive: HyperBilibili ships the same
  // single entry and nothing else.
  assert.deepEqual(background.features, ['system.audio'])
  assert.equal(manifest.services, undefined, 'the keeper micro service stays removed')
  assert.ok(!features.includes('system.serviceclient'), 'no serviceclient feature')
  assert.equal(existsSync(new URL('../src/services', import.meta.url).pathname), false,
    'the services directory stays removed')
})

test('no keep-alive playback: declaration only, like HyperBilibili', () => {
  // The silent WAV loop (1.0.20) was removed in 1.0.21. If the floating icon
  // ever disappears, bring the loop back — not a resident hack.
  assert.equal(existsSync(new URL('../src/common/audio', import.meta.url).pathname), false,
    'no packaged audio asset')
  assert.equal(existsSync(new URL('../src/common/scripts/keepAliveAudio.js', import.meta.url).pathname), false,
    'no audio playback module')
  for (const name of ['keepAliveAudio.start', 'keepAliveAudio.stop', 'system.audio\'', 'audio.start', 'audio.play']) {
    assert.ok(!app.includes(name), 'app.ux must not reference ' + name)
  }
  const comment = app.slice(app.indexOf('1.0.21:'))
  assert.match(comment, /keepAliveAudio/, 'app.ux must say where the removed module lives')
})

test('the removed background-sync machinery stays removed', () => {
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
