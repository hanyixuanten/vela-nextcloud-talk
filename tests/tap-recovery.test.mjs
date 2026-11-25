// A tap must never be swallowed by a state flag.
//
// A request that never settles (no callback, no error) used to leave `loading` /
// `receiving` true forever, turning 刷新 and 会话 into permanent no-ops. The rule
// both pages follow: a user-initiated read supersedes the one in flight (a
// generation token invalidates its answer), and a flag older than the api layer's
// timeout is released before it is consulted.
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

test('every button reports what it just did', () => {
  // With rooms already on screen there is no spinner, and a failure used to be
  // rendered inside the scroll, below the last card — invisible. 刷新 looked
  // dead. The header line is the one place that is always on screen.
  const refresh = methodOf(index, 'refresh')
  assert.ok(/this\.statusLine = this\.\$t\('index\.loading'\)/.test(refresh), 'the refresh must show it started')
  assert.ok(/index\.updated/.test(refresh), 'and that it finished')
  assert.ok(/✕ /.test(refresh), 'and that it failed')
  // A dropped transition is the same class of silence: the toast is not enough,
  // the line stays.
  const openRoom = methodOf(index, 'openRoom')
  assert.ok(/describeNavFailure/.test(openRoom), 'a failed navigation has to leave the router’s own answer on screen')
  assert.ok(/statusLine/.test(openRoom), 'and it goes in the same line')
})

console.log('tap recovery checks passed')
