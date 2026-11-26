// Nextcloud Talk OCS client.
//
// Two ways in, one client:
//
//   account mode   HTTP Basic with a Nextcloud *app password*
//   public mode    a guest session in a public conversation, no account at all
//
// Account endpoints:
//   conversations  GET    /ocs/v2.php/apps/spreed/api/v4/room
//   messages       GET    /ocs/v2.php/apps/spreed/api/v1/chat/{token}
//   send message   POST   /ocs/v2.php/apps/spreed/api/v1/chat/{token}
//   reaction       POST/DELETE /ocs/v2.php/apps/spreed/api/v1/reaction/{token}/{messageId}
//   read marker    POST   /ocs/v2.php/apps/spreed/api/v1/chat/{token}/read
//   current user   GET    /ocs/v2.php/cloud/user
//
// Public mode (Talk guest access, no account):
//   join           POST   /ocs/v2.php/apps/spreed/api/v4/room/{token}/participants/active
//   guest name     POST   /ocs/v2.php/apps/spreed/api/v1/guest/{token}/name
//   room info      GET    /ocs/v2.php/apps/spreed/api/v4/room/{token}
//   then the same chat endpoints
//
// Auth: an account request carries Basic auth with a Nextcloud *app password*
// (never the account password). Every OCS request also needs
// `OCS-APIRequest: true`, otherwise Nextcloud answers with a login page and
// parsing fails with a confusing error.
//
// A guest has no password at all: Talk identifies it by the Nextcloud PHP
// session, which is a cookie. So the join response's `Set-Cookie` is captured
// here and replayed on every later request, and the cookies plus the guest actor
// id are persisted through store.js — every page is its own bundle with its own
// copy of this module, so without that each page would join as a brand new guest
// and the room would fill up with "guest joined" lines.

import fetch from '@system.fetch'
import base64Encode from './base64'
import store from './store'

const OCS = '/ocs/v2.php'
const TALK_V1 = OCS + '/apps/spreed/api/v1'
const TALK_V4 = OCS + '/apps/spreed/api/v4'
const REQUEST_TIMEOUT_MS = 20000

export const MODE_ACCOUNT = 'account'
export const MODE_PUBLIC = 'public'

// A guest session that died under us (server restart, expired cookie, cleared
// session table) is recovered by joining again and replaying the request once.
// If that replay fails the same way, the join was not worth repeating: Talk
// throttles token access per remote address, and a join loop would also drop a
// "guest joined" system message into the conversation every few seconds. So a
// failed recovery blocks the next one for this long.
const REJOIN_COOLDOWN_MS = 30000

let account = normaliseAccount({})

function blankSession() {
  return {
    target: '',
    joined: false,
    // Set when a rejoin + replay did not fix the session; cleared by a recovery
    // that works (or by configuring another target).
    recoveryFailedAt: 0,
    jar: {},
    cookies: '',
    actorId: '',
    sessionId: '',
    room: null,
    joining: null
  }
}

let session = blankSession()

function normaliseAccount(settings) {
  const s = settings || {}
  const mode = String(s.mode || '') === MODE_PUBLIC ? MODE_PUBLIC : MODE_ACCOUNT
  return {
    mode: mode,
    baseUrl: String(s.baseUrl || '').replace(/\/+$/, ''),
    user: String(s.user || ''),
    appPassword: String(s.appPassword || ''),
    roomToken: String(s.roomToken || '').trim().toLowerCase(),
    roomPassword: String(s.roomPassword || ''),
    roomDisplayName: String(s.roomDisplayName || '').trim(),
    roomName: String(s.roomName || '').trim(),
    roomActorId: String(s.roomActorId || '').trim(),
    sessionCookies: String(s.sessionCookies || '')
  }
}

// Which server/identity this module is pointed at. Changing it drops the live
// guest session: a cookie for another room must never be replayed.
function targetKey(credentials) {
  const c = credentials || {}
  if (!c.baseUrl) return ''
  if (c.mode === MODE_PUBLIC) return 'public|' + c.baseUrl + '|' + c.roomToken
  return 'account|' + c.baseUrl + '|' + c.user
}

