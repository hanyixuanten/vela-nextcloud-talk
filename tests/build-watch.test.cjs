const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const filename = path.join(__dirname, '..', 'scripts', 'build-watch.cjs')
const source = fs.readFileSync(filename, 'utf8')
const fn = source.match(/function compileUx\(source, filename\) \{[\s\S]*?\n\}/)
assert.ok(fn, 'compileUx function found')
const compileUx = vm.runInNewContext(`(${fn[0].replace('function compileUx(source, filename)', 'function compileUx(source, filename, shape)')})`)

const sample = [
  '<!-- if true: process.env.SHAPE === \'CIRCLE\' -->',
  'circle only',
  '<!-- endif -->',
  'common',
  '/* if true: process.env.SHAPE === \'RECT\' */',
  'rect only',
  '/* endif */'
].join('\n')
assert.equal(compileUx(sample, 'fixture.ux', 'circle'), ['circle only', 'common'].join('\n'))
assert.equal(compileUx(sample, 'fixture.ux', 'rect'), ['common', 'rect only'].join('\n'))
assert.throws(() => compileUx('<!-- if true: process.env.SHAPE === \'CIRCLE\' */\ncode\n<!-- endif -->', 'bad.ux', 'circle'), /Mismatched shape conditional delimiters/)
assert.throws(() => compileUx('/* if true: process.env.SHAPE === \'CIRCLE\' -->\ncode\n/* endif */', 'bad.ux', 'circle'), /Mismatched shape conditional delimiters/)
assert.throws(() => compileUx('<!-- if true: process.env.SHAPE === \'CIRCLE\' -->\ncode\n<!-- endif */', 'bad.ux', 'circle'), /Mismatched shape conditional delimiters/)
assert.throws(() => compileUx('<!-- endif -->', 'bad.ux', 'circle'), /Unbalanced shape conditional/)
assert.throws(() => compileUx('<!-- if true: process.env.SHAPE === \'CIRCLE\' -->\ncode', 'bad.ux', 'circle'), /Unclosed shape conditional/)

console.log('build-watch compileUx: 7 assertions passed')

// The 1 MB page limit. On 2026-11-25 the watch answered every tap on a
// conversation with 「打不开，请重试」 while a 9 KB probe page opened fine: the
// target page had been packaged at 1.06 MB and the device never loaded it. The
// toolkit only warns, so the build has to refuse.
const guard = source.match(/function oversizedEntries\(buffer, limit\) \{[\s\S]*?\n\}/)
assert.ok(guard, 'oversizedEntries function found')
const oversizedEntries = vm.runInNewContext(`(${guard[0]})`, { Buffer })

function fakeRpk(name, size) {
  const nameBytes = Buffer.from(name, 'utf8')
  const cd = Buffer.alloc(46 + nameBytes.length)
  cd.writeUInt32LE(0x02014b50, 0)
  cd.writeUInt32LE(size, 24)
  cd.writeUInt16LE(nameBytes.length, 28)
  nameBytes.copy(cd, 46)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(0, 16)
  return Buffer.concat([cd, eocd])
}

const limit = 1024 * 1024
assert.equal(oversizedEntries(fakeRpk('pages/chat/chat.js', 699 * 1024), limit).length, 0, '699 KB is fine')
const over = oversizedEntries(fakeRpk('pages/chat/chat.js', 1063724), limit)
assert.equal(over.length, 1, 'a 1.06 MB page has to be refused')
assert.equal(over[0].name, 'pages/chat/chat.js')
assert.match(fs.readFileSync(filename, 'utf8'), /MAX_PAGE_BYTES = 1024 \* 1024/, 'the limit is the device limit')
assert.match(fs.readFileSync(filename, 'utf8'), /oversized\.length/, 'the build must fail, not warn')
console.log('build-watch page size guard: 4 assertions passed')
