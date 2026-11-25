// A page VM may not carry `data` together with `protected` / `public` / `private`.
//
// From the watch log on 1.0.4, once per attempted transition:
//
//   Error: 页面VM对象中的属性data不可与"public,protected,private"同时存在，
//          请使用private替换data名称
//     at __scriptModule__ (.../pages/chat/chat.js:8659)
//
// That was pages/chat: `protected` (the room token/name from the router) next to
// `data`. The page VM was never created, so the router issued the transition,
// the target page failed to build and the caller stayed on the list — the exact
// shape of "点会话没反应". Four rounds went into the navigation helper before
// this line was read; the check below is what would have caught it in a second.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../src/', import.meta.url)
const pagesDir = new URL('pages/', root)
const read = (path) => readFileSync(path, 'utf8')

const test = (name, fn) => {
  fn()
  console.log('  ok   ' + name)
}

const pages = readdirSync(pagesDir)
  .filter((name) => statSync(new URL(name + '/', pagesDir)).isDirectory())
  .map((name) => ({ name, file: new URL(name + '/' + name + '.ux', pagesDir) }))

const scriptOf = (page) => read(page.file).split('<script>')[1].split('</script>')[0]

// Top level of `export default { ... }`: the option keys sit at two spaces.
const optionsOf = (page) => {
  const script = scriptOf(page)
  const keys = new Set()
  for (const match of script.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)) keys.add(match[1])
  return keys
}

test('no page mixes data with protected/public/private', () => {
  assert.ok(pages.length >= 7, 'every page has to be checked, not a hard-coded list')
  for (const page of pages) {
    const keys = optionsOf(page)
    const guarded = ['protected', 'public', 'private'].filter((key) => keys.has(key))
    if (!guarded.length) continue
    assert.ok(
      !keys.has('data'),
      `pages/${page.name} declares data and ${guarded.join('/')}; rename data to private (the VM refuses the page otherwise)`
    )
  }
})

test('the chat page keeps its router params and uses private state', () => {
  const keys = optionsOf(pages.find((page) => page.name === 'chat'))
  assert.ok(keys.has('protected'), 'the room arrives through protected params')
  assert.ok(keys.has('private'), 'the state block has to be private next to protected')
  assert.ok(!keys.has('data'), 'and data must be gone')
})

console.log('page VM checks passed')