function configure(settings) {
  const next = normaliseAccount(settings)
  const target = targetKey(next)
  account = next
  if (session.target !== target) {
    const jar = parseCookieHeader(next.sessionCookies)
    session = blankSession()
    session.target = target
    session.jar = jar
    session.cookies = cookieHeader(jar)
    session.actorId = next.roomActorId
    // A persisted actor id or cookie means this watch has joined before. If the
    // session behind it is gone, the first real request answers 404 and
    // request() rejoins once.
    session.joined = Boolean(next.sessionCookies || next.roomActorId)
  }
  account.sessionCookies = session.cookies
  account.roomActorId = session.actorId
}

function isPublicMode() {
  return account.mode === MODE_PUBLIC
}

function getMode() {
  return account.mode
}

function isConfigured() {
  if (isPublicMode()) return Boolean(account.baseUrl && account.roomToken)
  return Boolean(account.baseUrl && account.user && account.appPassword)
}

function buildUrl(baseUrl, path, query) {
  let url = baseUrl + path
  if (!query) return url

  const parts = []
  Object.keys(query).forEach((key) => {
    const value = query[key]
    if (value === undefined || value === null || value === '') return
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
  })

  if (parts.length === 0) return url
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + parts.join('&')
}

function getHeader(headers, name) {
  if (!headers) return ''
  const target = String(name).toLowerCase()
  const keys = Object.keys(headers)
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() === target) return headers[keys[i]]
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* guest session cookies                                               */
/* ------------------------------------------------------------------ */

function parseCookieHeader(text) {
  const jar = {}
  String(text || '').split(';').forEach((part) => {
    const pair = String(part).trim()
    if (!pair) return
    const index = pair.indexOf('=')
    if (index <= 0) return
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (name && value) jar[name] = value
  })
  return jar
}

function cookieHeader(jar) {
  const names = Object.keys(jar || {})
  const parts = []
  for (let i = 0; i < names.length; i += 1) {
    const value = jar[names[i]]
    if (value) parts.push(names[i] + '=' + value)
  }
  return parts.join('; ')
}

/**
 * Keep whatever the server set. Vela's fetch reports `response.headers` as the
 * server's headers, so `Set-Cookie` is the only channel through which a guest
 * session can survive — see the module comment.
 */
function absorbCookies(headers) {
  const raw = getHeader(headers, 'set-cookie')
  if (raw === '' || raw === undefined || raw === null) return false
  const entries = Array.isArray(raw) ? raw : [String(raw)]
  let changed = false

  entries.forEach((entry) => {
    const line = String(entry)
    // One header line can carry several cookies. Split on the commas that start
    // a new `name=`, so the comma inside an Expires date is not mistaken for a
    // separator.
    line.split(/,(?=\s*[^;,=\s]+=)/).forEach((cookie) => {
      const pair = String(cookie).split(';')[0]
      const index = pair.indexOf('=')
      if (index <= 0) return
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (!name) return
      const removed = !value ||
        value === 'deleted' ||
        /;\s*max-age\s*=\s*0\s*(;|$)/i.test(String(cookie)) ||
        /;\s*expires\s*=\s*thu,\s*01\s*jan\s*1970/i.test(String(cookie))
      if (removed) {
        if (Object.prototype.hasOwnProperty.call(session.jar, name)) {
          delete session.jar[name]
          changed = true
        }
        return
      }
      if (session.jar[name] !== value) {
        session.jar[name] = value
        changed = true
      }
    })
  })

  if (changed) session.cookies = cookieHeader(session.jar)
  return changed
}

/* ------------------------------------------------------------------ */
/* translations and errors                                             */
/* ------------------------------------------------------------------ */

let translate = (key) => key

function setTranslator(fn) {
  if (typeof fn === 'function') translate = fn
}

function translated(key, fallback) {
  const value = translate(key)
  return !value || value === key ? fallback : value
}

function describeStatus(status) {
  if (status === 401) return translated('chat.unauthorized', '账号或应用密码错误')
  const key = 'index.http' + status
  const fallbacks = {
    400: '请求被拒绝（参数错误）',
    403: '没有权限执行该操作',
    404: '会话不存在或已被删除',
    412: '会话尚未开放（等待室）',
    413: '消息过长',
    429: '操作过于频繁，请稍后再试',
    502: '服务器网关错误',
    503: '服务暂不可用'
  }
  if (Object.prototype.hasOwnProperty.call(fallbacks, status)) return translated(key, fallbacks[status])
  if (status >= 500) return translated('index.http500', '服务器错误（{status}）').replace('{status}', status)
  return translated('index.httpOther', '请求失败（{status}）').replace('{status}', status)
}

