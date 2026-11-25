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
    assert.ok(/nav\.leave\(ROUTE\.home\)/.test(page), `pages/${name} must use nav.leave`)
    assert.ok(!/router\.back\(\)/.test(page), `pages/${name} still calls router.back() directly`)
  }
})

test('the chat page reads the fallback exactly once', () => {
  const onInit = scriptOf(chat, 'onInit')
  assert.ok(/pendingRoom/.test(onInit), 'chat must fall back to the handed-over room')
  assert.ok(/shared\.pendingRoom = null/.test(onInit), 'a stale room must not survive the entry')
})

test('a dead ladder asks the router to open a dependency-free probe page', () => {
  // 1.0.3's toast proved the transition was issued and dropped but could not
  // say whether the calling context or the target page is at fault. A page that
  // carries nothing but text settles it on the device.
  assert.ok(/PROBE_URI = 'pages\/probe'/.test(nav), 'the fallback probe has to exist')
  const manifest = JSON.parse(read('../src/manifest.json'))
  assert.ok(manifest.router.pages['pages/probe'], 'the probe page must be routable')
  const probe = read('../src/pages/probe/probe.ux')
  assert.ok(!/<import name=/.test(probe), 'the probe must not import a component')
  const script = probe.split('<script>')[1].split('</script>')[0]
  const imports = script.match(/^import .*$/gm) || []
  assert.deepEqual(imports, ["import router from '@system.router'"], 'the probe may depend on the router only')
  // It is reached from a tap handler, so its own transition has to be deferred
  // for the same reason every other one is.
  assert.ok(/setTimeout\(/.test(script), 'the probe must defer its own replace')
})

console.log('navigation checks passed')
