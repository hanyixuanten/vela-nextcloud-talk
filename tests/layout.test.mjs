// Static layout invariants for the watch pages.
//
// Vela resolves percentages and visibility differently from the CSS spec, and
// every rule below exists because a release got it wrong:
//
//   .app-page  position: relative      -> children stop receiving a definite width
//   .app-bg    width/height: 100%      -> falls back to the 256px bitmap, glow in one corner
//   <scroll>    width: 100%            -> no basis to resolve against, cards collapse
//   any block   show="..."             -> hidden node still occupies its height
//
// The bottom of a page is a fixed budget (480 on the round screen, 640 on the
// rect one), so the chrome above a <scroll> is measured instead of eyeballed.
// These checks are the only way to catch such a regression without a watch on
// the desk, so they read the page sources as text and never run the runtime.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const theme = read('../src/common/styles/theme.css')
const manifest = JSON.parse(read('../src/manifest.json'))
const pages = {
  index: read('../src/pages/index/index.ux'),
  chat: read('../src/pages/chat/chat.ux'),
  settings: read('../src/pages/settings/settings.ux'),
  login: read('../src/pages/login/login.ux'),
  setup: read('../src/pages/setup/setup.ux'),
  offline: read('../src/pages/offline/offline.ux')
}
const inputMethod = read('../src/components/InputMethod/InputMethod.ux')

const test = (name, fn) => {
  fn()
  console.log('  ok   ' + name)
}

const templateOf = (page) => page.split('<template>')[1].split('</template>')[0]

