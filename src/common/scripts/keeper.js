// Background retention logic for the `keeper` micro service.
//
// Why this module exists: Vela stops a quick app when it goes to the
// background unless `config.background.features` declares an audio /
// geolocation / download task that is *running*. Chat polling is `@system.fetch`,
// which is not on that list, so the app itself cannot stay alive. What the
// platform does offer is a micro service (`services` in manifest.json +
// `@system.serviceclient`): it runs independently of the app lifecycle and,
// with `policy: "always"`, keeps running after the app is closed. All the
// runtime facts here come from the official docs:
//
//   guide/framework/other/background-running.html  (why fetch cannot keep alive)
//   features/other/serviceclient.html              (services + serviceManager)
//
// This file is deliberately free of `@system.*` imports: the service file
// (src/services/keeper.js) binds storage / vibrator / OCS and the page side
// binds `@system.serviceclient`, so the whole decision logic below is testable
// on desktop Node. See docs/design.md §11.

export const SERVICE_NAME = 'keeper'
export const SUMMARY_KEY = 'nctalk.keeper'

// The service polls the conversation list, so every tick is a full OCS round
// trip. A watch in the background has no screen to update: polling faster than
// the UI could ever show it only burns battery, hence the floor.
export const MIN_BACKGROUND_INTERVAL_MS = 30000

// One buzz per burst. Without a cooldown a group chat with three messages per
// tick would vibrate forever.
export const BUZZ_COOLDOWN_MS = 60000

// How long a `foreground` message keeps the service quiet.
//
// 1.0.14 had a plain boolean here and it was the reason background retention
// looked dead: the service paused when the app said it was visible, and the app
// is not guaranteed to say anything on the way out — a swipe-kill on the watch,
// a firmware that skips onHide, or a process the system reaps all leave the
// service holding `foreground = true` with its timer cleared, polling nothing
// until the next reboot. A lease cannot get stuck: the app renews it while it is
// on screen (pages renew from a heartbeat in app.ux), and when the renewals stop
// the service simply resumes.
export const FOREGROUND_LEASE_MS = 90000

/**
 * Is the app on screen right now, as far as the service can tell?
 * `until` is the expiry a `foreground` message wrote; 0 means "no lease".
 */
export function isForeground(until, now) {
  const expiry = Number(until) || 0
  if (expiry <= 0) return false
  return expiry > (Number(now) || 0)
}

/** Milliseconds left on the lease, 0 when it has expired. */
export function leaseRemaining(until, now) {
  const expiry = Number(until) || 0
  const remaining = expiry - (Number(now) || 0)
  return remaining > 0 ? remaining : 0
}

export function emptySummary() {
  return { at: 0, total: 0, account: '', rooms: [] }
}

/**
 * Persisted summaries are untrusted input: storage may hold an older shape,
 * a half-written value, or another account's rooms.
 */
export function parseSummary(raw) {
  if (!raw) return emptySummary()
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      console.log('keeper: corrupt summary JSON, starting empty')
      return emptySummary()
    }
  }
  if (!parsed || typeof parsed !== 'object') return emptySummary()

  const rooms = []
  let total = 0
  const list = Array.isArray(parsed.rooms) ? parsed.rooms : []
  list.forEach((room) => {
    if (!room || !room.token) return
    const unread = Number(room.unread) || 0
    if (unread > 0) total += unread
    rooms.push({
      token: String(room.token),
      name: String(room.name || room.token),
      preview: String(room.preview || ''),
      unread: unread,
      at: Number(room.at) || 0
    })
  })

  return {
    at: Number(parsed.at) || 0,
    total: total,
    account: String(parsed.account || ''),
    rooms: rooms
  }
}

/** `user@https://host` — the identity a cached summary belongs to. */
export function accountKey(settings) {
  const s = settings || {}
  if (!s.baseUrl || !s.user) return ''
  return String(s.user) + '@' + String(s.baseUrl)
}

export function hasAccount(settings) {
  const s = settings || {}
  return Boolean(s.baseUrl && s.user && s.appPassword)
}

/**
 * Turn an OCS room list into the compact shape kept in storage.
 * `formatPreview` is injected (fmt.previewWithAuthor) to keep this module
 * platform free.
 */
