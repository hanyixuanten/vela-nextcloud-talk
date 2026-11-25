const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const [mode, shape, ...options] = process.argv.slice(2)
if (!['build', 'release'].includes(mode) || !['circle', 'rect'].includes(shape)) {
  throw new Error('Usage: node scripts/build-watch.cjs build|release circle|rect')
}

// Toolkit 2.0.5 parses local UX files before its webpack hooks run. Apply the
// official Vela conditional comments to staged UX sources before invoking aiot.
// Limit conditions to the watch shapes we support; no arbitrary expression evaluation.
function compileUx(source, filename) {
  const directive = /^\s*(<!--|\/\*)\s*(if true: process\.env\.SHAPE === '(CIRCLE|RECT)'|endif)\s*(-->|\*\/)\s*$/
  let target
  const output = []
  for (const line of source.split(/\r?\n/)) {
    const match = directive.exec(line)
    if (match) {
      const isHtml = match[1] === '<!--'
      if ((isHtml && match[4] !== '-->') || (!isHtml && match[4] !== '*/')) {
        throw new Error(`Mismatched shape conditional delimiters in ${filename}: ${line.trim()}`)
      }
      const command = match[2]
      if (command === 'endif' ? !target : target) {
        throw new Error(`Unbalanced shape conditional in ${filename}`)
      }
      target = command === 'endif' ? undefined : match[3].toLowerCase()
    } else if (/(?:<!--|\/\*)\s*(?:if true:|endif\b)/.test(line)) {
      throw new Error(`Unsupported shape conditional in ${filename}: ${line.trim()}`)
    } else if (!target || target === shape) {
      output.push(line)
    }
  }
  if (target) throw new Error(`Unclosed shape conditional in ${filename}`)
  return output.join('\n')
}

function copySources(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) copySources(from, to)
    else if (entry.name.endsWith('.ux')) fs.writeFileSync(to, compileUx(fs.readFileSync(from, 'utf8'), from))
    else fs.copyFileSync(from, to)
  }
}

// Vela will not load a page bundle above 1 MB. The toolkit only warns during
// packaging ("the following files is large than 1024KB, please check on the
// real device") and what the watch does with such a page is exactly what a dead
// tap looks like: the transition is issued, the page never appears, the router
// stays where it was. This app's chat page carries the vendored keyboard, so
// the ceiling is within reach — check the package itself, before it reaches a
// wrist, instead of debugging it there.
const MAX_PAGE_BYTES = 1024 * 1024

function oversizedEntries(buffer, limit) {
  // The RPK is a zip; the device reads the uncompressed size in the central
  // directory. Parsing it here keeps the check dependency free.
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('not a zip archive')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const oversized = []
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory entry')
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (size > limit) oversized.push({ name: name, size: size })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return oversized
}

const root = path.resolve(__dirname, '..')
const output = path.join(root, 'dist')
const stagingRoot = os.tmpdir()
const temp = fs.mkdtempSync(path.join(stagingRoot, 'vela-watch-'))
try {
  // Keep Toolkit's own sibling .temp directory inside the staging tree too.
  const project = path.join(temp, 'project')
  copySources(path.join(root, 'src'), path.join(project, 'src'))
  fs.copyFileSync(path.join(root, 'package.json'), path.join(project, 'package.json'))
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'junction')
  // Copy, never symlink: the toolkit copies the project into ../.temp_<name>
  // and flattens a symlinked sign/ into an empty file, so release signing then
  // fails with "there is a problem with the certification path" (debug builds
  // silently fall back to the toolkit's default certificate).
  const signing = path.join(root, 'sign')
  if (fs.existsSync(signing)) fs.cpSync(signing, path.join(project, 'sign'), { recursive: true })

  const result = spawnSync(process.execPath, [require.resolve('aiot-toolkit/lib/bin.js'), mode, ...options], {
    cwd: project,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`aiot ${mode} failed (${result.signal || result.status})`)

  const dist = path.join(project, 'dist')
  const packages = fs.existsSync(dist) ? fs.readdirSync(dist).filter(name => name.endsWith('.rpk')) : []
  // aiot 2.0.5 can report signing/compilation errors with status 0.
  if (packages.length !== 1) throw new Error(`aiot ${mode} did not produce exactly one RPK`)
  if (fs.existsSync(output) && (!fs.statSync(output).isDirectory() || fs.lstatSync(output).isSymbolicLink())) {
    throw new Error(`Refusing to clean unexpected output path: ${output}`)
  }
  if (fs.existsSync(output)) fs.rmSync(output, { recursive: true, force: true })
  fs.mkdirSync(output, { recursive: true })
  const name = packages[0]
  const rpk = path.join(dist, name)
  const oversized = oversizedEntries(fs.readFileSync(rpk), MAX_PAGE_BYTES)
  if (oversized.length) {
    throw new Error(
      '页面包超过 1 MB，手表不会加载它（表现就是点了没反应，停在原地）：' +
      oversized.map((entry) => `${entry.name} ${Math.round(entry.size / 1024)} KB`).join('、') +
      '；请把它拆小（别把大组件放进同一个页面），不要装这个包'
    )
  }
  const targetName = `${path.basename(name, '.rpk')}-${shape}.rpk`
  fs.copyFileSync(rpk, path.join(output, targetName))
  console.log(`${shape}: dist/${targetName}`)
} finally {
  if (path.dirname(temp) !== stagingRoot || !path.basename(temp).startsWith('vela-watch-')) {
    throw new Error(`Unexpected build staging path: ${temp}`)
  }
  fs.rmSync(temp, { recursive: true, force: true })
}
