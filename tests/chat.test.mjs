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
const sends = []
const toasts = []
let sendFailure = false
const mutations = []
const mutate = (counts) => mutations.at(-1).resolve(counts)
const timers = new Map()
let timerId = 0
const message = (id) => ({ id, message: '文字', timestamp: 100, isReplyable: true })
const ids = (high, low) => Array.from({ length: high - low + 1 }, (_, i) => high - i)
const ctx = {
  fmt,
  state: {},
  // No $app in this sandbox, so sharedOf() falls back to the page-local cache,
  // exactly as it does on a firmware without $def.
  sharedOf: (vm, fallback) => fallback,
  nav: { leave() {} },
  ROUTE: { home: 'pages/index', chat: 'pages/chat' },
  prompt: { showToast: ({ message }) => toasts.push(message) },
  store: { load: async () => ({ user: 'alice' }) },
  api: {
    REQUEST_TIMEOUT_MS: 20000,
    configure() {},
    getMessages: (token, query) => new Promise((resolve, reject) => requests.push({ token, query, resolve, reject })),
    sendMessage: async (token, text, replyTo) => {
      sends.push({ token, text, replyTo })
      if (sendFailure) throw new Error('offline')
      return message(replyTo ? 114 : 100)
    },
    setReaction: (token, id, emoji, active) => new Promise((resolve, reject) =>
      mutations.push({ args: [token, id, emoji, active], resolve, reject })),
    markRead: async (token, id) => read.push(id)
  },
  setTimeout: (fn, delay) => (timers.set(++timerId, { fn, delay }), timerId),
  clearTimeout: (id) => timers.delete(id)
}
runInNewContext(script, ctx)
const scrollOffsets = []
// The page declares its state under `private`, not `data`: a page VM may not
// carry `data` and `protected` at the same time (see chat.ux), and `protected`
// is how the room arrives.
const page = Object.assign(ctx.page, ctx.page.private, {
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
assert.deepEqual(sends, [{ token: 'tokA', text: 'hello', replyTo: undefined }])

page.onShow()
await setImmediate()
const replyHistory = page.loadOlder()
requests.at(-1).resolve({ messages: [
  { ...message(48), message: '  first\n' + 'x'.repeat(41) + '🙂tail' },
  { ...message(47), isReplyable: false },
  { ...message(46), systemMessage: 'user_added' }
], lastGiven: 46 })
await replyHistory
for (const id of [999, 47, 46]) page.selectReply(id)
assert.equal(page.replyId, 0)
page.selectReply(48)
assert.equal(page.replySummary, 'first ' + 'x'.repeat(41) + '…')
assert.equal(page.editing, false, 'long press selects without opening the keyboard')
page.startReply()
page.setDraft(' got it ')
page.clearReply()
assert.equal(page.replySummary, '')
assert.equal(page.draft, ' got it ')
assert.equal(page.editing, false, 'canceling the quote returns to read-only history')
page.selectReply(48)
page.startReply()
sendFailure = true
const failedReply = page.send()
page.clearReply()
assert.equal(page.send(), undefined, 'ignore a second tap while sending')
await failedReply
assert.deepEqual(toasts, ['offline'])
assert.equal(page.replyId, 48)
assert.equal(page.draft, ' got it ')
assert.equal(page.editing, true)
assert.equal(sends.length, 2, 'failed replies are not automatically resent')
sendFailure = false
await page.send()
assert.equal(page.replyId, 0)
assert.equal(page.draft, '')
assert.deepEqual(sends.slice(1), [
  { token: 'tokA', text: 'got it', replyTo: 48 },
  { token: 'tokA', text: 'got it', replyTo: 48 }
])
assert.equal(requests.at(-1).query.lastKnownMessageId, 0, 'a successful history reply returns to the latest page')
respond([114, 112], 112)
await setImmediate()
assert.deepEqual(current(), [114, 112])
assert.equal(page.browsingHistory, false)
console.log('  ok   quote selection is bounded and reply failures preserve the draft for manual retry')

const visibleRow = () => page.messages.find((row) => row.id === 114)
page.selectMessage(114)
assert.equal(page.actionId, 114)
assert.equal(page.replyId, 0, 'long press opens actions but does not select a reply')
page.openPicker()
assert.deepEqual(Array.from(page.pickerChoices, (item) => item.label), ['👍', '❤️', '😂'])
assert.equal(page.toggleReaction('💤'), undefined)
const add = page.toggleReaction('👍')
assert.deepEqual(mutations.at(-1).args, ['tokA', 114, '👍', true])
assert.equal(page.pollOnce(), undefined, 'no concurrent read during a reaction mutation')
assert.equal(page.toggleReaction('👍'), undefined)
mutate({ '👍': 100, '💤': 400 })
await add
assert.equal(visibleRow().reactionSummary, '👍•99+')
assert.equal(timers.size, 1)
page.selectMessage(114)
page.openPicker()
assert.equal(page.pickerChoices[0].label, '👍−')
const remove = page.toggleReaction('👍')
assert.deepEqual(mutations.at(-1).args, ['tokA', 114, '👍', false])
mutations.at(-1).reject(new Error('read only'))
await remove
assert.equal(visibleRow().reactionSummary, '👍•99+')
assert.equal(toasts.at(-1), 'read only')
page.selectMessage(114)
page.openPicker()
const retry = page.toggleReaction('👍')
mutate({})
await retry
assert.equal(visibleRow().reactionSummary, '')
assert.equal(visibleRow().reactionMask, 0)

const before = current()
const readsBefore = read.length
const pollReactions = page.pollOnce()
requests.at(-1).resolve({ messages: [
  { id: 116, systemMessage: 'reaction_revoked', parent: { id: 114, reactions: { '❤️': 2 } } },
  { id: 115, systemMessage: 'reaction', parent: { id: 114, reactions: { '👍': 1 }, reactionsSelf: ['👍'] } },
  { id: 117, systemMessage: 'reaction_deleted', parent: { id: 999, deleted: true } }
], lastGiven: 117 })
await pollReactions
assert.deepEqual(current(), before, 'reaction events do not occupy message slots')
assert.equal(read.length, readsBefore)
assert.equal(visibleRow().reactionSummary, '❤️2')
assert.equal(visibleRow().text, '文字')
tick()
assert.equal(requests.at(-1).query.lastKnownMessageId, 117)
respond([], 0, true)
await setImmediate()
page.selectMessage(114)
page.replyToSelection()
assert.equal(page.replyId, 114)
assert.equal(page.editing, true)
page.onHide()
console.log('  ok   watch adds, removes and syncs bounded reactions without inserting event rows')
