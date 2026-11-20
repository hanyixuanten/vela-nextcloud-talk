// Sync src/manifest.json with the version that `npm version` just wrote into
// package.json.
//
// The RPK name and the watch installer both read src/manifest.json, not
// package.json, so a release has to move versionName (and versionCode, which the
// installer only accepts when it strictly increases) or the package keeps
// claiming the old version.
//
// manifest.json is hand formatted — inline arrays on one line, compact objects —
// so the edit is textual: parsing and re-serialising the whole file would turn a
// two line change into a full-file rewrite.
const fs = require('fs')
const path = require('path')

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// Replace exactly one occurrence: zero means the field was renamed/removed and
// more than one means the edit would hit the wrong place. Either way, stop.
function replaceOnly(text, pattern, replacement, field, file) {
  const hits = text.match(new RegExp(pattern.source, 'g'))
  if (!hits) throw new Error(`${file}: no ${field} field to update`)
  if (hits.length !== 1) throw new Error(`${file}: ${hits.length} ${field} fields, expected exactly one`)
  return text.replace(pattern, replacement)
}

function bumpManifestVersion(root, version) {
  if (!SEMVER.test(version)) throw new Error(`Invalid version: ${version} (expected x.x.x)`)

  const pkgFile = path.join(root, 'package.json')
  const manifestFile = path.join(root, 'src', 'manifest.json')

  const pkg = readJson(pkgFile)
  if (pkg.version !== version) {
    throw new Error(`package.json is ${pkg.version}, not ${version}; run \`npm version\` first`)
  }

  const before = fs.readFileSync(manifestFile, 'utf8')
  const manifest = JSON.parse(before)
  if (!Number.isInteger(manifest.versionCode) || manifest.versionCode < 0) {
    throw new Error(`${manifestFile}: versionCode must be a non-negative integer`)
  }

  // Re-running the release for an already bumped tree must not keep raising
  // versionCode: the field only has to increase between published versions.
  if (manifest.versionName === version) {
    return { changed: false, versionCode: manifest.versionCode }
  }

  const versionCode = manifest.versionCode + 1
  let after = replaceOnly(before, /"versionName"\s*:\s*"[^"]*"/, `"versionName": "${version}"`, 'versionName', manifestFile)
  after = replaceOnly(after, /"versionCode"\s*:\s*\d+/, `"versionCode": ${versionCode}`, 'versionCode', manifestFile)

  // Cheap guard against a regex that matched something plausible but wrong.
  const parsed = JSON.parse(after)
  if (parsed.versionName !== version || parsed.versionCode !== versionCode) {
    throw new Error(`${manifestFile}: update did not round-trip (${parsed.versionName} / ${parsed.versionCode})`)
  }
  if (parsed.package !== manifest.package) {
    throw new Error(`${manifestFile}: package name changed unexpectedly (${parsed.package})`)
  }

  fs.writeFileSync(manifestFile, after)
  return {
    changed: true,
    previousVersionName: manifest.versionName,
    previousVersionCode: manifest.versionCode,
    versionCode
  }
}

module.exports = { bumpManifestVersion }

if (require.main === module) {
  const version = process.argv[2]
  if (!version) {
    console.error('Usage: node scripts/bump-manifest-version.cjs x.x.x')
    process.exit(2)
  }
  const result = bumpManifestVersion(path.resolve(__dirname, '..'), version)
  if (result.changed) {
    console.log(`src/manifest.json: ${result.previousVersionName} -> ${version}, versionCode ${result.previousVersionCode} -> ${result.versionCode}`)
  } else {
    console.log(`src/manifest.json: already ${version} (versionCode ${result.versionCode} unchanged)`)
  }
}
