// Page/app side of the `keeper` micro service.
//
// `connect()` is called from app.ux as early as possible. `policy: "always"` is
// the whole point: the service is not torn down when the app is closed, so it
// keeps polling the conversation list and can buzz for new messages.
//
// Three failures shaped this file:
//
// 1. (1.0.17) The feature was imported at module scope:
//
//        import serviceclient from '@system.serviceclient'
//
//    which compiles to a module-level `$app_require$("@app-module/...")`. On a
//    firmware that does not implement the feature at all the call *throws*:
//
//        $app_require$: feature key system.serviceclient not found or feature
//        not declared in manifest
//
//    and it throws while app.ux itself is being initialised, because app.ux
//    requires this module. Everything app.ux owns then never runs: the
//    translators, the lease heartbeat, and the in-app background ticker. That
//    is a much bigger failure than "background retention is off" - it is why the
//    device log showed the error before the app had done anything at all. The
//    feature is now resolved lazily, inside a try/catch, and once found missing
//    it is not asked for again.
//
// 2. (1.0.15) `started` was set *before* the connect attempt, so one failed
//    `connect` — error 1000/1001 while the service runtime was still coming up
//    during app.onCreate — disabled background retention for the whole session:
//    every later start() returned early. The flag is only set once an instance
//    exists now, and a failed attempt is retried with backoff.
//
// 3. (1.0.15) A `foreground` message used to pause the service for good if the
//    app never sent its counterpart (swipe-kill, skipped onHide). The service
//    holds a lease now (keeper.js FOREGROUND_LEASE_MS) and app.ux renews it from
//    a heartbeat, so silence means "resume", not "stay paused".
//
// Everything here is best effort. A firmware without micro service support
// answers `connect` with an exception - or, in the case above, cannot even
// resolve the module - and the app must keep working as a plain client.

import { SERVICE_NAME, FOREGROUND_LEASE_MS } from './keeper'

// Reconnect backoff, in ms. The first rung is deliberately short: most failures
// are "the service runtime is not up yet" during app.onCreate, not a missing
// service.
const RETRY_DELAYS = [1000, 5000, 15000, 45000, 60000]

let serviceclient
let featureResolved = false
// True once the platform has said it has no such feature. Nothing will make it
// appear later in this process, so requests stop instead of logging forever.
let featureMissing = false

let instance = null
let starting = false
let retryTimer = null
let retryStep = 0
// app.ux mirrors the summary into shared state, pages/index pre-renders it.
// Both want the same push, so keep a tiny list instead of one callback.
const listeners = []

/**
 * Resolve `@system.serviceclient` at call time.
 *
 * `require` (not `import`) is the whole point: an import is hoisted to module
 * scope and a failing one takes app.ux down with it, while this call can be
 * caught. Verified against a device whose firmware answers
 * "feature key system.serviceclient not found".
 */
function serviceClientFeature() {
  if (featureResolved) return featureMissing ? null : serviceclient
  featureResolved = true
  try {
    // eslint-disable-next-line global-require
    serviceclient = require('@system.serviceclient')
  } catch (err) {
    serviceclient = null
    console.log('keeper client: @system.serviceclient unavailable (' + ((err && err.message) || err) + ')')
  }
  if (!serviceclient || typeof serviceclient.connect !== 'function') {
    featureMissing = true
    serviceclient = null
    console.log('keeper client: this firmware has no micro service support, background retention stays in-process')
    return null
  }
  return serviceclient
}

function report(params) {
  const code = params && params.code
  console.log('keeper client error: code=' + code + ' ' + (params && params.data))
  // 1000 connect failed / 1001 service missing / 1003 connection lost: all are
  // worth another attempt. A dead service that nobody retries is exactly the
  // bug this file was rewritten for.
  drop()
  scheduleRetry()
}

function emit(summary) {
  listeners.forEach((fn) => {
    try {
      fn(summary)
    } catch (err) {
      console.log('keeper client listener failed: ' + ((err && err.message) || err))
    }
  })
}

