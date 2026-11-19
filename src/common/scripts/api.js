// Nextcloud Talk OCS client.
//
// All calls go through the OCS JSON API:
//   conversations  GET    /ocs/v2.php/apps/spreed/api/v4/room
//   messages       GET    /ocs/v2.php/apps/spreed/api/v1/chat/{token}
//   send message   POST   /ocs/v2.php/apps/spreed/api/v1/chat/{token}
//   reaction       POST/DELETE /ocs/v2.php/apps/spreed/api/v1/reaction/{token}/{messageId}
//   read marker    POST   /ocs/v2.php/apps/spreed/api/v1/chat/{token}/read
//   current user   GET    /ocs/v2.php/cloud/user
//
// Auth is HTTP Basic with a Nextcloud *app password* (never the account
// password). Every OCS request also needs `OCS-APIRequest: true`, otherwise
// Nextcloud answers with a login page and parsing fails with a confusing error.

import fetch from '@system.fetch'
import base64Encode from './base64'

const OCS = '/ocs/v2.php'
const TALK_V1 = OCS + '/apps/spreed/api/v1'
const TALK_V4 = OCS + '/apps/spreed/api/v4'
const REQUEST_TIMEOUT_MS = 20000

let account = { baseUrl: '', user: '', appPassword: '' }

function normaliseAccount(settings) {
  const s = settings || {}
  return {
    baseUrl: String(s.baseUrl || '').replace(/\/+$/, ''),
    user: String(s.user || ''),
    appPassword: String(s.appPassword || '')
  }
}

function configure(settings) {
  account = normaliseAccount(settings)
}

function isConfigured() {
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
 * Perform one OCS request.
 * Resolves with { status, data, headers, meta }; `data` is `ocs.data`.
 */
function request(options, credentials = account) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
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

    if (!credentials.baseUrl) {
      finish(reject, apiError(0, '尚未设置服务器地址'))
      return
    }

    const headers = {
      Accept: 'application/json',
      'OCS-APIRequest': 'true',
      Authorization: 'Basic ' + base64Encode(credentials.user + ':' + credentials.appPassword)
    }

    const params = {
      url: buildUrl(credentials.baseUrl, options.path, options.query),
      method: options.method || 'GET',
      header: headers,
      responseType: 'text',
      success: (response) => {
        const status = response.code

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
        const err = apiError(0, translated('index.fetchError', '网络请求失败') + (detail ? '：' + detail : ''))
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
  return request({ path: OCS + '/cloud/user' }, credentials).then((res) => {
    const data = res.data || {}
    return {
      id: data.id || credentials.user,
      displayName: data.displayname || data.id || credentials.user
    }
  })
}

/** List conversations, newest activity first. */
function listConversations() {
  return request({ path: TALK_V4 + '/room', query: { includeStatus: 0 } }).then((res) => {
    const rooms = Array.isArray(res.data) ? res.data.slice() : []
    rooms.sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0))
    return rooms
  })
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
  setTranslator,
  configure,
  isConfigured,
  getCurrentUser,
  listConversations,
  getMessages,
  sendMessage,
  setReaction,
  markRead,
  REQUEST_TIMEOUT_MS
}
