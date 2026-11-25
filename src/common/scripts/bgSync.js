// Background sync through `config.background` + `@system.request`.
//
// Why this exists next to the `keeper` micro service: Vela documents *two* ways
// to keep working after the app leaves the screen, and only one of them is a
// micro service.
//
//   1. config.background.features + at least one of those interfaces *running*
//      (guide/framework/other/background-running.html). While that holds the
//      whole app process keeps running, including app.ux timers, and
//      `system.fetch` is in the "directly accessible" set. This is how
//      HyperBilibili stays alive: it declares [system.request, system.audio] and
//      really does play video audio / download files, so the condition is met by
//      the work it was doing anyway.
//   2. The `keeper` micro service (features/other/serviceclient.html), which is
//      the only thing that survives the app being *closed* - and which has no
//      device support table at all.
//
// A chat client has no audio and no user-initiated download, so (1) needs an
// interface that is genuinely running. It has one: fetching the conversation
// list is a download, so the background tick *is* a `request.download` of the
// room list (JSON to a cache file, read back with `@system.file`, parsed). That
// is the honest use of 上传下载, not a silent audio track.
//
// Everything decision-shaped stays in keeper.js: this module is the transport
// (URL / headers / file / parse) plus the two numbers below, and app.ux binds it
// to a second `createKeeper` instance whose `listRooms` is `downloadRooms`.

import { MIN_BACKGROUND_INTERVAL_MS } from './keeper'

// Cadence of the in-app background tick.
//
// The quick-app spec puts a 20s countdown between "the last background interface
// finished" and "leave background mode" (doc.quickapp.cn 后台运行), so the gap
// between two downloads has to stay under it or the process is stopped between
// ticks. 15s is inside the window and matches the foreground cadence; the micro
// service keeps the cheaper 30s floor because it is not bound by that rule.
export const BG_SYNC_MS = 15000

// Floor for the in-app ticker. Same reasoning as BG_SYNC_MS, and deliberately
// below MIN_BACKGROUND_INTERVAL_MS - `intervalFor()` is handed both numbers.
export const SYNC_FLOOR_MS = 15000

// Same file every time: the download overwrites its predecessor, so a day of
// ticks is one file, not 5760 of them. `.txt`, not `.json` - the file API on
// older Vela builds refuses packaged/`json` resources (see the note in
// components/InputMethod/assets/dictionaryLoader.js).
export const ROOMS_FILE = 'nctalk-rooms.txt'

/** OCS endpoint that lists conversations (same one api.js uses). */
export function roomsUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return ''
  return base + '/ocs/v2.php/apps/spreed/api/v4/room?includeStatus=0'
}

/**
 * `request.download` takes its headers as a JSON *string* (verified against
 * HyperBilibili's player, which also handles an "invalid header" rejection).
 * Basic auth because OCS has no other option; `OCS-APIRequest` or Nextcloud
 * answers with a login page instead of JSON.
 */
export function downloadHeader(settings, encodeAuth) {
  const s = settings || {}
  const credentials = String(s.user || '') + ':' + String(s.appPassword || '')
  const auth = typeof encodeAuth === 'function' ? encodeAuth(credentials) : ''
  const headers = {
    Accept: 'application/json',
    'OCS-APIRequest': 'true'
  }
  if (auth) headers.Authorization = 'Basic ' + auth
  return JSON.stringify(headers)
}

/** The room list, or a throw. Tolerates a BOM and an empty body. */
export function parseRoomsFile(text) {
  const source = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim()
  if (!source) return []
  let payload = null
  try {
    payload = JSON.parse(source)
  } catch (e) {
    throw new Error('background sync: room list is not JSON')
  }
  // OCS wraps its answer in { ocs: { meta, data } }; `?format=json` on some
  // builds returns the bare array. Accept both, and nothing else.
  const data = payload && payload.ocs ? payload.ocs.data : payload
  if (!Array.isArray(data)) throw new Error('background sync: unexpected room list shape')
  return data
}

export default {
  BG_SYNC_MS,
  SYNC_FLOOR_MS,
  ROOMS_FILE,
  roomsUrl,
  downloadHeader,
  parseRoomsFile
}
