// Run the chat page with a controllable server and Vela timers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import fmt from './.build/format.mjs'

const script = readFileSync(new URL('../src/pages/chat/chat.ux', import.meta.url), 'utf8')
  .split('<script>')[1].split('</script>')[0]
  .replace(/^import .*$/gm, '')
  .replace('export default', 'globalThis.page =')
const requests = []
const read = []
const timers = new Map()
let timerId = 0
const message = (id) => ({ id, message: '文字', timestamp: 100 })
const ids = (high, low) => Array.from({ length: high - low + 1 }, (_, i) => high - i)
const ctx = {
  fmt,
  state: {},
  store: { load: async () => ({ user: 'alice' }) },
  api: {
    configure() {},
    getMessages: (token, query) => new Promise((resolve, reject) => requests.push({ token, query, resolve, reject })),
    sendMessage: async () => message(100),
    markRead: async (token, id) => read.push(id)
  },
  setTimeout: (fn, delay) => (timers.set(++timerId, { fn, delay }), timerId),
  clearTimeout: (id) => timers.delete(id)
}
runInNewContext(script, ctx)
const scrollOffsets = []
const page = Object.assign(ctx.page, ctx.page.data, {
  token: 'tokA',
  $t: (key) => key,
  $element: (id) => {
    assert.equal(id, 'chat-scroll')
    return { scrollTo: ({ top }) => scrollOffsets.push(top) }
  }
})
const current = () => Array.from(page.messages, (row) => row.id)
const respond = (list, lastGiven = 0, notModified = false) => requests.at(-1).resolve({
  messages: list.map(message), lastGiven, notModified
})
const tick = () => {
  assert.equal(timers.size, 1)
  const [id, { fn }] = timers.entries().next().value
  timers.delete(id)
  fn()
}

page.onInit()
page.onShow()
await setImmediate()
assert.equal(requests[0].query.limit, 12)
respond(ids(60, 49).reverse(), 47)
await setImmediate()
assert.deepEqual(current(), ids(60, 49))
assert.deepEqual(read, [60])

const older = page.loadOlder()
assert.equal(requests.at(-1).query.lastKnownMessageId, 47, 'prefer the server cursor over a visible ID')
assert.equal(timers.size, 0)
assert.equal(page.loadOlder(), undefined, 'suppress a second read while pending')
respond(ids(46, 35), 35)
await older
assert.equal(timers.size, 0, 'pause polls while browsing history')
assert.equal(page.messages.length, 24)
const more = page.loadOlder()
respond(ids(34, 23)) // fall back to the minimum id if headers are unavailable
await more
assert.deepEqual(current(), ids(46, 23))
assert.equal(page.olderCursor, 23)
const fail = page.loadOlder()
requests.at(-1).reject(new Error('offline'))
await fail
assert.equal(page.error, 'offline')
assert.equal(page.olderCursor, 23)
const end = page.loadOlder()
respond([], 0, true)
await end
assert.equal(page.olderCursor, 0)
assert.deepEqual(read, [60], 'history does not update read markers')

const latest = page.loadInitial()
respond(ids(60, 49), 49)
await latest
assert.deepEqual(scrollOffsets, [0])
assert.equal(page.browsingHistory, false)
page.setDraft('hello')
await page.send()
assert.equal(current()[0], 100)
tick()
assert.equal(requests.at(-1).query.lastKnownMessageId, 60)
assert.equal(requests.at(-1).query.lookIntoFuture, true)
assert.equal(timers.size, 0, 'no next poll timer until the active request finishes')
respond([61, 62, 100], 100)
await setImmediate()
assert.deepEqual(current().slice(0, 4), [100, 62, 61, 60])
assert.equal(current().filter((id) => id === 100).length, 1)
tick()
respond(ids(112, 101), 112)
await setImmediate()
assert.equal(current().length, 24)
assert.equal(page.olderCursor, current().at(-1), 'recompute the history cursor after evicting old rows')
assert.equal(page.toView({ ...message(113), message: 'a'.repeat(511) + '🙂' }).text, 'a'.repeat(511) + '…')

tick()
page.onHide()
respond([113], 113)
await setImmediate()
assert.equal(timers.size, 0)
assert.equal(current()[0], 112)
assert.deepEqual(read, [60, 60, 100, 112], 'late replies after hide do not mark read')
console.log('  ok   chat page bounds history, resumes polling, and ignores background replies')
