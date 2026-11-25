// Persistent settings on the watch, backed by @system.storage.
//
// @system.storage only stores strings, so everything is JSON serialised.
// The single key stores account and UI preferences.
//
// The application password is stored in the clear inside the app sandbox.
// Vela offers no keystore API; see docs/design.md for the threat model.

import storage from '@system.storage'

const KEY_SETTINGS = 'nctalk.settings'

export const DEFAULT_SETTINGS = {
  baseUrl: '',
  user: '',
  appPassword: '',
  displayName: '',

  // Keyboard: QWERTY | T9 (forwarded to the InputMethod component).
  keyboardType: 'QWERTY',
  // Screen shape: circle | rect (forwarded to the InputMethod component).
  screenType: 'circle',
  // Milliseconds between background polls of the open conversation.
  pollInterval: 15000,
  // NOTE: background retention used to be a `backgroundKeep` flag here.
  // Background polling was removed entirely in 1.0.20; `normalize()` still
  // drops the stale key so an old "off" in storage cannot confuse anything.
  // small | normal | large
  fontScale: 'normal'
}

// Vela documents fail as fail(data, code), but the tag / firmware builds do not
// all honour that: some pass one result object ({ data, code }), some pass a
// bare string, and some pass nothing at all. A handler that only read the
// second argument therefore logged "code=undefined" and threw away the error
// text, which is the only part that says *why* the write failed.
//
// Accept every shape, never print "undefined", and keep the platform payload
// on the error so a caller can log or branch on it.
function storageFailure(operation, args, context) {
  let data = args[0]
  let code = args[1]

  if (code === undefined && data !== null && typeof data === 'object') {
    code = data.code
    data = data.data
    if (data === undefined) data = args[0].message
  }

  const detail = typeof data === 'string' ? data : ''
  const hasCode = code !== undefined && code !== null && code !== ''

  let message = 'storage ' + operation + ' failed, code=' + (hasCode ? code : 'unknown')
  if (detail) message += ': ' + detail
  if (context) message += ' (' + context + ')'

  const err = new Error(message)
  // Kept separate from the message so callers do not have to parse the string.
  if (hasCode) err.storageCode = code
  if (detail) err.storageDetail = detail
  return err
}

// A missing or disabled @system.storage throws on property access instead of
// calling fail, so the guard has to be explicit rather than defensive.
function requireStorage(method) {
  if (!storage || typeof storage[method] !== 'function') {
    const err = new Error('storage ' + method + ' unavailable: @system.storage is missing')
    err.storageDetail = 'unavailable'
    return err
  }
  return null
}

function readRaw(key) {
  return new Promise((resolve) => {
    const missing = requireStorage('get')
    if (missing) {
      console.log(missing.message)
      resolve('')
      return
    }
    try {
      storage.get({
        key: key,
        default: '',
        success: (data) => resolve(data || ''),
        // A read failure is not fatal: defaults are a valid answer.
        fail: (data, code) => {
          const err = storageFailure('read', [data, code], 'key=' + key)
          console.log(err.message)
          resolve('')
        }
      })
    } catch (err) {
      console.log('storage read threw, key=' + key + ': ' + ((err && err.message) || err))
      resolve('')
    }
  })
}

function writeRaw(key, value) {
  return new Promise((resolve, reject) => {
    const missing = requireStorage('set')
    if (missing) {
      reject(missing)
      return
    }
    // Byte length is the one number that explains a quota / per-key limit
    // rejection, and the platform does not report it.
    const context = 'key=' + key + ', ' + String(value).length + ' chars'
    try {
      storage.set({
        key: key,
        value: value,
        success: () => resolve(),
        fail: (data, code) => reject(storageFailure('write', [data, code], context))
      })
    } catch (err) {
      const wrapped = storageFailure('write', [err && err.message], context)
      if (err && err.stack) wrapped.stack = err.stack
      reject(wrapped)
    }
  })
}

function parseJson(raw, fallback) {
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || parsed === undefined) return fallback
    return parsed
  } catch (e) {
    console.log('settings: corrupt JSON for key, falling back to defaults')
    return fallback
  }
}

function normalize(settings) {
  const merged = Object.assign({}, DEFAULT_SETTINGS, settings || {})
  // Trailing slashes make URL building messy; keep the base URL canonical.
  merged.baseUrl = String(merged.baseUrl || '').trim().replace(/\/+$/, '')
  merged.user = String(merged.user || '').trim()
  merged.appPassword = String(merged.appPassword || '').trim()
  // Retention is always on; a value written by 1.0.14 and earlier would only
  // confuse the next reader of this object.
  delete merged.backgroundKeep
  return merged
}

function hasAccount(settings) {
  const s = settings || {}
  return Boolean(s.baseUrl && s.user && s.appPassword)
}

function load() {
  return readRaw(KEY_SETTINGS).then((raw) => normalize(parseJson(raw, {})))
}

function save(settings) {
  const normalized = normalize(settings)
  return writeRaw(KEY_SETTINGS, JSON.stringify(normalized)).then(() => normalized)
}

function clearAll() {
  return new Promise((resolve, reject) => {
    const missing = requireStorage('clear')
    if (missing) {
      reject(missing)
      return
    }
    try {
      storage.clear({
        success: () => resolve(),
        fail: (data, code) => reject(storageFailure('clear', [data, code]))
      })
    } catch (err) {
      const wrapped = storageFailure('clear', [err && err.message])
      if (err && err.stack) wrapped.stack = err.stack
      reject(wrapped)
    }
  })
}

export default {
  DEFAULT_SETTINGS,
  hasAccount,
  load,
  save,
  clearAll
}
