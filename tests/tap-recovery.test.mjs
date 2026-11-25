// A tap must never be swallowed by a state flag.
//
// Reported from the watch on 1.0.1: 无法进入会话 and 刷新按钮不起作用 together.
// The navigation half is pinned in navigation.test.mjs. This file pins the other
// half — the two places where one unfinished request was able to turn a button
// into a permanent no-op:
//
//   pages/index  refresh() returned early while `loading` was true. A request
//                that never settled (fetch with no callback and no error) kept
//                that flag set for good, so every later tap on 刷新 did
//                nothing, with no spinner and no error.
//   pages/chat   receive() returned early while `receiving` was true. The same
//                unfinished request left the page on 正在加载… and refused
//                every later read, so the conversation never opened.
//
// The rule both pages now follow: a user-initiated read supersedes the request
// in flight (a generation token invalidates its answer), and a flag older than
// the api layer's own timeout is released before it is consulted. The 1.0.1
// sources fail every check below.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const index = read('../src/pages/index/index.ux')
const chat = read('../src/pages/chat/chat.ux')

const test = (name, fn) => {
  fn()
  console.log('  ok   ' + name)
}

const scriptOf = (page) => page.split('<script>')[1].split('</script>')[0]
const methodOf = (page, name) => {
  const script = scriptOf(page)
  const start = script.indexOf('  ' + name + '(')
  assert.ok(start >= 0, `no ${name}() in the page script`)
  const rest = script.slice(start)
  const end = rest.indexOf('\n  },\n')
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 1200)
}

test('tapping 刷新 always starts a new read', () => {
  const refresh = methodOf(index, 'refresh')
  assert.ok(!/if \(this\.loading\) return/.test(refresh), 'a stuck loading flag still swallows the tap')
  assert.ok(/fetchToken/.test(refresh), 'the new read has to invalidate the old answer')
  assert.ok(/1[0-9]{3}|1500/.test(refresh), 'only a double-tap should be debounced')
})

test('a superseded list answer cannot overwrite a newer one', () => {
  const refresh = methodOf(index, 'refresh')
  assert.ok(/const current = \(\) => token === this\.fetchToken/.test(refresh), 'answers are checked against the token')
  // Both handlers clear the spinner: a throw inside toView() would otherwise
  // leave the list loading forever.
  assert.equal(refresh.match(/this\.loading = false/g).length, 2, 'loading must be cleared on success and on failure')
})

test('a visible list page is never "busy" on arrival', () => {
  const onShow = methodOf(index, 'onShow')
  assert.ok(/this\.loading = false/.test(onShow), 'onShow must clear a flag left by a request that never answered')
})

test('the chat page releases a read that never answered', () => {
  assert.ok(/STALE_RECEIVE_MS = api\.REQUEST_TIMEOUT_MS \+ 5000/.test(chat), 'staleness is defined off the request timeout')
  const guard = methodOf(chat, 'releaseStaleReceive')
  assert.ok(/this\.receiving = false/.test(guard), 'the stuck flag has to be released')
  for (const name of ['receive', 'schedulePoll', 'onShow']) {
    assert.ok(/releaseStaleReceive\(\)/.test(methodOf(chat, name)), `${name}() must release a stale read before deciding`)
  }
})

test('a failed conversation read is tappable, not a dead end', () => {
  assert.ok(/if="\{\{!loading && error\}\}" @click="loadInitial"/.test(chat), 'the error placeholder has to retry on tap')
})

console.log('tap recovery checks passed')