export function summarizeRooms(rooms, formatPreview, at) {
  const list = Array.isArray(rooms) ? rooms : []
  const summary = emptySummary()
  summary.at = Number(at) || 0
  list.forEach((room) => {
    if (!room || !room.token) return
    const unread = Number(room.unreadMessages) || 0
    if (unread > 0) summary.total += unread
    summary.rooms.push({
      token: String(room.token),
      name: String(room.displayName || room.name || room.token),
      preview: typeof formatPreview === 'function' ? String(formatPreview(room.lastMessage) || '') : '',
      unread: unread,
      at: Number(room.lastActivity) || 0
    })
  })
  return summary
}

/**
 * Who polls right now: the pages while foreground, the service while not.
 *
 * `enabled` is no longer a user preference — background retention is always on
 * (see docs/design.md §12.6). It now only says "this service is alive", so a
 * stopped service still answers false.
 */
export function shouldPoll(state) {
  const s = state || {}
  if (!s.enabled || !s.ready || s.inflight) return false
  // Foreground pages fetch the same list on show, and pages/chat runs its own
  // shorter message poll. A second poller would only duplicate traffic.
  return !s.foreground
}

export function intervalFor(pollInterval, floor) {
  const value = Number(pollInterval) || 0
  const min = Number(floor) > 0 ? Number(floor) : MIN_BACKGROUND_INTERVAL_MS
  return value > min ? value : min
}

/**
 * The service body. Every side effect is injected, so the tests can drive it
 * with a fake clock, a fake storage and a fake OCS.
 *
 * deps:
 *   loadSettings()  -> Promise<settings>
 *   listRooms()     -> Promise<rooms>        (api.listConversations)
 *   loadSummary()   -> Promise<string|object|null>
 *   saveSummary(s)  -> Promise
 *   formatPreview(message) -> string
 *   vibrate(mode)   -> void
 *   notify(payload) -> void                  (serviceManager.postMessage)
 *   setTimer(fn, ms) -> id
 *   clearTimer(id)  -> void
 *   now()           -> ms
 */
