// Run the chat page with a controllable server and Vela timers.
//
// Ordering note (1.0.15): the list is oldest-first, so the newest message is the
// last array element and sits next to the input bar. Every expectation below is
// written in that order; the previous revision was newest-first.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import fmt from './.build/format.mjs'
import {
  splitRows, countRows, clipDisplay, trimLastChar, scaleName, FONT_METRICS, FONT_SCALES
} from './.build/textlayout.mjs'

const script = readFileSync(new URL('../src/pages/chat/chat.ux', import.meta.url), 'utf8')
  .split('<script>')[1].split('</script>')[0]
  // Multi-line `import { a, b } from '...'` blocks included: the page imports
  // the text-layout helpers, and a half-removed import is a SyntaxError.
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '')
  .replace('export default', 'globalThis.page =')
const requests = []
const read = []
const sends = []
const toasts = []
const navigations = []
let sendFailure = false
const mutations = []
const mutate = (counts) => mutations.at(-1).resolve(counts)
const timers = new Map()
let timerId = 0
// The page defers one scroll-to-bottom retry per load (SCROLL_RETRY_MS). It is
// not a poll, so the helpers below keep it out of the poll accounting instead of
// teaching every assertion about it.
const SCROLL_RETRY_MS = 200
const message = (id) => ({ id, message: '文字', timestamp: 100, isReplyable: true })
const ids = (high, low) => Array.from({ length: high - low + 1 }, (_, i) => high - i)
const ascending = (high, low) => ids(high, low).reverse()
const ctx = {
  fmt,
  splitRows,
  countRows,
  clipDisplay,
  trimLastChar,
  scaleName,
  FONT_METRICS,
  FONT_SCALES,
  // The page logs its layout probe and its stale-read releases; on the watch
  // those go to the device log, here they would only pollute the test output.
  console: { log() {} },
  state: {},
  // No $app in this sandbox, so sharedOf() falls back to the page-local cache,
  // exactly as it does on a firmware without $def.
  sharedOf: (vm, fallback) => fallback,
  nav: { leave() {}, navigate(vm, uri, params) { navigations.push({ uri, params }) } },
  ROUTE: { home: 'pages/index', chat: 'pages/chat', message: 'pages/message' },
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
  // The page only ever reaches for the scroll container (scrollTo when it jumps
  // to the newest message or back to the top of history). Anything else is a bug
  // in the page, not a stub to fill in, so it stays undefined.
  $element: (id) => (id === 'chat-scroll'
    ? { scrollTo: ({ top }) => scrollOffsets.push(top) }
    : undefined)
})
const current = () => Array.from(page.messages, (row) => row.id)
const respond = (list, lastGiven = 0, notModified = false) => requests.at(-1).resolve({
  messages: list.map(message), lastGiven, notModified
})
const pollTimers = () => [...timers.entries()].filter(([, timer]) => timer.delay !== SCROLL_RETRY_MS)
const tick = () => {
  const pending = pollTimers()
  assert.equal(pending.length, 1, 'exactly one poll timer')
  const [id, { fn }] = pending[0]
  timers.delete(id)
  fn()
}

page.onInit()
page.onShow()
await setImmediate()
assert.equal(requests[0].query.limit, 12)
respond(ascending(60, 49), 49)
await setImmediate()
// Oldest first: 49 … 60, with 60 closest to the input bar.
assert.deepEqual(current(), ascending(60, 49))
assert.deepEqual(read, [60])
assert.equal(scrollOffsets.at(-1), 100000, 'a latest load jumps to the bottom of the list')

const older = page.loadOlder()
assert.equal(requests.at(-1).query.lastKnownMessageId, 49, 'prefer the server cursor over a visible ID')
assert.equal(pollTimers().length, 0)
assert.equal(page.loadOlder(), undefined, 'suppress a second read while pending')
respond(ids(48, 37), 37)
await older
assert.equal(pollTimers().length, 0, 'pause polls while browsing history')
// 12 fetched + 12 already on screen, but the window keeps the OLDEST 16 rows.
assert.equal(page.messages.length, 16)
assert.deepEqual(current(), ascending(52, 37))
const more = page.loadOlder()
respond(ids(36, 25)) // fall back to the minimum id if headers are unavailable
await more
assert.deepEqual(current(), ascending(40, 25))
assert.equal(page.olderCursor, 25)
const fail = page.loadOlder()
requests.at(-1).reject(new Error('offline'))
await fail
assert.equal(page.error, 'offline')
assert.equal(page.olderCursor, 25)
const end = page.loadOlder()
respond([], 0, true)
await end
assert.equal(page.olderCursor, 0)
assert.deepEqual(read, [60], 'history does not update read markers')

