// Layout invariants for the manual-login page.
//
// The bug this guards against: the input method is `position: absolute` at the
// bottom of the page, so it contributes nothing to layout. Reserving its space
// wrongly (or leaving a hidden-but-laid-out block in flow) pushes 下一个 / 完成
// under the keyboard, and because the page is taller than the screen it also
// becomes scrollable. These assertions are cheap and catch a regression without
// a watch on the desk.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const page = readFileSync(new URL('../src/pages/login/login.ux', import.meta.url), 'utf8')
const input = readFileSync(
  new URL('../src/components/InputMethod/InputMethod.ux', import.meta.url),
  'utf8'
)
const theme = readFileSync(new URL('../src/common/styles/theme.css', import.meta.url), 'utf8')

const test = (name, fn) => {
  fn()
  console.log('  ok   ' + name)
}

test('the two states are exclusive nodes, not hidden ones', () => {
  assert.match(page, /class="edit-panel" if="\{\{editing\}\}"/)
  assert.match(page, /class="layout" if="\{\{!editing\}\}"/)
  // `show` keeps a node in layout on this Vela build. It is fine for the error
  // strip (it has a reserved height), never for a whole state.
  assert.equal(/show="\{\{!?editing\}\}"/.test(page), false)
})

test('the actions come before the keyboard gap, so they sit above it', () => {
  const actions = page.indexOf('class="edit-actions"')
  const gap = page.indexOf('class="keyboard-gap"')
  const keyboard = page.indexOf('<input-method')
  assert.ok(actions > 0 && gap > actions, 'actions must be the block before the gap')
  assert.ok(keyboard > gap, 'the gap mirrors the keyboard, which stays last')
})

test('the gap matches the real keyboard height of both shapes', () => {
  const circleKeyboard = input.match(/screentype==='circle'[\s\S]{0,80}?height:\s*(\d+)px/)
  const rectKeyboard = input.match(/screentype==='rect'[\s\S]{0,80}?height:\s*(\d+)px/)
  assert.ok(circleKeyboard && rectKeyboard, 'input method heights must be readable')

  const gaps = [...page.matchAll(/\.keyboard-gap\s*\{[^}]*height:\s*(\d+)px/g)].map((m) =>
    Number(m[1])
  )
  assert.equal(gaps.length, 2, 'one gap for the base layout and one for the rect override')
  assert.ok(
    Math.max(...gaps) >= Number(circleKeyboard[1]),
    'circle gap must cover the 321px keyboard'
  )
  assert.ok(
    Math.min(...gaps) >= Number(rectKeyboard[1]),
    'rect gap must cover the 255px keyboard plus its candidate row'
  )
})

test('pages cannot scroll as a whole', () => {
  const block = theme.match(/\.app-page\s*\{[^}]*\}/)
  assert.ok(block, '.app-page must exist')
  assert.match(block[0], /overflow:\s*hidden/)
})

console.log('login layout checks passed')
