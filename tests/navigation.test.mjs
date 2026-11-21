// Navigation invariants.
//
// Reported from the watch (0.2.13): tapping a conversation card and tapping 设置
// both did nothing — no transition, no error — while 刷新 on the same footer row
// worked. Those two handlers were the app's only `router.push` call sites;
// every transition that demonstrably lands (splash → index / setup / offline)
// uses `router.replace`. So `push` is treated as "may silently do nothing":
//
//   common/scripts/nav.js   push → verify via the page's onHide → replace →
//                           finally a toast, because a silent no-op and a
//                           frozen screen look identical on a watch.
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

test('nav.js pushes, verifies, then replaces', () => {
  const pushAt = nav.indexOf('router.push(target)')
  const replaceAt = nav.indexOf('router.replace(target)')
  assert.ok(pushAt > 0, 'push is still the first attempt')
  assert.ok(replaceAt > pushAt, 'replace is the fallback, after the push')
  // The skip condition is the page telling us it left; without it the retry
  // would fire on every successful push and double the navigation.
  assert.ok(/if \(vm\.leftPage\) return/.test(nav), 'the retry must be skipped once the page hid')
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
