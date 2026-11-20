// Failure reporting for the settings store.
//
// The watch reported "storage write failed, code=undefined": the handler read
// only the second callback argument, so every Vela build that answers with a
// single result object (or with nothing at all) produced a message that named
// no cause. These tests pin the shapes the platform actually uses.
//
// Run with: sh tests/run.sh

import assert from 'node:assert/strict'
import store from './.build/store.mjs'
import storage, { behaviour, reset, log } from './.build/storage-double.mjs'

let passed = 0
let failed = 0
const queue = []

function test(name, fn) {
  queue.push({ name, fn })
}

async function run() {
  for (const item of queue) {
    reset()
    try {
      await item.fn()
      passed += 1
      console.log('  ok   ' + item.name)
    } catch (err) {
      failed += 1
      console.log('  FAIL ' + item.name)
      console.log('       ' + ((err && err.message) || err))
    }
  }
}

const SETTINGS = {
  baseUrl: 'https://cloud.example.com/',
  user: ' alice ',
  appPassword: ' app-password ',
  displayName: 'Alice'
}

console.log('store.js')

test('save writes canonical JSON and resolves the normalized settings', async () => {
  const saved = await store.save(SETTINGS)
  assert.equal(saved.baseUrl, 'https://cloud.example.com')
  assert.equal(saved.user, 'alice')
  assert.equal(saved.appPassword, 'app-password')
  assert.equal(saved.keyboardType, 'QWERTY')
  assert.equal(log.length, 1)
  assert.equal(log[0].op, 'set')
  assert.equal(log[0].key, 'nctalk.settings')
  const written = JSON.parse(JSON.stringify(saved))
  assert.equal(written.pollInterval, 15000)
})

test('fail(data, code) keeps both the code and the platform text', async () => {
  behaviour.set = (options) => options.fail('no space left on device', 202)
  await assert.rejects(store.save(SETTINGS), (err) => {
    assert.match(err.message, /storage write failed, code=202/)
    assert.match(err.message, /no space left on device/)
    assert.equal(err.storageCode, 202)
    return true
  })
})

test('a single result object is unwrapped instead of surfacing code=undefined', async () => {
  // This is the shape that produced the reported message.
  behaviour.set = (options) => options.fail({ data: 'write rejected by storage service', code: 200 })
  await assert.rejects(store.save(SETTINGS), (err) => {
    assert.match(err.message, /code=200/)
    assert.match(err.message, /write rejected by storage service/)
    assert.ok(!/undefined/.test(err.message), 'message must not leak undefined: ' + err.message)
    return true
  })
})

test('a bare string payload is reported, not dropped', async () => {
  behaviour.set = (options) => options.fail('disk full')
  await assert.rejects(store.save(SETTINGS), (err) => {
    assert.match(err.message, /disk full/)
    assert.match(err.message, /code=unknown/)
    assert.ok(!/undefined/.test(err.message))
    return true
  })
})

test('fail() with no arguments says unknown instead of undefined', async () => {
  behaviour.set = (options) => options.fail()
  await assert.rejects(store.save(SETTINGS), (err) => {
    assert.match(err.message, /storage write failed, code=unknown/)
    assert.ok(!/undefined/.test(err.message), 'message must not leak undefined: ' + err.message)
    return true
  })
})

test('the failure carries the key and the payload size that was attempted', async () => {
  behaviour.set = (options) => options.fail({ data: 'too large', code: 200 })
  await assert.rejects(store.save(SETTINGS), (err) => {
    assert.match(err.message, /key=nctalk\.settings/)
    assert.match(err.message, /\d+ chars/)
    return true
  })
})

test('a synchronous throw from storage.set is wrapped, not lost', async () => {
  behaviour.set = () => {
    throw new Error('storage not initialised')
  }
  await assert.rejects(store.save(SETTINGS), (err) => {
    assert.match(err.message, /storage write failed/)
    assert.match(err.message, /storage not initialised/)
    return true
  })
})

test('a missing storage API fails loudly on write', async () => {
  const original = storage.set
  delete storage.set
  try {
    await assert.rejects(store.save(SETTINGS), (err) => {
      assert.match(err.message, /unavailable/)
      return true
    })
  } finally {
    storage.set = original
  }
})

test('load still resolves defaults when the read fails', async () => {
  behaviour.get = (options) => options.fail({ data: 'io error', code: 202 })
  const settings = await store.load()
  assert.equal(settings.user, '')
  assert.equal(settings.pollInterval, 15000)
})

test('clearAll reports the same shapes', async () => {
  behaviour.clear = (options) => options.fail({ data: 'locked', code: 202 })
  await assert.rejects(store.clearAll(), (err) => {
    assert.match(err.message, /storage clear failed, code=202/)
    assert.match(err.message, /locked/)
    return true
  })
})

await run()
console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