// Pages carry their per-shape overrides between compiler markers; the base
// rules are everything before the first one.
function shapes(style) {
  const parts = style.split(/\/\* if true: process\.env\.SHAPE === '(?:CIRCLE|RECT)' \*\//)
  return {
    base: parts[0],
    circle: parts[1] ? parts[1].split('/* endif */')[0] : '',
    rect: parts[2] ? parts[2].split('/* endif */')[0] : ''
  }
}

// Every declaration block of one selector, base rule and overrides alike.
function blocks(css, selector) {
  const pattern = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  return [...css.matchAll(pattern)].map((match) => match[1])
}

// Last declaration wins, as when the shape overrides are compiled on top.
function size(...args) {
  const [selector, prop] = args.pop()
  const pattern = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  for (let i = args.length - 1; i >= 0; i--) {
    const rules = [...args[i].matchAll(pattern)]
    if (!rules.length) continue
    const value = rules.at(-1)[1].match(new RegExp('(?:^|[;\\s])' + prop + ':\\s*(-?\\d+)px'))
    if (value) return Number(value[1])
  }
  throw new Error(`could not read ${prop} of ${selector}`)
}

function assertPixelWidth(css, selector, label) {
  const found = blocks(css, selector)
  assert.ok(found.length > 0, `${label}: ${selector} must be styled`)
  for (const block of found) {
    const value = block.match(/width:\s*([^;]+);/)
    if (!value) continue
    assert.match(
      value[1].trim(),
      /^\d+px$/,
      `${label}: ${selector} width must be design pixels, got ${value[1].trim()}`
    )
  }
}

test('the page root keeps a definite width for its children', () => {
  // A positioned root stops handing a definite width down, which is what made
  // the glow fall back to the bitmap size and every percentage collapse.
  const root = blocks(theme, '.app-page')
  assert.equal(root.length, 1, 'exactly one .app-page rule')
  assert.equal(/position:\s*(relative|absolute)/.test(root[0]), false, '.app-page must stay static')
  assert.match(root[0], /width:\s*100%;/)
  assert.match(root[0], /height:\s*100%;/)
  assert.match(root[0], /overflow:\s*hidden/)
})

test('the background glow is sized in pixels and uses a Vela object-fit value', () => {
  const glow = blocks(theme, '.app-bg')
  assert.equal(glow.length, 1, 'exactly one base .app-bg rule')
  assert.match(glow[0], /width:\s*480px;/, '480px is the design width')
  assert.match(glow[0], /height:\s*480px;/, 'the round screen is 480x480')
  assert.equal(/(?:width|height):\s*[^;]*%/.test(glow[0]), false, 'percentages do not resolve here')

  const fit = glow[0].match(/object-fit:\s*([a-z-]+);/)
  assert.ok(fit, '.app-bg must set object-fit explicitly')
  assert.ok(
    ['contain', 'cover', 'none', 'scale-down'].includes(fit[1]),
    `object-fit: ${fit[1]} is not accepted by Vela`
  )
})

test('every page with a glow grows it for the taller rect screen', () => {
  for (const [name, page] of Object.entries(pages)) {
    if (!page.includes('class="app-bg"')) continue
    const rect = page.match(/SHAPE === 'RECT' \*\/([\s\S]*?)\/\* endif \*\//)
    assert.ok(rect, `${name}: page must have a RECT block`)
    assert.match(rect[1], /\.app-bg\s*\{[^}]*height:\s*\d+px/, `${name}: RECT block must grow .app-bg`)
  }
})

test('no page hides a block with show', () => {
  // `show` keeps the node in layout. One hidden state or placeholder block is
  // enough to starve a `flex: 1` scroll of its height.
  for (const name of ['index', 'chat']) {
    const offenders = [...templateOf(pages[name]).matchAll(/<[a-z-]+[^>]*\sshow="[^"]*"[^>]*>/g)]
    assert.deepEqual(offenders.map((m) => m[0]), [], `${name}: use if="{{...}}" instead of show`)
  }
  // The login page keeps one reserved-height error strip; its two states are
  // still exclusive nodes.
  assert.match(pages.login, /class="edit-panel" if="\{\{editing\}\}"/)
  assert.match(pages.login, /class="layout" if="\{\{!editing\}\}"/)
  assert.equal(/show="\{\{!?editing\}\}"/.test(pages.login), false)
})

test('the chat page switches its two states with if', () => {
  const template = templateOf(pages.chat)
  assert.equal(template.includes('class="main" if="{{!editing}}"'), true, 'main must use if')
  assert.equal(template.includes('class="editor" if="{{editing}}"'), true, 'editor must use if')
})

test('scroll content and the cards inside it are design pixels', () => {
  const { base, circle, rect } = shapes(pages.chat.split('<style>')[1].split('</style>')[0])
  const index = shapes(pages.index.split('<style>')[1].split('</style>')[0])

  // 480 is the design width; a percentage there is what collapsed every card.
  assert.equal(size(base, circle, ['.list', 'width']), 480)
  assert.equal(size(index.base, index.circle, ['.list', 'width']), 480)
  assertPixelWidth(pages.chat, '.msg', 'chat')
  assert.equal(size(index.base, index.circle, ['.room', 'width']), 394)
  assert.equal(size(index.base, index.rect, ['.room', 'width']), 413)
  assertPixelWidth(pages.settings, '.row', 'settings')
})

test('the chat list keeps a usable height on both shapes', () => {
  const { base, circle, rect } = shapes(pages.chat.split('<style>')[1].split('</style>')[0])
  const chrome = (shapeStyle) => {
    const bar =
      size(theme, base, circle, rect, ['.bar', 'height']) +
      size(base, shapeStyle, ['.bar', 'margin-top']) +
      size(base, shapeStyle, ['.bar', 'margin-bottom'])
    const input =
      size(base, shapeStyle, ['.inputbar', 'height']) +
      size(base, shapeStyle, ['.inputbar', 'margin-top']) +
      size(base, shapeStyle, ['.inputbar', 'margin-bottom'])
    return bar + input
  }

  assert.ok(480 - chrome(circle) >= 180, `circle list is only ${480 - chrome(circle)}px tall`)
  assert.ok(640 - chrome(rect) >= 180, `rect list is only ${640 - chrome(rect)}px tall`)
  // The chrome has to fit at all, otherwise flex: 1 resolves to zero.
  assert.ok(chrome(circle) < 480, 'circle chrome overflows the 480px screen')
  assert.ok(chrome(rect) < 640, 'rect chrome overflows the 640px screen')
})

test('the conversation list keeps a usable height on both shapes', () => {
  const { base, circle, rect } = shapes(pages.index.split('<style>')[1].split('</style>')[0])
  const pill = size(theme, ['.pill-small', 'height'])
  for (const [shape, shapeStyle, screen] of [
    ['circle', circle, 480],
    ['rect', rect, 640]
  ]) {
    const head = size(theme, base, shapeStyle, ['.head', 'height'])
    const footer = pill + size(base, shapeStyle, ['.footer', 'margin-bottom'])
    assert.ok(screen - head - footer >= 180, `${shape} list is only ${screen - head - footer}px tall`)
  }
})

test('the login actions sit above a gap as tall as the keyboard', () => {
  const actions = pages.login.indexOf('class="edit-actions"')
  const gap = pages.login.indexOf('class="keyboard-gap"')
  const keyboard = pages.login.indexOf('<input-method')
  assert.ok(actions > 0 && gap > actions, 'actions must be the block before the gap')
  assert.ok(keyboard > gap, 'the gap mirrors the keyboard, which stays last')

  const circleKeyboard = inputMethod.match(/screentype==='circle'[\s\S]{0,80}?height:\s*(\d+)px/)
  const rectKeyboard = inputMethod.match(/screentype==='rect'[\s\S]{0,80}?height:\s*(\d+)px/)
  assert.ok(circleKeyboard && rectKeyboard, 'input method heights must be readable')

  const gaps = [...pages.login.matchAll(/\.keyboard-gap\s*\{[^}]*height:\s*(\d+)px/g)].map((m) =>
    Number(m[1])
  )
  assert.equal(gaps.length, 2, 'one gap for the base layout and one for the rect override')
  assert.ok(Math.max(...gaps) >= Number(circleKeyboard[1]), 'circle gap must cover the 321px keyboard')
  assert.ok(Math.min(...gaps) >= Number(rectKeyboard[1]), 'rect gap must cover the 255px keyboard')
})

test('the pixel sizes above assume the 480 design width', () => {
  assert.equal(manifest.config.designWidth, 480)
})

console.log('layout checks passed')
