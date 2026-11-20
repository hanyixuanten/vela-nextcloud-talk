// Layout invariants for the chat page.
//
// The bug this guards against: on this Vela build `show="false"` only hides a
// node, it still occupies its layout height. The chat page switched its two
// mutually exclusive states with `show`, so both were laid out at once:
//
//   title bar   70 (margin-top) + 72 (height) + 6 (margin-bottom)  = 148
//   input bars  2 x (8 + 58 + 40)                                  = 212
//   editor      150                                                = 150
//                                                                   -----
//                                                                   510 > 480
//
// `flex: 1` on the <scroll> then resolved to zero and the message list was
// squeezed into a horizontal sliver instead of a column of bubbles. Every
// visibility toggle on the page is therefore `if`, and the fixed blocks above
// the list have to leave it a usable height on both watch shapes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const chat = readFileSync(new URL('../src/pages/chat/chat.ux', import.meta.url), 'utf8')
const theme = readFileSync(new URL('../src/common/styles/theme.css', import.meta.url), 'utf8')
const manifest = JSON.parse(
  readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8')
)

const template = chat.split('<template>')[1].split('</template>')[0]
const style = chat.split('<style>')[1].split('</style>')[0]
// The shape conditionals delimit the per-screen overrides; the base rules are
// everything before the first one.
const parts = style.split(/\/\* if true: process\.env\.SHAPE === '(?:CIRCLE|RECT)' \*\//)
const baseStyle = parts[0]
const circleStyle = parts[1].split('/* endif */')[0]
const rectStyle = parts[2].split('/* endif */')[0]

const test = (name, fn) => {
  fn()
  console.log('  ok   ' + name)
}

// Last declaration wins, as in the shape overrides.
function size(...args) {
  const [selector, prop] = args.pop()
  // Escape the class name: `.bar` must not match `.reply-bar`.
  const rule = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  for (let i = args.length - 1; i >= 0; i--) {
    const rules = [...args[i].matchAll(rule)]
    if (!rules.length) continue
    const value = rules.at(-1)[1].match(new RegExp('(?:^|[;\\s])' + prop + ':\\s*(-?\\d+)px'))
    if (value) return Number(value[1])
  }
  throw new Error(`could not read ${prop} of ${selector}`)
}

// Height the fixed chrome takes on one screen, resolved the way the compiler
// would: base rule first, then the shape override on top.
function chrome(shapeStyle) {
  const bar =
    size(theme, baseStyle, circleStyle, rectStyle, ['.bar', 'height']) +
    size(baseStyle, shapeStyle, ['.bar', 'margin-top']) +
    size(baseStyle, shapeStyle, ['.bar', 'margin-bottom'])
  const input =
    size(baseStyle, shapeStyle, ['.inputbar', 'height']) +
    size(baseStyle, shapeStyle, ['.inputbar', 'margin-top']) +
    size(baseStyle, shapeStyle, ['.inputbar', 'margin-bottom'])
  return { bar, input }
}

test('the two states are exclusive nodes, not hidden ones', () => {
  assert.equal(template.includes('class="main" if="{{!editing}}"'), true, 'main must use if')
  assert.equal(template.includes('class="editor" if="{{editing}}"'), true, 'editor must use if')
})

test('no block on the chat page is toggled with show', () => {
  // `show` keeps the node in layout here. One 150px editor or one extra 106px
  // input bar is enough to starve the <scroll> of height, which is exactly the
  // squashed screenshot.
  const offenders = [...template.matchAll(/<[a-z-]+[^>]*\sshow="[^"]*"[^>]*>/g)].map((m) => m[0])
  assert.deepEqual(offenders, [], 'use if="{{...}}" instead of show="{{...}}"')
})

test('the message list keeps a usable height on both shapes', () => {
  const circle = chrome(circleStyle)
  const rect = chrome(rectStyle)
  const circleList = 480 - circle.bar - circle.input
  const rectList = 640 - rect.bar - rect.input

  assert.ok(circleList >= 180, `circle list is only ${circleList}px tall`)
  assert.ok(rectList >= 180, `rect list is only ${rectList}px tall`)
  // The chrome must fit on the screen at all; otherwise flex: 1 resolves to 0.
  assert.ok(circle.bar + circle.input < 480, 'circle chrome overflows the 480px screen')
  assert.ok(rect.bar + rect.input < 640, 'rect chrome overflows the 640px screen')
})

test('the sizes above assume the 480 design width', () => {
  assert.equal(manifest.config.designWidth, 480)
})

console.log('chat layout checks passed')
