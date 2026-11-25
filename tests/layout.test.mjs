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
  message: read('../src/pages/message/message.ux'),
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
  // The list card's texts are design pixels too: `width: 100%` inside a flex
  // card is the same family of bug that left the chat body 0 tall.
  for (const selector of ['.room-name', '.room-preview']) {
    assert.equal(size(index.base, index.circle, [selector, 'width']), 200, `circle ${selector}`)
    assert.equal(size(index.base, index.rect, [selector, 'width']), 219, `rect ${selector}`)
  }
  assertPixelWidth(pages.settings, '.row', 'settings')
  // Settings hides 9 rows under a 480px screen: it needs the same fixed-height
  // scroll as the other two lists, or the rows get squeezed instead of scrolling.
  const sSettings = shapes(pages.settings.split('<style>')[1].split('</style>')[0])
  assert.equal(size(sSettings.base, sSettings.circle, ['.scroll', 'height']), 480 - size(theme, ['.bar', 'height']))
  assert.equal(size(sSettings.base, sSettings.rect, ['.scroll', 'height']), 640 - size(theme, ['.bar', 'height']))
})

test('boolean component props are bound, never passed as strings', () => {
  // `small="true"` hands the prop the *string* "true", and the framework logs a
  // type-validation failure for every render: "app-pill props中的：small
  // type类型验证失败，期望类型为Boolean". The declaration stays strict Boolean on
  // purpose - the binding form is what has to be right.
  for (const [name, page] of Object.entries(pages)) {
    const offenders = [...templateOf(page).matchAll(/\b(small|primary|busy|disabled)="true"/g)]
    assert.deepEqual(offenders.map((m) => m[0]), [], `${name}: boolean props must use {{true}}`)
  }
})

test('the chat list gets an explicit pixel height, never flex: 1', () => {
  // The scrolling bug in one line: `<scroll style="flex: 1">` this firmware
  // resolves the viewport and then shrinks the content into it, so the list can
  // never overflow and every bubble is compressed (a compressed text measures 0
  // tall). HyperBilibili's .scroll is width/height of a fixed page, and that is
  // the shape that scrolls. So the height is the leftover budget, in pixels.
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

  for (const [shape, shapeStyle, screen] of [
    ['circle', circle, 480],
    ['rect', rect, 640]
  ]) {
    const declared = size(base, shapeStyle, ['.scroll', 'height'])
    assert.equal(declared, screen - chrome(shapeStyle), `${shape}: scroll height must be the leftover budget`)
    assert.ok(chrome(shapeStyle) < screen, `${shape}: chrome overflows the screen`)
  }
  for (const block of blocks(base, '.scroll')) {
    assert.doesNotMatch(block, /flex:/, '.scroll must not be sized by flex')
  }
})

test('the chat bubbles wrap: a body of single-line row slots, no height, no nested for', () => {
  // The body is one fixed-width `lines: 1` text per visual row (textlayout.js
  // splitRows), rendered as four hand-indexed preview slots. Rows were born while
  // chasing the "flat strip" reports — the real cause turned out to be the scroll
  // box (see the explicit-height test above), but the row shape is what is
  // verified on the device, so it stays, and the bubble height follows the row
  // count. Anything past the preview lives on pages/message (展开全文).
  const { base, circle, rect } = shapes(pages.chat.split('<style>')[1].split('</style>')[0])
  for (const [shape, shapeStyle, bubble] of [
    ['circle', circle, 394],
    ['rect', rect, 413]
  ]) {
    assert.equal(size(base, shapeStyle, ['.msg', 'width']), bubble, `${shape}: bubble width moved`)
    for (const selector of ['.msg-meta', '.msg-row-small', '.msg-row-normal', '.msg-row-large', '.msg-more', '.reaction-summary']) {
      const width = size(base, shapeStyle, [selector, 'width'])
      assert.equal(width, bubble - 32, `${shape}: ${selector} must be ${bubble - 32}px, got ${width}`)
    }
  }
  // The placeholders carry server messages ("加载失败：…"), which are just as
  // long as a chat message.
  for (const selector of ['.placeholder-hint', '.placeholder-error']) {
    assert.equal(size(base, circle, [selector, 'width']), 374, `${selector} must be 374px`)
  }
  // Every text in a bubble is a single line with an explicit height; the
  // multi-line default is what produced the zero-height body.
  for (const selector of ['.msg-meta', '.msg-row-small', '.msg-row-normal', '.msg-row-large', '.msg-more', '.reaction-summary']) {
    for (const block of blocks(base, selector)) {
      assert.match(block, /lines:\s*1;/, `${selector} must be a single-line text`)
    }
  }
  // A row has to be a *self-contained* copy of the shape that renders (meta):
  // width, side margins, lines and font-size in one block. Splitting the font
  // size into a second class left the row 343 wide and 0 tall (1.0.11).
  for (const [scale, fontSize] of [['small', 20], ['normal', 23], ['large', 27]]) {
    const variant = blocks(base, '.msg-row-' + scale)
    assert.equal(variant.length, 1, `.msg-row-${scale} must exist`)
    for (const rule of [/width:\s*362px/, /margin-left:\s*16px/, /font-size:\s*\d+px/, /lines:\s*1/, /color:/]) {
      assert.match(variant[0], rule, `.msg-row-${scale} is missing ${rule}`)
    }
    assert.match(variant[0], new RegExp(`font-size:\\s*${fontSize}px`), `.msg-row-${scale} is ${fontSize}px`)
    assert.doesNotMatch(variant[0], /height:/, `.msg-row-${scale} must not set a height`)
    assert.doesNotMatch(variant[0], /line-height:/, `.msg-row-${scale} must not set line-height`)
  }
  // Four fixed preview slots, not a nested for: two nested loops share the
  // `$idx` index key on this firmware and the inner one produced no children at
  // all.
  const template = templateOf(pages.chat)
  const slots = [...new Set([...template.matchAll(/\{\{ \$item\.rows\[(\d)\] \}\}/g)].map((m) => Number(m[1])))]
  assert.deepEqual(slots, [0, 1, 2, 3], 'the body renders four indexed preview row slots')
  // The truncation affordance has to be a real tap target that opens the full
  // text; a preview that silently eats the rest of the message is the bug this
  // replaced.
  assert.match(template, /class="msg-more [^"]*"[^>]*@click="openDetail\(\$item\.id\)"/, 'the 展开全文 line opens the detail page')
  assert.match(template, /if="\{\{ \$item\.more \}\}"/, 'the 展开全文 line only exists for clipped messages')
  assert.doesNotMatch(template, /for="\{\{ row in/, 'no nested for inside the message loop')
  assert.doesNotMatch(
    template,
    /class="msg-(row|text)[^"]*"[^>]*style=/,
    'the message text must take its font-size from a class, not an inline style'
  )
})