function apiError(status, message) {
  const err = new Error(message || describeStatus(status))
  err.status = status
  return err
}

/**
 * A join failure with the reason Talk actually gave. `403 {error:'password'}`
 * is the only way a wrong room password is ever reported; everything else is a
 * permissions or reachability problem.
 */
function describeJoinError(err) {
  const payload = err && err.payload
  const data = payload && payload.ocs ? payload.ocs.data : null
  const reason = data && data.error ? String(data.error) : ''
  if (err && err.status === 403) {
    if (reason === 'password') return apiError(403, translated('public.errPassword', '聊天室密码不正确'))
    if (reason === 'ban') return apiError(403, translated('public.errBanned', '你已被禁止进入该聊天室'))
  }
  if (err && err.status === 404) {
    return apiError(404, translated('public.errNotFound', '聊天室不存在，或未开放访客访问'))
  }
  return err
}

/* ------------------------------------------------------------------ */
/* transport                                                           */
/* ------------------------------------------------------------------ */

/**
 * Perform one OCS request, no session management.
 * Resolves with { status, data, headers, meta }; `data` is `ocs.data`.
 */
function perform(options, credentials) {
  return new Promise((resolve, reject) => {
    if (!credentials.baseUrl) {
      reject(apiError(0, '尚未设置服务器地址'))
      return
    }

    const url = buildUrl(credentials.baseUrl, options.path, options.query)
    const method = options.method || 'GET'
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      // The URL is the only thing that says whether a hang is "no network" or
      // "pointed at the wrong host/path" — and it is not visible on the watch.
      console.log('request timeout: ' + method + ' ' + url)
      const err = apiError(0, translated('chat.timeoutError', '网络请求超时'))
      err.code = 'TIMEOUT'
      reject(err)
    }, REQUEST_TIMEOUT_MS)
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }

    const headers = {
      Accept: 'application/json',
      'OCS-APIRequest': 'true'
    }
    if (credentials.mode === MODE_PUBLIC) {
      // The cookie *is* the guest's identity. A Basic header here would be
      // wrong, and a stale one would act as whichever account it names.
      const cookie = cookieHeader(session.jar)
      if (cookie) headers.Cookie = cookie
    } else {
      headers.Authorization = 'Basic ' + base64Encode(credentials.user + ':' + credentials.appPassword)
    }

    const params = {
      url: url,
      method: method,
      header: headers,
      responseType: 'text',
      success: (response) => {
        const status = response.code

        // The server can refresh the guest session on any answer, including an
        // error; keep whatever it sent before deciding what this one means.
        if (credentials.mode === MODE_PUBLIC) absorbCookies(response.headers)

        if (status === 304) {
          finish(resolve, { status: 304, data: null, headers: response.headers || {}, meta: null })
          return
        }

        let payload = null
        try {
          payload = response.data ? JSON.parse(response.data) : null
        } catch (e) {
          payload = null
        }

        const ocs = payload && payload.ocs
        const meta = ocs && ocs.meta ? ocs.meta : null
        const httpOk = status >= 200 && status < 300
        // OCS v2 can mirror the HTTP code in meta (e.g. 201 Created for chat sends).
        const ocsOk = meta && (
          meta.statuscode === 100 || meta.statuscode === 200 || meta.statuscode === status
        )

        if (httpOk && (ocsOk || (!meta && payload))) {
          finish(resolve, {
            status: status,
            data: ocs ? ocs.data : payload,
            headers: response.headers || {},
            meta: meta
          })
          return
        }

        // Surface the server's own message when it is more specific.
        const serverMessage = meta && meta.message && meta.message !== 'OK' ? meta.message : ''
        const err = apiError(status, serverMessage || describeStatus(status))
        err.payload = payload
        finish(reject, err)
      },
      fail: (data, code) => {
        const detail = typeof data === 'string' ? data : (data && data.data) || ''
        // `code` is the platform's error code (DNS / TLS / connect); it is the
        // one piece of evidence a hung handshake leaves behind. When the
        // platform sends no text, the code is the only thing worth showing, so
        // put it in the message the watch actually renders.
        console.log('fetch fail: ' + method + ' ' + url + ' code=' + code + (detail ? ' ' + detail : ''))
        const cause = detail || (code === undefined || code === null || code === '' ? '' : 'code=' + code)
        const err = apiError(0, translated('index.fetchError', '网络请求失败') + (cause ? '：' + cause : ''))
        err.code = code
        finish(reject, err)
      }
    }

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      params.data = JSON.stringify(options.body)
    }

    try {
      fetch.fetch(params)
    } catch (err) {
      finish(reject, apiError(0, translated('index.fetchError', '网络请求失败') + '：' + ((err && err.message) || err)))
    }
  })
}

