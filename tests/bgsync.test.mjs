// Background sync transport (common/scripts/bgSync.js) and the wiring that
// keeps it honest.
//
// The lesson that produced this file: Vela has two documented ways to keep
// working off screen, and only one of them is a micro service. The other is
// `config.background.features` + one of those interfaces *running* - which is
// what HyperBilibili relies on (it really plays audio and really downloads).
// For a chat client the honest running interface is a download, so these tests
// pin the URL/headers/file-name decisions and the manifest declaration that
// makes the process survive.
//
// Run with: sh tests/run.sh

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BG_SYNC_MS,
  SYNC_FLOOR_MS,
  ROOMS_FILE,
  roomsUrl,
  downloadHeader,
  parseRoomsFile
} from './.build/bgSync.mjs'

let passed = 0
const queue = []

function test(name, fn) {
  queue.push({ name, fn })
}

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const manifest = JSON.parse(read('../src/manifest.json'))
const app = read('../src/app.ux')

console.log('bgSync.js pure helpers')

test('roomsUrl builds the OCS conversation endpoint and rejects no host', () => {
  assert.equal(
    roomsUrl('https://cloud.example.com'),
    'https://cloud.example.com/ocs/v2.php/apps/spreed/api/v4/room?includeStatus=0'
  )
  // Trailing slashes must not double up: the download URL is built here, not by
  // api.js' buildUrl().
  assert.equal(
    roomsUrl('https://cloud.example.com///'),
    'https://cloud.example.com/ocs/v2.php/apps/spreed/api/v4/room?includeStatus=0'
  )
  assert.equal(roomsUrl(''), '')
  assert.equal(roomsUrl(null), '')
})

test('downloadHeader is the JSON string request.download expects', () => {
  const header = downloadHeader({ user: 'alice', appPassword: 'app-pw' }, (value) => 'B64(' + value + ')')
  const parsed = JSON.parse(header)
  assert.equal(parsed.Authorization, 'Basic B64(alice:app-pw)')
  assert.equal(parsed['OCS-APIRequest'], 'true')
  assert.equal(parsed.Accept, 'application/json')
})

test('downloadHeader never emits a broken Basic value without credentials', () => {
  const parsed = JSON.parse(downloadHeader({}, null))
  assert.equal(parsed.Authorization, undefined, 'no credentials, no auth header')
  assert.equal(parsed['OCS-APIRequest'], 'true')
})

test('parseRoomsFile accepts both OCS envelopes and a bare array', () => {
  const rooms = [{ token: 'a' }, { token: 'b' }]
  assert.deepEqual(parseRoomsFile(JSON.stringify(rooms)), rooms)
  assert.deepEqual(parseRoomsFile(JSON.stringify({ ocs: { meta: { statuscode: 200 }, data: rooms } })), rooms)
  // Nextcloud answers with a BOM on some builds.
  assert.deepEqual(parseRoomsFile('\uFEFF' + JSON.stringify(rooms)), rooms)
})

test('parseRoomsFile rejects junk instead of returning a half-parsed list', () => {
  assert.deepEqual(parseRoomsFile(''), [], 'an empty body is an empty list, not a crash')
  assert.deepEqual(parseRoomsFile(null), [])
  assert.throws(() => parseRoomsFile('<html>login</html>'), /not JSON/)
  assert.throws(() => parseRoomsFile('{"ocs":{"data":{"unexpected":true}}}'), /unexpected room list shape/)
})

test('the ticker must stay inside the platform 20s background window', () => {
  // 后台运行: once every declared interface has finished, the process is stopped
  // after 20s of silence. Both numbers have to sit under that, and the in-app
  // one is not the service's 30s floor.
  assert.ok(BG_SYNC_MS < 20000, `BG_SYNC_MS is ${BG_SYNC_MS}, which is outside the window`)
  assert.equal(SYNC_FLOOR_MS, BG_SYNC_MS)
  assert.equal(ROOMS_FILE.endsWith('.txt'), true, 'older file APIs reject .json resources')
})

test('the serviceclient feature is required lazily, never imported', () => {
  // 1.0.16 learned this the hard way: a module-scope
  // `import serviceclient from '@system.serviceclient'` compiles to a module-level
  // $app_require$ call, and on a firmware without the feature that call *throws*
  // while app.ux is still initialising - taking the translators, the lease
  // heartbeat and the in-app background ticker down with it. The feature has to
  // be resolved inside a try/catch at call time, once.
  const client = read('../src/common/scripts/keeperClient.js')
  assert.doesNotMatch(client, /^import [^\n]*@system\.serviceclient/m, 'no module-scope import')
  assert.match(client, /require\('@system\.serviceclient'\)/, 'resolved at call time')
  assert.match(client, /try \{[\s\S]*?require\('@system\.serviceclient'\)[\s\S]*?\} catch/, 'the require is caught')
  // And it must not be retried forever: a firmware that says "not found" now
  // will still say so at the next tick.
  assert.match(client, /featureMissing/, 'a missing feature is remembered')
})

console.log('\nmanifest / app wiring')

test('the manifest declares the background interface it uses', () => {
  const features = (manifest.features || []).map((item) => item.name)
  assert.ok(features.includes('system.request'), 'system.request must be in features')
  const background = manifest.config && manifest.config.background
  assert.ok(background && Array.isArray(background.features), 'config.background.features is required')
  assert.deepEqual(background.features, ['system.request'])
  assert.ok(features.includes('system.file'), 'the downloaded file has to be readable')
})

test('app.ux keeps the in-process ticker paused while the app is visible', () => {
  // It must never poll alongside the pages: `createKeeper` pauses on a
  // foreground lease, so the page has to send one before start().
  const sync = app.slice(app.indexOf('startBackgroundSync() {'), app.indexOf('startBackgroundSync() {') + 400)
  assert.match(sync, /\{ type: 'foreground' \}/, 'start paused')
  assert.ok(sync.indexOf("{ type: 'foreground' }") < sync.indexOf('bgKeeper.start()'), 'lease before start')
  const hide = app.slice(app.indexOf('onHide()'), app.indexOf('onHide()') + 300)
  assert.match(hide, /\{ type: 'background' \}/, 'onHide has to tick immediately')
})

test('the download path reads the file it just downloaded', () => {
  assert.match(app, /request\.download\(/)
  assert.match(app, /request\.onDownloadComplete\(/)
  assert.match(app, /file\.readText\(/)
  assert.match(app, /parseRoomsFile\(text\)/)
})

test('a stalled background ticker stops renewing the service lease', () => {
  // Otherwise a broken download path would keep the service paused forever -
  // the 1.0.14 failure mode in a new costume.
  const heartbeat = app.slice(app.indexOf('startHeartbeat()'), app.indexOf('onShow()'))
  assert.match(heartbeat, /lastBgAttemptAt/)
  assert.match(heartbeat, /BG_SYNC_MS \* 3/)
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
