const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { bumpManifestVersion } = require('../scripts/bump-manifest-version.cjs')

// Fixture keeps the real manifest's hand formatting (inline arrays, compact
// objects) so the test fails if the bump reintroduces a full-file rewrite.
const MANIFEST = `{
  "package": "com.hanyixuanten.nctalk",
  "name": "Talk",
  "versionName": "0.2.13",
  "versionCode": 15,
  "deviceTypeList": ["watch"],
  "config": {
    "logLevel": "log",
    "designWidth": 480
  }
}
`

function fixture(pkgVersion = '0.3.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-manifest-'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'package.json'), `{\n  "name": "vela-nextcloud-talk",\n  "version": "${pkgVersion}"\n}\n`)
  fs.writeFileSync(path.join(root, 'src', 'manifest.json'), MANIFEST)
  return root
}

function read(root) {
  return fs.readFileSync(path.join(root, 'src', 'manifest.json'), 'utf8')
}

// ---------------------------------------------------------------- happy path
{
  const root = fixture('0.3.0')
  const result = bumpManifestVersion(root, '0.3.0')
  assert.equal(result.changed, true)
  assert.equal(result.previousVersionName, '0.2.13')
  assert.equal(result.versionCode, 16)

  const text = read(root)
  assert.equal(JSON.parse(text).versionName, '0.3.0')
  assert.equal(JSON.parse(text).versionCode, 16)
  // Formatting of untouched fields must survive.
  assert.match(text, /"deviceTypeList": \["watch"\],/)
  assert.match(text, /"designWidth": 480/)
  // Only the two version lines differ from the fixture.
  const changed = text.split('\n').filter((line, i) => line !== MANIFEST.split('\n')[i])
  assert.deepEqual(changed, ['  "versionName": "0.3.0",', '  "versionCode": 16,'])
}

// --------------------------------------------------------- re-running is a no-op
{
  const root = fixture('0.3.0')
  bumpManifestVersion(root, '0.3.0')
  const once = read(root)
  const again = bumpManifestVersion(root, '0.3.0')
  assert.equal(again.changed, false)
  assert.equal(again.versionCode, 16)
  assert.equal(read(root), once, 'second run must not touch versionCode')
}

// ---------------------------------------- package.json must already carry the version
{
  const root = fixture('0.2.13')
  assert.throws(() => bumpManifestVersion(root, '0.3.0'), /package\.json is 0\.2\.13, not 0\.3\.0/)
  assert.equal(fs.readFileSync(path.join(root, 'src', 'manifest.json'), 'utf8'), MANIFEST, 'failed run must not write')
}

// ------------------------------------------------------------- input validation
{
  const root = fixture('0.3.0')
  for (const bad of ['0.3', 'v0.3.0', '0.3.0.1', '01.3.0', '0.3.0-beta', '']) {
    assert.throws(() => bumpManifestVersion(root, bad), /Invalid version/, `should reject ${JSON.stringify(bad)}`)
  }
  assert.equal(read(root), MANIFEST)
}

// ------------------------------------------------------ a manifest without the fields
{
  const root = fixture('0.3.0')
  fs.writeFileSync(path.join(root, 'src', 'manifest.json'), '{\n  "package": "com.hanyixuanten.nctalk",\n  "versionCode": 15\n}\n')
  assert.throws(() => bumpManifestVersion(root, '0.3.0'), /no versionName field/)

  const renamed = fixture('0.3.0')
  fs.writeFileSync(path.join(renamed, 'src', 'manifest.json'), MANIFEST.replace('"versionName"', '"version_name"'))
  assert.throws(() => bumpManifestVersion(renamed, '0.3.0'), /no versionName field/)
}

// ------------------------------------------------------- non-integer versionCode
{
  const root = fixture('0.3.0')
  fs.writeFileSync(path.join(root, 'src', 'manifest.json'), MANIFEST.replace('"versionCode": 15', '"versionCode": "15"'))
  assert.throws(() => bumpManifestVersion(root, '0.3.0'), /versionCode must be a non-negative integer/)
}

console.log('bump-manifest-version: 20 assertions passed')
