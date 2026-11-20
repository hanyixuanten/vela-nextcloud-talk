// Layout invariants for the conversation list.
//
// The same family of bug as the chat page: on this Vela build `show="false"`
// hides a node but leaves it in layout, and a percentage width inside a
// <scroll> has no basis to resolve against.
//
// What the 0.2.5 package did:
//
//   .list { width: 100% }      inside <scroll>  → no definite width, so every
//                              .room card (and its avatars/text) collapsed.
//                              Reported from the watch as a squashed strip.
//   .empty { show=... }        3 placeholders  → ~300px of hidden blocks
//                              appended after the last card, scrollable into.
//   .badge { show=... }        hidden badge kept its 30px and pushed the
//                              timestamp out of its row.
//
// So: no `show` anywhere on this page, list and cards in design pixels, and the
// fixed chrome above the list must leave it a usable height on both shapes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const page = read('../src/pages/index/index.ux')
const theme = read('../src/common/styles/theme.css')
const manifest = JSON.parse(read('../src/manifest.json'))

const template = page.split('<template>')[1].split('</template>')[0]
const style = page.split('<style>')[1].split('</style>')[0]
const parts = style.split(/\/\* if true: process\.env\.SHAPE === '(?:CIRCLE|RECT)' \*\//)
const baseStyle = parts[0]
const circleStyle = parts[1].split('/* endif */')[0]
const rectStyle = parts[2].split('/* endif */')[0]

const test = (name, fn) => {
  fn()
  console.log('  ok   ' + name)
}

function size(...args) {
  const [selector, prop] = args.pop()
  const rule = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  for (let i = args.length - 1; i >= 0; i--) {
    const rules = [...args[i].matchAll(rule)]
    if (!rules.length) continue
    const value = rules.at(-1)[1].match(new RegExp('(?:^|[;\\s])' + prop + ':\\s*(-?\\d+)px'))
    if (value) return Number(value[1])
  }
  throw new Error(`could not read ${prop} of ${selector}`)
}

test('nothing on the list page is toggled with show', () => {
  const offenders = [...template.matchAll(/<[a-z-]+[^>]*\sshow="[^"]*"[^>]*>/g)].map((m) => m[0])
  assert.deepEqual(offenders, [], 'use if="{{...}}" instead of show="{{...}}"')
})

test('the scroll content and the cards are design pixels', () => {
  // Resolved per shape: base rule, then that shape's override. `.room` is 394
  // on the round watch and 413 on the rect one; `.list` is the 480 design width
  // on both (a percentage there is what collapsed every card).
  assert.equal(size(baseStyle, circleStyle, ['.list', 'width']), 480)
  assert.equal(size(baseStyle, rectStyle, ['.list', 'width']), 480)
  assert.equal(size(baseStyle, circleStyle, ['.room', 'width']), 394)
  assert.equal(size(baseStyle, rectStyle, ['.room', 'width']), 413)
})

test('the list keeps a usable height on both shapes', () => {
  // Chrome = headline block + the footer (one small pill above the bottom
  // margin). Everything else is the scrolling area.
  const pill = size(theme, ['.pill-small', 'height'])
  for (const [shape, shapeStyle, screen] of [
    ['circle', circleStyle, 480],
    ['rect', rectStyle, 640]
  ]) {
    const head = size(theme, baseStyle, shapeStyle, ['.head', 'height'])
    const footer = pill + size(baseStyle, shapeStyle, ['.footer', 'margin-bottom'])
    const list = screen - head - footer
    assert.ok(list >= 180, `${shape} list is only ${list}px tall`)
  }
})

test('the sizes above assume the 480 design width', () => {
  assert.equal(manifest.config.designWidth, 480)
})

console.log('index layout checks passed')
