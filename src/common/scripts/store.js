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
  // small | normal | large
  fontScale: 'normal'
}

function readRaw(key) {
  return new Promise((resolve) => {
    storage.get({
      key: key,
      default: '',
      success: (data) => resolve(data || ''),
      fail: () => resolve('')
    })
  })
}

function writeRaw(key, value) {
  return new Promise((resolve, reject) => {
    storage.set({
      key: key,
      value: value,
      success: () => resolve(),
      fail: (data, code) => reject(new Error('storage write failed, code=' + code))
    })
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
    try {
      storage.clear({
        success: () => resolve(),
        fail: (data, code) => reject(new Error('storage clear failed, code=' + code))
      })
    } catch (err) {
      reject(err)
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