/** Register a summary listener. Returns an unsubscribe function. */
function subscribe(fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.push(fn)
  return () => {
    const index = listeners.indexOf(fn)
    if (index >= 0) listeners.splice(index, 1)
  }
}

function clearRetry() {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

/** Forget a dead instance (its callbacks go quiet) so connect() can rebuild. */
function drop() {
  const dead = instance
  instance = null
  if (!dead) return
  try {
    dead.onmessage = null
    dead.onerror = null
    if (typeof dead.disconnect === 'function') dead.disconnect()
  } catch (err) {
    console.log('keeper client: disconnect failed: ' + ((err && err.message) || err))
  }
}

function scheduleRetry() {
  if (retryTimer !== null || instance) return
  if (featureMissing) return
  const delay = RETRY_DELAYS[Math.min(retryStep, RETRY_DELAYS.length - 1)]
  retryStep += 1
  console.log('keeper client: retrying connect in ' + delay + 'ms')
  retryTimer = setTimeout(() => {
    retryTimer = null
    connect()
  }, delay)
}

function connect() {
  const client = serviceClientFeature()
  if (!client) {
    // The platform has no such feature (or no connect): do not spin. Background
    // retention stays in-process (app.ux, config.background) and the pages poll
    // on their own.
    return null
  }
  if (instance) return instance
  if (starting) return null
  starting = true
  let next = null
  try {
    next = client.connect({ name: SERVICE_NAME, policy: 'always', params: {} })
  } catch (err) {
    console.log('keeper client: connect failed: ' + ((err && err.message) || err))
    next = null
  }
  starting = false
  if (!next) {
    scheduleRetry()
    return null
  }

  instance = next
  retryStep = 0
  clearRetry()
  instance.onmessage = (params) => {
    // The docs describe the callback argument as "the message object the
    // service sent", but a host may wrap it in `{ params }`. Accept both.
    const payload = params && params.params ? params.params : params
    if (!payload) return
    if (payload.type === 'rooms' && payload.summary) emit(payload.summary)
  }
  instance.onerror = report
  console.log('keeper client: connected')
  return instance
}

/**
 * start({ onSummary })
 * `onSummary(summary)` receives the retained conversation list whenever the
 * service finishes a poll. Safe to call repeatedly: it only subscribes when
 * already connected, and retries when the last attempt failed.
 */
function start(options) {
  const opts = options || {}
  if (typeof opts.onSummary === 'function') subscribe(opts.onSummary)
  if (instance) return instance
  return connect()
}

function post(payload, retryable) {
  if (featureMissing) return false
  if (!instance) {
    if (retryable !== false) connect()
    return false
  }
  try {
    instance.postMessage(payload)
    return true
  } catch (err) {
    console.log('keeper client: postMessage failed: ' + ((err && err.message) || err))
    return false
  }
}

/**
 * "The app is on screen" (true) / "the app went away" (false).
 * The service pauses on true for FOREGROUND_LEASE_MS; app.ux calls this again
 * from a heartbeat so a visible app keeps it paused, while a killed app simply
 * stops renewing it.
 */
function foreground(active) {
  return post({ type: active ? 'foreground' : 'background' })
}

/** Renew the foreground pause without changing anything else. */
function heartbeat() {
  return post({ type: 'foreground' })
}

/** Ask for an immediate poll (account saved, settings changed). */
function refresh() {
  return post({ type: 'refresh' })
}

/**
 * Stop connecting for this session. There is no user-facing switch any more:
 * retention is always on (docs/design.md §12.6), so only a cleared account or
 * a teardown uses this.
 */
function stop() {
  clearRetry()
  retryStep = 0
  post({ type: 'shutdown' }, false)
  drop()
}

export default {
  start,
  connect,
  subscribe,
  foreground,
  heartbeat,
  refresh,
  stop,
  isConnected: () => Boolean(instance),
  FOREGROUND_LEASE_MS
}