/* ------------------------------------------------------------------ */
/* guest session                                                       */
/* ------------------------------------------------------------------ */

function roomView(data, fallbackToken) {
  const room = data || {}
  const token = String(room.token || fallbackToken || '')
  return {
    token: token,
    name: String(room.displayName || room.name || token),
    lastActivity: Number(room.lastActivity || 0),
    lastMessage: room.lastMessage || null,
    unreadMessages: Number(room.unreadMessages || 0)
  }
}

/**
 * Persist the session record. Read-modify-write on purpose: this module only
 * knows its own fields, and replacing the whole settings object would drop the
 * keyboard preference or the credentials of the other mode.
 */
function persistSession() {
  const patch = {
    roomName: session.room ? session.room.name : '',
    roomActorId: session.actorId,
    sessionCookies: session.cookies
  }
  account.roomActorId = patch.roomActorId
  account.sessionCookies = patch.sessionCookies
  store.load()
    .then((settings) => {
      const current = settings || {}
      if (current.roomName === patch.roomName &&
          current.roomActorId === patch.roomActorId &&
          current.sessionCookies === patch.sessionCookies) {
        return null
      }
      return store.save(Object.assign({}, current, patch))
    })
    .catch((err) => {
      // Losing the record only costs one extra join the next time round.
      console.log('guest session not persisted: ' + ((err && err.message) || err))
    })
}

/**
 * Tell Talk who this guest is. A join does not carry a display name, so without
 * this the room sees "Guest". Cosmetic only: a server that refuses the rename
 * (permissions, older Talk) must not turn a working session into a failed join.
 */
function setGuestName(credentials, token) {
  const displayName = credentials.roomDisplayName
  if (!displayName) return Promise.resolve()
  return perform({
    path: TALK_V1 + '/guest/' + encodeURIComponent(token) + '/name',
    method: 'POST',
    body: { displayName: displayName }
  }, credentials)
}

function joinSession(credentials) {
  const creds = credentials || account
  const token = creds.roomToken
  if (!token) return Promise.reject(apiError(0, translated('public.errNoRoom', '尚未设置聊天室')))

  const body = { force: true }
  // An empty password is not sent at all: Talk treats a missing password as
  // "this room has none", which is exactly what an unprotected room is.
  if (creds.roomPassword) body.password = creds.roomPassword

  session.joined = false
  return perform({
    path: TALK_V4 + '/room/' + encodeURIComponent(token) + '/participants/active',
    method: 'POST',
    body: body
  }, creds)
    .catch((err) => {
      throw describeJoinError(err)
    })
    .then((res) => {
      const data = res.data || {}
      session.target = targetKey(creds)
      session.joined = true
      session.sessionId = String(data.sessionId || '')
      // For a guest this is sha1(session id): the same value the chat messages
      // carry as `actorId`, which is how the chat page tells "mine" apart.
      session.actorId = String(data.actorId || '')
      session.room = roomView(data, token)
      persistSession()
      return setGuestName(creds, token).then(() => getSession(), () => getSession())
    })
}

function getSession() {
  return {
    actorId: session.actorId,
    sessionId: session.sessionId,
    cookies: session.cookies,
    joined: session.joined,
    room: session.room
  }
}

