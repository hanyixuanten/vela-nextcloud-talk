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

/** Who polls right now: the pages while foreground, the service while not. */
export function shouldPoll(state) {
  const s = state || {}
  if (!s.enabled || !s.ready || s.inflight) return false
  // Foreground pages fetch the same list on show, and pages/chat runs its own
  // shorter message poll. A second poller would only duplicate traffic.
  return !s.foreground
}

export function intervalFor(pollInterval) {
  const value = Number(pollInterval) || 0
  return value > MIN_BACKGROUND_INTERVAL_MS ? value : MIN_BACKGROUND_INTERVAL_MS
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
  let clients = 0
  let foreground = false
  let inflight = false
  let stopped = false
  // The first successful poll only establishes a baseline: everything already
  // unread when the service starts must not buzz.
  let primed = false
  let lastBuzzAt = 0

  function interval() {
    return intervalFor(settings && settings.pollInterval)
  }

  function enabled() {
    return !settings || settings.backgroundKeep !== false
  }

  function clearTimer() {
    if (timerId !== null && timerId !== undefined) {
      d.clearTimer(timerId)
      timerId = null
    }
  }

  function schedule(delay) {
    if (stopped || foreground) return
    if (!enabled()) return
    clearTimer()
    timerId = d.setTimer(() => {
      timerId = null
      tick()
    }, delay === undefined ? interval() : delay)
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
    if (grew && cooled && !foreground && typeof d.vibrate === 'function') {
      lastBuzzAt = now()
      d.vibrate('short')
    }
  }

  function tick() {
    if (stopped || inflight) return Promise.resolve()
    clearTimer()
    inflight = true
    return Promise.resolve(d.loadSettings())
      .then((loaded) => {
        settings = loaded || {}
        if (!hasAccount(settings)) {
          log('keeper: no account configured, idle')
          return null
        }
        if (!shouldPoll({
          enabled: enabled(),
          ready: true,
          inflight: false,
          foreground: foreground
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
        schedule()
      })
  }

  function start() {
    stopped = false
    return Promise.resolve(d.loadSummary())
      .then((raw) => {
        summary = parseSummary(raw)
      })
      .catch((err) => {
        log('keeper: summary read failed: ' + ((err && err.message) || err))
      })
      .then(() => {
        schedule(0)
      })
  }

  function stop() {
    stopped = true
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
  }

  function onMessage(clientId, params) {
    const type = params && params.type
    if (type === 'foreground') {
      foreground = true
      clearTimer()
    } else if (type === 'background') {
      foreground = false
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
      foreground: foreground,
      inflight: inflight,
      stopped: stopped,
      enabled: enabled(),
      interval: interval()
    })
  }
}

export default {
  SERVICE_NAME,
  SUMMARY_KEY,
  MIN_BACKGROUND_INTERVAL_MS,
  BUZZ_COOLDOWN_MS,
  emptySummary,
  parseSummary,
  accountKey,
  hasAccount,
  summarizeRooms,
  shouldPoll,
  intervalFor,
  createKeeper
}
