// Startup network gate and the probes that explain it.
//
// The verdict is the interface type, exactly like HyperBilibili's
// `NetworkCheck`: only "" / "none" / a failing getType means offline. The
// earlier version also required `<baseUrl>/status.php` to answer within 8 s,
// which turned a slow DNS / TLS handshake, a cold Wi-Fi association or a
// certificate chain the watch does not trust into a permanent 「没有网络」 page
// with no diagnostic at all.
//
// The probes still exist, but they are evidence, never gates, and they do not
// delay the launch:
//
//   control  https://www.bilibili.com/   — does this watch reach the internet?
//   server   <baseUrl>/status.php        — does it reach *your* Nextcloud?
//
// Comparing the two is what separates "the watch has no usable internet" from
// "the watch is online but this host / TLS chain / port is not reachable". Both
// results land in `state.controlProbe` / `state.serverProbe` and in the log;
// pages/index also uses the control result to say "online, but the server is
// unreachable" instead of a bare transport error.
//
// Every path resolves instead of rejecting: a firmware that does not implement
// one of these APIs must not brick the app.

import network from '@system.network'
import fetch from '@system.fetch'

export const PROBE_TIMEOUT_MS = 8000

// `@system.network.getType` is the only thing the launch depends on, and on
// some firmwares it simply never calls back (neither success nor fail), which
// left the app on 「正在检查网络…」 forever. 4 s is far below any user's
// patience and far above a healthy call.
export const TYPE_TIMEOUT_MS = 4000

// A public HTTPS host with a mainstream certificate chain, used only as a
// control probe. Same role bilibili plays for HyperBilibili.
export const CONTROL_URL = 'https://www.bilibili.com/'

function nowMs() {
  return typeof Date !== 'undefined' && Date.now ? Date.now() : 0
}

function networkType(timeoutMs) {
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : TYPE_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const done = (type) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(type)
    }
    // A silent API must not brick the launch: report "unknown" and let the
    // pages' own requests speak.
    timer = setTimeout(() => {
      console.log('network getType timed out after ' + limit + 'ms')
      done('')
    }, limit)

    if (!network || typeof network.getType !== 'function') {
      console.log('network api unavailable')
      done('')
      return
    }
    try {
      network.getType({
        success: (data) => done((data && data.type) || ''),
        fail: (data, code) => {
          console.log('network getType failed, code = ' + code)
          done('')
        }
      })
    } catch (err) {
      console.log('network getType threw: ' + ((err && err.message) || err))
      done('')
    }
  })
}

/**
 * GET a URL and keep the evidence.
 * Resolves `{ ok, status, code, detail, timedOut, ms, url }` — never rejects.
 * `ok` means "something answered"; any HTTP status counts.
 */
export function probeUrl(url, timeoutMs) {
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : PROBE_TIMEOUT_MS
  return new Promise((resolve) => {
    const target = String(url || '')
    const started = nowMs()
    let settled = false
    let timer = null
    const done = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(Object.assign({ url: target, ms: nowMs() - started }, result))
    }
    timer = setTimeout(() => {
      console.log('probe timeout: ' + target)
      done({ ok: false, status: 0, code: 'TIMEOUT', detail: '', timedOut: true })
    }, limit)

    try {
      fetch.fetch({
        url: target,
        method: 'GET',
        responseType: 'text',
        success: (response) => {
          // Whatever the status code, the request reached a server: that is the
          // only question a probe asks. Auth and server errors are not the
          // network's problem.
          done({
            ok: true,
            status: Number(response && response.code) || 0,
            code: 0,
            detail: '',
            timedOut: false
          })
        },
        fail: (data, code) => {
          const detail = typeof data === 'string' ? data : (data && data.data) || ''
          console.log('probe failed: ' + target + ' code=' + code + (detail ? ' ' + detail : ''))
          // `code` is the platform's transport error (DNS / TLS / connect); it
          // is the only thing that tells the three apart.
          done({
            ok: false,
            status: 0,
            code: code === undefined || code === null ? '' : code,
            detail: detail,
            timedOut: false
          })
        }
      })
    } catch (err) {
      console.log('probe threw: ' + ((err && err.message) || err))
      done({ ok: false, status: 0, code: 'THREW', detail: (err && err.message) || '', timedOut: false })
    }
  })
}

/** Probe `<baseUrl>/status.php` (kept as a name because that is what it is). */
export function probeServerDetailed(baseUrl, timeoutMs) {
  return probeUrl(String(baseUrl || '').replace(/\/+$/, '') + '/status.php', timeoutMs)
}

/** Boolean form, kept for callers that only need "did it answer". */
export function probeServer(baseUrl, timeoutMs) {
  return probeServerDetailed(baseUrl, timeoutMs).then((result) => result.ok)
}

/**
 * The gate verdict.
 *
 * Only an explicit "none" is a definitive offline signal. An empty answer
 * means the API failed, is unimplemented, or answered late — that is not
 * evidence of a dead network, and treating it as offline is what left the app
 * on 「正在检查网络…」/「没有网络」 with no way forward. When in doubt we let the
 * user in and let the first request say what is wrong.
 */
export function interfaceOnline(type) {
  return type !== 'none'
}

/**
 * Fast verdict for one launch: interface type only, no network round trip
 * beyond `getType` itself (which is bounded by `TYPE_TIMEOUT_MS`).
 * Resolves `{ online, type, known }`.
 */
export function checkSignal(options) {
  const opts = options || {}
  return networkType(opts.typeTimeoutMs).then((type) => {
    const online = interfaceOnline(type)
    const known = Boolean(type)
    console.log('network verdict: type=' + (type || 'unknown') + ' online=' + online)
    return { online: online, type: type, known: known }
  })
}

/**
 * Advisory evidence, run *after* the route decision so it can never hold the
 * launch screen. Resolves `{ control, server }`; `server` is null when no
 * account is configured yet.
 */
export function probeTargets(settings, options) {
  const opts = options || {}
  const baseUrl = settings && settings.baseUrl
  // `controlUrl` exists so tests can point the control probe at a local server
  // instead of the public host.
  const control = probeUrl(opts.controlUrl || CONTROL_URL, opts.timeoutMs).then((result) => {
    console.log(
      'control probe: ok=' + result.ok + ' status=' + result.status +
      ' code=' + result.code + ' ms=' + result.ms + (result.detail ? ' ' + result.detail : '')
    )
    return result
  })
  const server = baseUrl
    ? probeServerDetailed(baseUrl, opts.timeoutMs).then((result) => {
      console.log(
        'server probe: ok=' + result.ok + ' status=' + result.status +
        ' code=' + result.code + ' ms=' + result.ms + (result.detail ? ' ' + result.detail : '')
      )
      return result
    })
    : Promise.resolve(null)
  return Promise.all([control, server]).then((results) => ({
    control: results[0],
    server: results[1]
  }))
}

/**
 * Boolean form used by the launch gate: interface type only, matching
 * HyperBilibili's NetworkCheck. An unreachable host is NOT offline.
 */
export function checkNetwork() {
  return checkSignal().then((signal) => signal.online)
}

export default {
  PROBE_TIMEOUT_MS,
  TYPE_TIMEOUT_MS,
  CONTROL_URL,
  interfaceOnline,
  checkSignal,
  checkNetwork,
  probeUrl,
  probeServer,
  probeServerDetailed,
  probeTargets
}
