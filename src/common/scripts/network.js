// Startup network gate.
//
// Lifted from the HyperBilibili template's `NetworkCheck` (src/jumpcheck.ts):
// ask @system.network for the current type and treat "" / "none" as offline.
// That check alone cannot tell "Wi-Fi associated but nothing routable" from
// "fine", so when an account exists we also let fetch prove the path to the
// configured server — any HTTP answer means the network works, only a
// transport failure (DNS / TLS / connect) counts as offline.
//
// Both halves are optional-by-failure: a firmware that does not implement one
// of them must not brick the app, so every error path resolves instead of
// rejecting.

import network from '@system.network'
import fetch from '@system.fetch'

export const PROBE_TIMEOUT_MS = 8000

function networkType() {
  return new Promise((resolve) => {
    if (!network || typeof network.getType !== 'function') {
      console.log('network api unavailable')
      resolve('')
      return
    }
    try {
      network.getType({
        success: (data) => resolve((data && data.type) || ''),
        fail: (data, code) => {
          console.log('network getType failed, code = ' + code)
          resolve('')
        }
      })
    } catch (err) {
      console.log('network getType threw: ' + ((err && err.message) || err))
      resolve('')
    }
  })
}

/** Resolves true if the server answers anything at all. */
export function probeServer(baseUrl, timeoutMs) {
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : PROBE_TIMEOUT_MS
  return new Promise((resolve) => {
    const url = String(baseUrl || '').replace(/\/+$/, '') + '/status.php'
    let settled = false
    let timer = null
    const done = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => {
      console.log('network probe timeout: ' + url)
      done(false)
    }, limit)

    try {
      fetch.fetch({
        url: url,
        method: 'GET',
        responseType: 'text',
        // Whatever the status code, the request reached a server: the network
        // is up. Auth and server errors are the app's problem, not the gate's.
        success: () => done(true),
        fail: (data, code) => {
          const detail = typeof data === 'string' ? data : (data && data.data) || ''
          console.log('network probe failed: ' + url + ' code=' + code + (detail ? ' ' + detail : ''))
          done(false)
        }
      })
    } catch (err) {
      console.log('network probe threw: ' + ((err && err.message) || err))
      done(false)
    }
  })
}

/**
 * Resolves true when the watch looks online.
 * `settings` may be null/empty: without a server address only the interface
 * type is checked, because there is nothing meaningful to fetch yet.
 */
export function checkNetwork(settings, options) {
  const opts = options || {}
  return networkType().then((type) => {
    if (!type || type === 'none') {
      console.log('network offline: type=' + (type || 'unknown'))
      return false
    }
    const baseUrl = settings && settings.baseUrl
    if (!baseUrl) return true
    return probeServer(baseUrl, opts.timeoutMs)
  })
}

export default {
  PROBE_TIMEOUT_MS,
  checkNetwork,
  probeServer
}