/** Join if this page has not got a session yet; single flight per page. */
function ensureSession(credentials) {
  const creds = credentials || account
  if (creds.mode !== MODE_PUBLIC) return Promise.resolve(getSession())
  if (!creds.roomToken) return Promise.reject(apiError(0, translated('public.errNoRoom', '尚未设置聊天室')))
  if (session.joined && session.target === targetKey(creds)) return Promise.resolve(getSession())
  if (session.joining) return session.joining

  const running = joinSession(creds).then(
    (result) => {
      session.joining = null
      return result
    },
    (err) => {
      session.joining = null
      throw err
    }
  )
  session.joining = running
  return running
}

function isSessionLoss(err) {
  // Talk answers a request whose session it no longer knows with 404
  // (ParticipantNotFoundException), and an explicit auth failure with 401.
  return Boolean(err) && (err.status === 401 || err.status === 404)
}

function sessionLostError(caught) {
  const err = apiError(caught ? caught.status : 0, translated('public.sessionLost', '访客会话已失效，请重试'))
  err.code = 'SESSION'
  err.cause = caught
  return err
}

/* ------------------------------------------------------------------ */
/* requests                                                            */
/* ------------------------------------------------------------------ */

function request(options, credentials) {
  const creds = credentials || account
  if (!creds.baseUrl) return Promise.reject(apiError(0, '尚未设置服务器地址'))

  // Account mode: one request, no session bookkeeping.
  if (creds.mode !== MODE_PUBLIC) return perform(options, creds)

  const send = () => perform(options, creds)
  return ensureSession(creds).then(() => {
    return send().catch((err) => {
      if (!isSessionLoss(err)) throw err
      if (session.recoveryFailedAt &&
          Date.now() - session.recoveryFailedAt < REJOIN_COOLDOWN_MS) {
        throw sessionLostError(err)
      }
      // The session this page inherited (from storage) is gone: join again and
      // replay the request once. A wrong room password surfaces from the join
      // itself, which is a far better message than "conversation not found".
      return joinSession(creds).then(() => send().then(
        (result) => {
          session.recoveryFailedAt = 0
          return result
        },
        (retryErr) => {
          if (!isSessionLoss(retryErr)) throw retryErr
          // Joining did not help: stop trying for a while.
          session.recoveryFailedAt = Date.now()
          throw sessionLostError(retryErr)
        }
      ))
    })
  })
}

/** Validate credentials and return { id, displayName }. */
function getCurrentUser(settings) {
  // A candidate account should not replace the live credentials until saved.
  const credentials = settings ? normaliseAccount(settings) : account
  if (!credentials.baseUrl) {
    return Promise.reject(apiError(0, '尚未设置服务器地址'))
  }
  if (!/^https:\/\//i.test(credentials.baseUrl)) {
    return Promise.reject(apiError(0, '服务器地址必须使用 HTTPS'))
  }
  if (credentials.mode === MODE_PUBLIC) {
    return Promise.reject(apiError(0, translated('public.noUser', '公开聊天室没有账号信息')))
  }
  return perform({ path: OCS + '/cloud/user' }, credentials).then((res) => {
    const data = res.data || {}
    return {
      id: data.id || credentials.user,
      displayName: data.displayname || data.id || credentials.user
    }
  })
}

/** List conversations, newest activity first. Account mode only. */
function listConversations() {
  if (isPublicMode()) {
    return Promise.reject(apiError(0, translated('public.noList', '公开聊天室没有会话列表')))
  }
  return request({ path: TALK_V4 + '/room', query: { includeStatus: 0 } }).then((res) => {
    const rooms = Array.isArray(res.data) ? res.data.slice() : []
    rooms.sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0))
    return rooms
  })
}

/**
 * The public conversation this watch is configured for.
 * Ensures a guest session, then reads the room so the caller gets a current
 * title / last message for its list card.
 */
function publicRoom() {
  const creds = account
  if (creds.mode !== MODE_PUBLIC) {
    return Promise.reject(apiError(0, translated('public.errNoRoom', '尚未设置聊天室')))
  }
  return ensureSession(creds)
    .then(() => perform({ path: TALK_V4 + '/room/' + encodeURIComponent(creds.roomToken) }, creds))
    .then((res) => {
      session.room = roomView(res.data, creds.roomToken)
      return Object.assign({}, session.room, { actorId: session.actorId })
    })
}

