// Mock Nextcloud Talk server for guest (public conversation) access.
//
// It mirrors the two things the real server does that a client has to get right:
//
//   - a guest is identified by the Nextcloud PHP *session cookie*, not by a
//     header. `POST /room/{token}/participants/active` starts the session (and
//     answers with `Set-Cookie`), every later request has to replay it;
//   - a request whose session the server no longer knows is answered with 404
//     (`ParticipantNotFoundException`), not 401.
//
// `forgetSessions()` and `rejectChat()` reproduce the two failure shapes: a
// server that lost the session (recoverable by joining again) and one that
// rejects every joined session (which the client must not answer with a join
// loop).
import http from 'node:http'
import crypto from 'node:crypto'

export const ROOMS = {
  pubaaa: { token: 'pubaaa', displayName: '公开群', password: '', lastActivity: 300 },
  pubpass: { token: 'pubpass', displayName: '加密群', password: 'room-pass', lastActivity: 200 }
}

export const seen = []

// sessionId -> { token, name, actorId }
const sessions = new Map()
const messages = { pubaaa: [], pubpass: [] }
let rejectChatEnabled = false
let nextMessageId = 1

export function reset() {
  seen.length = 0
  sessions.clear()
  messages.pubaaa.length = 0
  messages.pubpass.length = 0
  rejectChatEnabled = false
  nextMessageId = 1
}

export function forgetSessions() {
  sessions.clear()
}

export function rejectChat(value = true) {
  rejectChatEnabled = Boolean(value)
}

function actorIdFor(sessionId) {
  // Talk sets a guest actor id to sha1(session id); the chat page relies on the
  // join response and the messages agreeing on it.
  return crypto.createHash('sha1').update(sessionId).digest('hex')
}

function sessionOf(req) {
  const raw = req.headers.cookie || ''
  const match = /(?:^|;\s*)nc_session_id=([^;]+)/.exec(raw)
  return match ? match[1] : ''
}

function envelope(res, data, status = 200, headers = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers))
  res.end(JSON.stringify({
    ocs: { meta: { status: status < 400 ? 'ok' : 'failure', statuscode: status, message: status < 400 ? 'OK' : 'error' }, data: data }
  }))
}

function roomPayload(room, sessionId, actorId) {
  return {
    token: room.token,
    displayName: room.displayName,
    name: room.displayName,
    lastActivity: room.lastActivity,
    sessionId: sessionId || '0',
    actorId: actorId || '',
    actorType: 'guests',
    hasPassword: Boolean(room.password),
    unreadMessages: 0
  }
}

export function start() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })

    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        cookie: req.headers.cookie || '',
        ocs: req.headers['ocs-apirequest'],
        body: body
      })

      const url = new URL(req.url, 'http://localhost')
      const path = url.pathname

      const joinRoute = /^\/ocs\/v2\.php\/apps\/spreed\/api\/v4\/room\/([a-z0-9]+)\/participants\/active$/.exec(path)
      if (joinRoute) {
        const room = ROOMS[joinRoute[1]]
        if (!room) return envelope(res, null, 404)
        let payload = {}
        try {
          payload = body ? JSON.parse(body) : {}
        } catch (_) {
          payload = {}
        }
        if (room.password && String(payload.password || '') !== room.password) {
          envelope(res, { error: 'password' }, 403)
          return
        }
        // Rejoining with the cookie of a live session keeps the same guest; a
        // client that drops the cookie looks like a new person every time.
        const existing = sessionOf(req)
        let sessionId = existing && sessions.has(existing) && sessions.get(existing).token === room.token
          ? existing
          : crypto.randomBytes(16).toString('hex')
        const previous = sessions.get(sessionId)
        const record = previous || { token: room.token, name: '', actorId: actorIdFor(sessionId) }
        sessions.set(sessionId, record)
        envelope(
          res,
          roomPayload(room, sessionId, record.actorId),
          200,
          { 'Set-Cookie': 'nc_session_id=' + sessionId + '; path=/; HttpOnly' }
        )
        return
      }

      const nameRoute = /^\/ocs\/v2\.php\/apps\/spreed\/api\/v1\/guest\/([a-z0-9]+)\/name$/.exec(path)
      if (nameRoute) {
        const room = ROOMS[nameRoute[1]]
        const sessionId = sessionOf(req)
        const record = sessionId ? sessions.get(sessionId) : null
        if (!room || !record || record.token !== room.token) return envelope(res, null, 404)
        let payload = {}
        try {
          payload = body ? JSON.parse(body) : {}
        } catch (_) {
          payload = {}
        }
        record.name = String(payload.displayName || '').trim()
        envelope(res, null)
        return
      }

      const roomRoute = /^\/ocs\/v2\.php\/apps\/spreed\/api\/v4\/room\/([a-z0-9]+)$/.exec(path)
      if (roomRoute) {
        const room = ROOMS[roomRoute[1]]
        if (!room) return envelope(res, null, 404)
        // Reading a public room works anonymously; it says nothing about the
        // session, which is exactly why the chat endpoint is the one that
        // detects a dead guest session.
        const sessionId = sessionOf(req)
        const record = sessionId ? sessions.get(sessionId) : null
        return envelope(res, roomPayload(room, sessionId, record ? record.actorId : ''))
      }

      const chatRoute = /^\/ocs\/v2\.php\/apps\/spreed\/api\/v1\/chat\/([a-z0-9]+)(\/read)?$/.exec(path)
      if (chatRoute) {
        const room = ROOMS[chatRoute[1]]
        const sessionId = sessionOf(req)
        const record = sessionId ? sessions.get(sessionId) : null
        if (!room || rejectChatEnabled || !record || record.token !== room.token) {
          // ParticipantNotFoundException, as the real middleware reports it.
          return envelope(res, null, 404)
        }
        if (chatRoute[2]) return envelope(res, null)

        if (req.method === 'POST') {
          let payload = {}
          try {
            payload = body ? JSON.parse(body) : {}
          } catch (_) {
            payload = {}
          }
          if (!payload.message) return envelope(res, { error: 'message' }, 400)
          const created = {
            id: nextMessageId++,
            token: room.token,
            actorType: 'guests',
            actorId: record.actorId,
            actorDisplayName: String(payload.actorDisplayName || record.name || ''),
            message: payload.message,
            timestamp: 1000 + nextMessageId,
            messageType: 'comment',
            isReplyable: true
          }
          messages[room.token].push(created)
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ocs: { meta: { status: 'ok', statuscode: 201, message: 'OK' }, data: created }
          }))
          return
        }

        const list = messages[room.token]
        if (!list.length) {
          res.writeHead(304).end()
          return
        }
        return envelope(res, list.slice(), 200, { 'X-Chat-Last-Given': String(list[list.length - 1].id) })
      }

      envelope(res, null, 500)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}
