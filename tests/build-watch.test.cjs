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
