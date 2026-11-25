// Navigation invariants.
//
// Reported from the watch (0.2.13): tapping a conversation card and tapping 设置
// both did nothing — no transition, no error — while 刷新 on the same footer row
// worked. Those two handlers were the app's only `router.push` call sites;
// every transition that demonstrably lands (splash → index / setup / offline)
// uses `router.replace`. So `push` is treated as "may silently do nothing":
//
//   common/scripts/nav.js   replace (the only form that lands) → ask the
//                           router whether we got there → a toast if we did
//                           not, because a silent no-op and a frozen screen
//                           look identical on a watch.
//
// These checks pin the shape of that fix. The 0.2.13 sources fail them: they
// called router.push from pages/index and pages/settings with no verification
// and no fallback.
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

test('nav.js uses the one form that lands, and never pushes', () => {
  // 1.0.1 shipped push → wait → replace and the taps were still dead: a dropped
  // push still runs the page's onHide, so the "we left" flag hid the retry.
  // One form only, and it is the one every working transition already uses.
  assert.ok(!/router\.push\s*\(/.test(nav), 'nav still tries push')
  assert.ok(/router\.replace\(target\)/.test(nav), 'the transition must be a replace')
  assert.ok(/getState/.test(nav), 'the router itself has to say whether we left')
  // A transition that threw is proof it never happened; it must be reported
  // even when the page's own flags claim otherwise.
  assert.ok(/threw/.test(nav), 'a throwing replace has to be reported')
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
    assert.ok(/nav\.leave\(ROUTE\.home\)/.test(page), `pages/${name} must use nav.leave`)
    assert.ok(!/router\.back\(\)/.test(page), `pages/${name} still calls router.back() directly`)
  }
})

test('the chat page reads the fallback exactly once', () => {
  const onInit = scriptOf(chat, 'onInit')
  assert.ok(/pendingRoom/.test(onInit), 'chat must fall back to the handed-over room')
  assert.ok(/shared\.pendingRoom = null/.test(onInit), 'a stale room must not survive the entry')
})

console.log('navigation checks passed')
