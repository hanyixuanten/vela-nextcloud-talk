// Page/app side of the `keeper` micro service.
//
// `connect()` is called once from app.ux. `policy: "always"` is the whole point:
// the service is not torn down when the app is closed, so it keeps polling the
// conversation list and can buzz for new messages.
//
// Everything here is best effort. A firmware without micro service support
// answers `connect` with an exception (error code 1000/1001); the app must keep
// working as a plain foreground client instead of failing to start.

import serviceclient from '@system.serviceclient'
import { SERVICE_NAME } from './keeper'

let instance = null
let started = false
let listener = null
// app.ux mirrors the summary into shared state, pages/index pre-renders it.
// Both want the same push, so keep a tiny list instead of one callback.
const listeners = []

function report(params) {
  console.log('keeper client error: code=' + (params && params.code) + ' ' + (params && params.data))
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

/**
 * connect({ onSummary })
 * `onSummary(summary)` receives the retained conversation list whenever the
 * service finishes a poll.
 */
function start(options) {
  const opts = options || {}
  if (typeof opts.onSummary === 'function') subscribe(opts.onSummary)
  if (started) return instance
  started = true
  if (!serviceclient || typeof serviceclient.connect !== 'function') {
    console.log('keeper client: @system.serviceclient unavailable, background retention off')
    return null
  }
  try {
    instance = serviceclient.connect({ name: SERVICE_NAME, policy: 'always', params: {} })
  } catch (err) {
    console.log('keeper client: connect failed: ' + ((err && err.message) || err))
    instance = null
    return null
  }
  if (!instance) return null
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

function post(payload) {
  if (!instance) return
  try {
    instance.postMessage(payload)
  } catch (err) {
    console.log('keeper client: postMessage failed: ' + ((err && err.message) || err))
  }
}

/** Pages poll themselves in the foreground; the service pauses to save power. */
function foreground(active) {
  post({ type: active ? 'foreground' : 'background' })
}

/** Ask for an immediate poll (settings changed, account saved). */
function refresh() {
  post({ type: 'refresh' })
}

/** Turn retention off: the service stops its timer and exits. */
function stop() {
  post({ type: 'shutdown' })
  if (instance && typeof instance.disconnect === 'function') {
    try {
      instance.disconnect()
    } catch (err) {
      console.log('keeper client: disconnect failed: ' + ((err && err.message) || err))
    }
  }
  instance = null
  started = false
}

export default {
  start,
  subscribe,
  foreground,
  refresh,
  stop,
  isConnected: () => Boolean(instance)
}