export function createKeeper(deps) {
  const d = deps || {}
  const now = d.now || (() => Date.now())
  const log = d.log || ((message) => console.log(message))

  let summary = emptySummary()
  let settings = null
  let timerId = null
  let scheduledAt = 0
  let clients = 0
  // Expiry of the foreground lease, not a boolean: see FOREGROUND_LEASE_MS.
  let foregroundUntil = 0
  let inflight = false
  let stopped = false
  // The first successful poll only establishes a baseline: everything already
  // unread when the service starts must not buzz.
  let primed = false
  let lastBuzzAt = 0
  // Bumped by every resolve/terminate so a poll that answers after the service
  // was stopped cannot schedule a new timer (Vela keeps the instance around).
  let generation = 0

  function interval() {
    // `intervalMs` is an explicit override for the in-app background ticker
    // (app.ux, see bgSync.js): that one must stay under the 20s window the
    // platform gives between two background-interface calls, which is below
    // MIN_BACKGROUND_INTERVAL_MS and therefore not expressible through
    // `intervalFor()`.
    if (Number(d.intervalMs) > 0) return Number(d.intervalMs)
    return intervalFor(settings && settings.pollInterval)
  }

  function foreground() {
    return isForeground(foregroundUntil, now())
  }

  function clearTimer() {
    if (timerId !== null && timerId !== undefined) {
      d.clearTimer(timerId)
      timerId = null
    }
  }

  function schedule(delay) {
    if (stopped) return
    const wait = delay === undefined ? interval() : delay
    // A pending timer is only ever replaced by an earlier one. Without this a
    // foreground heartbeat (renewing the lease every minute) would keep pushing
    // the poll further away and the service would never tick at all.
    const dueAt = now() + wait
    if (timerId !== null && timerId !== undefined && dueAt >= scheduledAt) return
    clearTimer()
    scheduledAt = dueAt
    const at = generation
    timerId = d.setTimer(() => {
      timerId = null
      scheduledAt = 0
      if (at === generation) tick()
    }, wait)
  }

  function publish() {
    if (clients > 0 && typeof d.notify === 'function') {
      d.notify({ type: 'rooms', summary: summary })
    }
  }

  function apply(rooms) {
    const prevTotal = summary.total
    const next = summarizeRooms(rooms, d.formatPreview, now())
    next.account = accountKey(settings)
    summary = next
    Promise.resolve(d.saveSummary(next)).catch((err) => {
      log('keeper: summary write failed: ' + ((err && err.message) || err))
    })
    publish()

    if (!primed) {
      primed = true
      return
    }
    const grew = next.total > prevTotal
    const cooled = now() - lastBuzzAt >= BUZZ_COOLDOWN_MS
    // Foreground means the user is looking at the app; the pages own the UI
    // and a buzz there is noise.
    if (grew && cooled && !foreground() && typeof d.vibrate === 'function') {
      lastBuzzAt = now()
      d.vibrate('short')
    }
  }

  function tick() {
    if (stopped || inflight) return Promise.resolve()
    clearTimer()
    // While the app is on screen it is the poller (its pages fetch the same
    // list); come back when the lease runs out instead of polling now.
    if (foreground()) {
      schedule(leaseRemaining(foregroundUntil, now()) + 1000)
      return Promise.resolve()
    }
    inflight = true
    const at = generation
    return Promise.resolve(d.loadSettings())

      .then((loaded) => {
        settings = loaded || {}
        if (!hasAccount(settings)) {
          log('keeper: no account configured, idle')
          return null
        }
        if (!shouldPoll({
          // Retention is not a user setting any more: a live service always may
          // poll. Only `stopped` (terminate / shutdown) turns it off.
          enabled: !stopped,
          ready: true,
          inflight: false,
          foreground: foreground()
        })) {
          return null
        }
        return Promise.resolve(d.listRooms()).then(apply)
      })
      .catch((err) => {
        // A failed poll keeps the last good summary: the watch is allowed to
        // show yesterday's unread badges while the network is gone.
        log('keeper: poll failed: ' + ((err && err.message) || err))
      })
      .then(() => {
        inflight = false
        // A poll that resolves after stop()/start() must not resurrect a timer
        // from the previous generation.
        if (at !== generation) return
        schedule()
      })
  }

  function start() {
    stopped = false
    generation += 1
    clearTimer()
    return Promise.resolve(d.loadSummary())
      .then((raw) => {
        summary = parseSummary(raw)
      })
      .catch((err) => {
        log('keeper: summary read failed: ' + ((err && err.message) || err))
      })
      .then(() => {
        if (!stopped) schedule(0)
      })
  }

  function stop() {
    stopped = true
    generation += 1
    inflight = false
    foregroundUntil = 0
    clearTimer()
  }

  function onConnect() {
    clients += 1
    // Hand the freshly connected page the retained list right away, so a cold
    // start renders unread badges before the network answers.
    publish()
  }

  function onDisConnect() {
    clients = clients > 0 ? clients - 1 : 0
    // The app unsubscribing is the cleanest "the user left" signal there is.
    // It is not trusted on its own (a killed process never disconnects), which
    // is why the lease exists, but it lets the service resume immediately
    // instead of waiting out the lease.
    if (clients === 0 && foreground()) {
      foregroundUntil = 0
      return tick()
    }
    return Promise.resolve()
  }

  function onMessage(clientId, params) {
    const type = params && params.type
    if (type === 'foreground') {
      // Renew the lease; the app repeats this from a heartbeat, and the service
      // comes back on its own if the renewals stop.
      foregroundUntil = now() + FOREGROUND_LEASE_MS
      clearTimer()
      schedule(FOREGROUND_LEASE_MS + 1000)
    } else if (type === 'background') {
      foregroundUntil = 0
      return tick()
    } else if (type === 'refresh') {
      return tick()
    } else if (type === 'summary') {
      publish()
    } else if (type === 'shutdown') {
      stop()
    }
    return Promise.resolve()
  }

  return {
    start,
    stop,
    tick,
    onConnect,
    onDisConnect,
    onMessage,
    summary: () => summary,
    state: () => ({
      clients: clients,
      foreground: foreground(),
      foregroundUntil: foregroundUntil,
      inflight: inflight,
      stopped: stopped,
      // Always true while the service is alive: retention has no off switch.
      enabled: !stopped,
      interval: interval()
    })
  }
}

export default {
  SERVICE_NAME,
  SUMMARY_KEY,
  MIN_BACKGROUND_INTERVAL_MS,
  BUZZ_COOLDOWN_MS,
  FOREGROUND_LEASE_MS,
  emptySummary,
  parseSummary,
  accountKey,
  hasAccount,
  summarizeRooms,
  shouldPoll,
  intervalFor,
  isForeground,
  leaseRemaining,
  createKeeper
}
