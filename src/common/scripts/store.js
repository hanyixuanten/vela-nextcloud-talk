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
  // Two ways into the same app:
  //   account — Nextcloud account + app password (HTTP Basic)
  //   public  — a public conversation joined as a guest (link + optional
  //             password + display name), no account at all
  // `hasAccount()` stays account-only; `isConfigured()` answers "is either mode
  // ready", which is what the launch gate and the pages actually ask.
  mode: 'account',

  baseUrl: '',
  user: '',
  appPassword: '',
  displayName: '',

  // Public conversation (mode: 'public').
  roomToken: '',
  roomPassword: '',
  roomDisplayName: '',
  // Filled in by api.js after a successful guest join: the room title, the
  // guest actor id (sha1 of the Talk session) and the session cookies. Keeping
  // them on disk is what lets every page — each one is its own bundle with its
  // own copy of api.js — reuse one guest identity instead of joining again.
  roomName: '',
  roomActorId: '',
  sessionCookies: '',

  // Keyboard: QWERTY | T9 (forwarded to the InputMethod component).
  keyboardType: 'QWERTY'
  // NOTE: `screenType`, `pollInterval` and `fontScale` used to live here. The
  // settings UI rows were removed in 1.0.22: the screen shape is decided at
  // build time, the poll interval is fixed at 15000 ms and the font at
  // `normal`. `normalize()` drops the stale keys so old values in storage
  // cannot confuse anything.
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
  merged.mode = merged.mode === 'public' ? 'public' : 'account'
  // Talk tokens are lowercase by definition ([a-z0-9]{4,30}); a token pasted
  // from a link in upper case would otherwise 404 on every request.
  merged.roomToken = String(merged.roomToken || '').trim().toLowerCase()
  merged.roomPassword = String(merged.roomPassword || '').trim()
  merged.roomDisplayName = String(merged.roomDisplayName || '').trim()
  merged.roomName = String(merged.roomName || '').trim()
  merged.roomActorId = String(merged.roomActorId || '').trim()
  merged.sessionCookies = String(merged.sessionCookies || '').trim()
  // Retention is always on; a value written by 1.0.14 and earlier would only
  // confuse the next reader of this object.
  delete merged.backgroundKeep
  // Same for the settings rows removed in 1.0.22 (screen type, poll interval,
  // font size): nothing reads them any more, so strip them from old payloads.
  delete merged.screenType
  delete merged.pollInterval
  delete merged.fontScale
  return merged
}

/** Account mode only: server + user + app password. */
function hasAccount(settings) {
  const s = settings || {}
  return Boolean(s.baseUrl && s.user && s.appPassword)
}

/** Public mode only: server + room token. The display name is optional to the
 * API (Talk shows "Guest"), so it is not part of "usable". */
function hasPublicRoom(settings) {
  const s = settings || {}
  return Boolean(s.baseUrl && s.roomToken)
}

function isPublic(settings) {
  const s = settings || {}
  return s.mode === 'public'
}

/** Either mode is ready to connect. This is the question pages ask. */
function isConfigured(settings) {
  const s = settings || {}
  return isPublic(s) ? hasPublicRoom(s) : hasAccount(s)
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
  hasPublicRoom,
  isPublic,
  isConfigured,
  load,
  save,
  clearAll
}
