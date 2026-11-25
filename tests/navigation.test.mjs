// Navigation invariants.
//
// `router.push` may silently do nothing on this firmware, and a landed transition
// does not always fire `onHide`. `common/scripts/nav.js` therefore walks a
// deferred ladder of forms, asks the router whether it arrived via
// `router.getState()`, and only then shows a toast. A silent no-op and a frozen
// screen look identical on a watch, so every attempt has to be observable.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const nav = read('../src/common/scripts/nav.js')
const index = read('../src/pages/index/index.ux')
const chat = read('../src/pages/chat/chat.ux')
const settings = read('../src/pages/settings/settings.ux')
const setup = read('../src/pages/setup/setup.ux')

const test = (name, fn) => {
  fn()
  console.log('  ok   ' + name)
}

const scriptOf = (page, name) => {
  const script = page.split('<script>')[1].split('</script>')[0]
  const start = script.indexOf('  ' + name + '(')
  assert.ok(start >= 0, `no ${name}() in the page script`)
  return script.slice(start, start + 700)
}

test('no page navigates with a bare push any more', () => {
  for (const [name, page] of [['index', index], ['chat', chat], ['settings', settings], ['setup', setup]]) {
    assert.ok(!/router\.push\s*\(/.test(page), `pages/${name} still calls router.push`)
  }
})

test('nav.js keeps a ladder of forms, all deferred out of the tap', () => {
  // 1.0.2 proved two things at once: the tap does reach the handler, and the
  // replace issued from inside that touch callback is dropped. pages/splash has
  // documented that same trap all along — it defers the replace by 30ms. The
  // ladder starts there and then varies exactly one thing per rung.
  assert.ok(/const LADDER = \[/.test(nav), 'the attempts have to be an explicit ladder')
  const firstAttempt = nav.indexOf('router.replace(target)')
  assert.ok(firstAttempt > 0, 'the first rung is the replace that splash proves')
  const beforeFirst = nav.slice(nav.indexOf('function navigate'), firstAttempt)
  assert.ok(/setTimeout/.test(beforeFirst), 'the first attempt must be deferred, not issued in the tap tick')
  // Each rung rules one variable out: params, then the form itself.
  assert.ok(/withParams: false/.test(nav), 'a params-less replace must be tried')
  assert.ok(/form: 'push'/.test(nav), 'the other form gets its turn, deferred')
  // The router is the only witness that comes from outside the page we leave.
  assert.ok(/getState/.test(nav), 'the router itself has to say whether we left')
  assert.ok(/now\.index !== before\.index/.test(nav), 'arrival is a route snapshot comparison')
  // A dead ladder still has to say so.
  assert.ok(/prompt\.showToast/.test(nav), 'a dead tap has to be visible')
})

test('nav.js says so on screen when both forms are dropped', () => {
  assert.ok(/prompt\.showToast/.test(nav), 'a dead tap has to be visible')
})

test('every page that navigates reports onHide and onDestroy', () => {
  for (const [name, page] of [['index', index], ['settings', settings]]) {
    assert.ok(/onHide\(\)\s*\{[^}]*leftPage\s*=\s*true/.test(page), `pages/${name} must set leftPage in onHide`)
    // A replaced page is destroyed, not hidden: without this the "did we leave?"
    // check would fire the toast right after a replace that worked.
    assert.ok(/onDestroy\(\)\s*\{[^}]*leftPage\s*=\s*true/.test(page), `pages/${name} must set leftPage in onDestroy`)
    assert.ok(/onShow\(\)\s*\{[^}]*leftPage\s*=\s*false/s.test(page), `pages/${name} must clear leftPage in onShow`)
  }
})

test('tapping a conversation hands the room over on both channels', () => {
  const openRoom = scriptOf(index, 'openRoom')
  assert.ok(/nav\.navigate\(/.test(openRoom), 'openRoom goes through nav')
  assert.ok(/token: room\.token/.test(openRoom), 'router params carry the token')
  assert.ok(/pendingRoom/.test(openRoom), 'the app-level fallback carries the token too')
})

test('pages reachable by a replace-fallback return to the list, not to nothing', () => {
  for (const [name, page] of [['chat', chat], ['settings', settings], ['setup', setup]]) {
    assert.ok(/nav\.leave\(ROUTE\.home/.test(page), `pages/${name} must use nav.leave`)
    assert.ok(!/router\.back\(\)/.test(page), `pages/${name} still calls router.back() directly`)
  }
})

test('nav.leave verifies back() and falls back to the replace', () => {
  // 1.0.7 shipped `getState().index > 0 → router.back()` and nothing else: the
  // chat page's 返回 became a silent no-op because the router still reported a
  // stack depth for a page that had been installed by a replace.
  const leave = nav.slice(nav.indexOf('export function leave'))
  assert.ok(/router\.back\(\)/.test(leave), 'back() is still the first choice')
  assert.ok(/router\.replace\(\{ uri: home \}\)/.test(leave), 'the replace has to remain the fallback')
  assert.ok(/arrivedHome\(/.test(leave), 'a dropped back() must be detected, not assumed')
  assert.ok(
    leave.indexOf('router.back()') < leave.indexOf('replaceHome()'),
    'back() is attempted before the replace fallback is spent'
  )
  assert.ok(/onFail/.test(leave), 'a page that cannot leave has to be told')
})

test('the chat page does not declare itself hidden before it has left', () => {
  // onHide() sets `visible` false; if the transition is then dropped the page is
  // still on screen but refuses every read, so 返回 looked dead twice over.
  const goBack = scriptOf(chat, 'goBack')
  assert.equal(/this\.onHide\(\)/.test(goBack), false, 'goBack must not call onHide()')
  assert.ok(/nav\.leave\(ROUTE\.home,/.test(goBack), 'goBack passes a failure callback')
  assert.ok(/this\.visible = true/.test(goBack), 'goBack restores visibility when the leave fails')
})

test('the chat page reads the fallback exactly once', () => {
  const onInit = scriptOf(chat, 'onInit')
  assert.ok(/pendingRoom/.test(onInit), 'chat must fall back to the handed-over room')
  assert.ok(/shared\.pendingRoom = null/.test(onInit), 'a stale room must not survive the entry')
})

console.log('navigation checks passed')