test('the full-message page is a fixed-height scroll with a pixel-width body', () => {
  // pages/message is the 展开全文 target: one message, unbounded length, so it is
  // the only page whose body text wraps naturally instead of being pre-split
  // into rows. Everything around it follows the same rules as the chat page —
  // definite pixel widths inside the scroll, and a scroll height that is the
  // leftover budget rather than `flex: 1` (which compresses instead of scrolling).
  const { base, circle, rect } = shapes(pages.message.split('<style>')[1].split('</style>')[0])
  const barChrome = (shapeStyle) =>
    size(theme, base, circle, rect, ['.bar', 'height']) +
    size(base, shapeStyle, ['.bar', 'margin-top']) +
    size(base, shapeStyle, ['.bar', 'margin-bottom'])

  for (const [shape, shapeStyle, screen] of [
    ['circle', circle, 480],
    ['rect', rect, 640]
  ]) {
    const declared = size(base, shapeStyle, ['.scroll', 'height'])
    assert.equal(declared, screen - barChrome(shapeStyle) - 16, `${shape}: detail scroll must be the leftover budget`)
  }
  for (const block of blocks(base, '.scroll')) {
    assert.doesNotMatch(block, /flex:/, 'the detail scroll must not be sized by flex')
  }
  assert.equal(size(base, circle, ['.list', 'width']), 480)
  assert.equal(size(base, circle, ['.card', 'width']), 394)
  assert.equal(size(base, rect, ['.card', 'width']), 413)
  for (const [scale, fontSize, bubbleText] of [
    ['small', 20, 362],
    ['normal', 23, 362],
    ['large', 27, 362]
  ]) {
    const selector = '.body-' + scale
    const rule = blocks(base, selector)
    assert.equal(rule.length, 1, `${selector} must exist exactly once in the base block`)
    // Same self-contained shape as a chat row: width and font size in one block.
    assert.match(rule[0], new RegExp('width:\\s*' + bubbleText + 'px'), `${selector} needs a pixel width`)
    assert.match(rule[0], new RegExp('font-size:\\s*' + fontSize + 'px'), `${selector} is ${fontSize}px`)
    assert.doesNotMatch(rule[0], /lines:/, `${selector} must not clamp lines: the whole message has to show`)
    assert.equal(size(base, rect, [selector, 'width']), 381, `rect ${selector}`)
  }
})

test('the conversation list gets an explicit pixel height too', () => {
  const { base, circle, rect } = shapes(pages.index.split('<style>')[1].split('</style>')[0])
  const pill = size(theme, ['.pill-small', 'height'])
  for (const [shape, shapeStyle, screen] of [
    ['circle', circle, 480],
    ['rect', rect, 640]
  ]) {
    const head = size(theme, base, shapeStyle, ['.head', 'height'])
    const footer = pill + size(base, shapeStyle, ['.footer', 'margin-bottom'])
    assert.equal(size(base, shapeStyle, ['.scroll', 'height']), screen - head - footer, `${shape} scroll height`)
    assert.ok(screen - head - footer >= 180, `${shape} list is only ${screen - head - footer}px tall`)
  }
  for (const block of blocks(base, '.scroll')) {
    assert.doesNotMatch(block, /flex:/, '.scroll must not be sized by flex')
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