const latest = page.loadInitial()
respond(ids(60, 49), 49)
await latest
assert.equal(scrollOffsets.at(-1), 100000, 'back to latest scrolls to the newest row')
assert.equal(page.browsingHistory, false)
page.setDraft('hello')
await page.send()
assert.equal(current().at(-1), 100, 'a sent message is the last (newest) row')
tick()
assert.equal(requests.at(-1).query.lastKnownMessageId, 60)
assert.equal(requests.at(-1).query.lookIntoFuture, true)
assert.equal(pollTimers().length, 0, 'no next poll timer until the active request finishes')
respond([61, 62, 100], 100)
await setImmediate()
assert.deepEqual(current().slice(-4), [60, 61, 62, 100])
assert.equal(current().filter((id) => id === 100).length, 1)
tick()
respond(ids(112, 101), 112)
await setImmediate()
assert.equal(current().length, 16)
assert.equal(page.olderCursor, current()[0], 'recompute the history cursor after evicting old rows')
assert.equal(page.toView({ ...message(113), message: 'a'.repeat(1999) + '🙂' }).text, 'a'.repeat(1999) + '…')

tick()
page.onHide()
respond([113], 113)
await setImmediate()
assert.equal(pollTimers().length, 0)
assert.equal(current().at(-1), 112)
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
assert.deepEqual(current(), [112, 114])
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
assert.equal(pollTimers().length, 1)
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

// ------------------------------------------------ long messages: preview + detail
// The bubble is a four-row preview; anything longer gets a 展开全文 line that
// opens pages/message with the full text. The split is estimated, so these are
// the properties that matter: never an empty array, no row wildly over budget,
// newlines preserved, four rows max with an ellipsis, and a `more` flag exactly
// when the text needs more rows than the preview shows.
const CJK = '字'
const latin = 'abcdefghij'
// Rows come from the page's VM realm, so compare copies, not the arrays.
const rowsOf = (text) => Array.from(page.toView({ id: 900, message: text, timestamp: 1 }).rows)
const moreOf = (text) => page.toView({ id: 900, message: text, timestamp: 1 }).more

const short = rowsOf('文字')
assert.equal(short.length, 1, 'a short message is one row')
assert.equal(short[0], '文字')
assert.equal(moreOf('文字'), false, 'a short message needs no 展开全文')

const long = rowsOf(CJK.repeat(120))
assert.ok(long.length > 1, 'a 120-glyph message wraps')
assert.ok(long.length <= 4, 'no message previews more than 4 rows (four template slots)')
for (const row of long) assert.ok(Array.from(row).length <= 16, `row too wide: ${row}`)
assert.equal(moreOf(CJK.repeat(120)), true, 'a long message offers 展开全文')

const latinRows = rowsOf(latin.repeat(10))
assert.ok(latinRows.length > 1, 'latin text wraps too')

const newlines = rowsOf('第一行\n第二行')
assert.deepEqual(newlines, ['第一行', '第二行'], 'an explicit newline starts a new row')

const capped = rowsOf(CJK.repeat(400))
assert.equal(capped.length, 4, 'a huge message is capped at 4 preview rows')
assert.ok(capped[3].endsWith('…'), 'the capped row says it was cut')
console.log('  ok   the message body is a four-row preview with a 展开全文 affordance')

// The detail page is opened from that line and must receive the full text (not
// the preview), plus the shared fallback the params-less ladder rung needs.
page.onShow()
await setImmediate()
page.selectMessage(114)
page.openDetail(114)
const nav = navigations.at(-1)
assert.equal(nav.uri, 'pages/message')
assert.equal(nav.params.text, '文字')
assert.equal(typeof nav.params.meta, 'string')
console.log('  ok   the 展开全文 line opens pages/message with the full text')
