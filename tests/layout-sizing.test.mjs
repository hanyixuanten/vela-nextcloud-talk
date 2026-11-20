// Sizing rules for the pages that broke on the round watch (0.2.5 theme port).
//
// Two real defects, both reported from the device:
//
//  1. The background glow showed up as a 256x256 patch in the top-left corner
//     with the rest of the screen black. Cause: `.app-bg` is `position:
//     absolute` with `width/height: 100%`; this firmware resolves no percentage
//     on an absolutely positioned child, so the <image> fell back to the
//     bitmap's intrinsic size. It also used `object-fit: fill`, which Vela does
//     not accept (only contain | cover | none | scale-down).
//
//  2. The chat screen was squashed: `.list` was `width: 100%` inside <scroll>.
//     Scroll content has no definite width, so the 100% resolved to nothing and
//     every bubble sized as a percentage of it collapsed. The same pattern was
//     in the conversation list and in Settings.
//
// The invariant is therefore: sizes that must resolve on this runtime are
// design pixels (the manifest's designWidth is 480), never percentages, and
// only directly under `.app-page` — where the previous, working release already
// used percentages — is a percentage acceptable.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const theme = read('../src/common/styles/theme.css')
const pages = {
  index: read('../src/pages/index/index.ux'),
  chat: read('../src/pages/chat/chat.ux'),
  settings: read('../src/pages/settings/settings.ux'),
  login: read('../src/pages/login/login.ux'),
  setup: read('../src/pages/setup/setup.ux'),
  offline: read('../src/pages/offline/offline.ux')
}

const test = (name, fn) => {
  fn()
  console.log('  ok   ' + name)
}

// Every declaration block of one selector, base rule and shape overrides alike.
function blocks(css, selector) {
  const pattern = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  return [...css.matchAll(pattern)].map((match) => match[1])
}

function assertPixelWidth(css, selector, label) {
  const found = blocks(css, selector)
  assert.ok(found.length > 0, `${label}: ${selector} must be styled`)
  // The base rule has to set the width; shape overrides may only touch height,
  // but a width they do set must stay in design pixels.
  const width = found[0].match(/width:\s*([^;]+);/)
  assert.ok(width, `${label}: ${selector} must declare a width`)
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

test('the page root does not opt into relative positioning', () => {
  // This is the single change that broke the first release of the theme: a
  // relatively positioned page root stopped handing a definite width to its
  // children, so the glow fell back to 256 px and percentage children lost
  // their basis. The old, working page root was a plain 100% x 100% column.
  const root = blocks(theme, '.app-page')
  assert.equal(root.length, 1, 'exactly one .app-page rule')
  assert.equal(
    /position:\s*(relative|absolute)/.test(root[0]),
    false,
    '.app-page must stay statically positioned'
  )
  assert.match(root[0], /width:\s*100%;/)
  assert.match(root[0], /height:\s*100%;/)
  assert.match(root[0], /overflow:\s*hidden/)
})

test('the background glow is sized in pixels and uses a Vela object-fit value', () => {
  const glow = blocks(theme, '.app-bg')
  assert.equal(glow.length, 1, 'exactly one base .app-bg rule')
  assert.match(glow[0], /width:\s*480px;/, '480px is the design width, i.e. the round screen')
  assert.match(glow[0], /height:\s*480px;/, 'the round screen is 480x480')
  assert.equal(/(?:width|height):\s*[^;]*%/.test(glow[0]), false, 'percentages do not resolve here')

  const fit = glow[0].match(/object-fit:\s*([a-z-]+);/)
  assert.ok(fit, '.app-bg must set object-fit explicitly')
  assert.ok(
    ['contain', 'cover', 'none', 'scale-down'].includes(fit[1]),
    `object-fit: ${fit[1]} is not accepted by Vela`
  )
})

test('every page overrides the glow height for the taller rect screen', () => {
  for (const [name, page] of Object.entries(pages)) {
    if (!page.includes('class="app-bg"')) continue
    const rect = page.match(/SHAPE === 'RECT' \*\/([\s\S]*?)\/\* endif \*\//)
    assert.ok(rect, `${name}: page must have a RECT block`)
    assert.match(rect[1], /\.app-bg\s*\{[^}]*height:\s*\d+px/, `${name}: RECT block must grow .app-bg`)
  }
})

test('scroll content is sized in pixels, not percentages', () => {
  assertPixelWidth(pages.chat, '.list', 'chat')
  assertPixelWidth(pages.index, '.list', 'index')
  assertPixelWidth(pages.settings, '.list', 'settings')
})

test('cards inside a scroll keep a pixel width in every shape', () => {
  assertPixelWidth(pages.chat, '.msg', 'chat')
  assertPixelWidth(pages.index, '.room', 'index')
  assertPixelWidth(pages.settings, '.row', 'settings')
})

test('the design width is the 480 the pixel sizes are derived from', () => {
  const manifest = JSON.parse(read('../src/manifest.json'))
  assert.equal(manifest.config.designWidth, 480, 'pixel sizes above assume a 480 design width')
})

console.log('layout sizing checks passed')