/**
 * Join the configured public conversation and report what came back.
 * Always joins: this is the login/setup validation path, so a changed room
 * password has to be checked against the server, not against a cached session.
 * Reusing the stored cookie keeps the guest identity stable across joins.
 */
function joinPublicRoom() {
  const creds = account
  if (creds.mode !== MODE_PUBLIC) {
    return Promise.reject(apiError(0, translated('public.errNoRoom', '尚未设置聊天室')))
  }
  session.joining = null
  return joinSession(creds).then(() => publicRoom())
}

/**
 * Fetch messages of a conversation.
 * options: { lastKnownMessageId, limit, lookIntoFuture, timeout }
 * Resolves with { messages, lastGiven } in server order.
 */
function getMessages(token, options) {
  const opts = options || {}
  const query = {
    lookIntoFuture: opts.lookIntoFuture ? 1 : 0,
    limit: opts.limit || 30,
    setReadMarker: 0,
    markNotificationsAsRead: 0
  }
  if (opts.lookIntoFuture && opts.timeout !== undefined) query.timeout = opts.timeout
  if (opts.lastKnownMessageId) query.lastKnownMessageId = opts.lastKnownMessageId

  return request({ path: TALK_V1 + '/chat/' + encodeURIComponent(token), query: query }).then(
    (res) => {
      const messages = Array.isArray(res.data) ? res.data.slice() : []
      const lastGiven = Number(getHeader(res.headers, 'X-Chat-Last-Given')) || 0
      return { messages: messages, lastGiven: lastGiven, notModified: res.status === 304 }
    }
  )
}

/** Send text, optionally replying to a numeric message ID. Resolves with the created message. */
function sendMessage(token, text, replyTo) {
  const body = { message: text }
  if (replyTo !== undefined) body.replyTo = replyTo
  // Guests have no account row to take a name from, so Talk reads it from the
  // payload (ignored for logged-in users).
  if (isPublicMode() && account.roomDisplayName) body.actorDisplayName = account.roomDisplayName
  return request({
    path: TALK_V1 + '/chat/' + encodeURIComponent(token),
    method: 'POST',
    body: body
  }).then((res) => res.data)
}

/** Add or remove the current user's reaction. Resolves with emoji counts, or null if unavailable. */
function setReaction(token, messageId, reaction, active) {
  const path = TALK_V1 + '/reaction/' + encodeURIComponent(token) + '/' + encodeURIComponent(messageId)
  // Match the Talk web client: DELETE carries its parameter in the URL, not a body.
  const options = active
    ? { path: path, method: 'POST', body: { reaction: reaction } }
    : { path: path, method: 'DELETE', query: { reaction: reaction } }
  return request(options).then((res) => {
    const actorsByReaction = res.data
    if (!actorsByReaction || typeof actorsByReaction !== 'object') return null
    // Nextcloud 24 serializes an empty reaction map as [] instead of {}.
    if (Array.isArray(actorsByReaction)) return actorsByReaction.length ? null : {}

    const counts = {}
    const reactions = Object.keys(actorsByReaction)
    for (let i = 0; i < reactions.length; i += 1) {
      const emoji = reactions[i]
      const actors = actorsByReaction[emoji]
      if (!Array.isArray(actors)) return null
      if (actors.length > 0 && emoji !== '__proto__') counts[emoji] = actors.length
    }
    return counts
  })
}

/** Tell the server the conversation was read up to `messageId`. */
function markRead(token, messageId) {
  if (!messageId) return Promise.resolve()
  return request({
    path: TALK_V1 + '/chat/' + encodeURIComponent(token) + '/read',
    method: 'POST',
    body: { lastReadMessage: Number(messageId) }
  }).then(() => undefined)
}

export default {
  MODE_ACCOUNT,
  MODE_PUBLIC,
  setTranslator,
  configure,
  isConfigured,
  isPublicMode,
  getMode,
  getSession,
  getCurrentUser,
  listConversations,
  publicRoom,
  joinPublicRoom,
  getMessages,
  sendMessage,
  setReaction,
  markRead,
  REQUEST_TIMEOUT_MS
}
