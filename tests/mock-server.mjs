// Mock Nextcloud Talk OCS server, just enough to exercise api.js.
//
// It deliberately mirrors two real-world quirks:
//   - bad credentials return a 401 *HTML login page* when OCS-APIRequest is
//     missing, which is what makes the "JSON.parse failed" bug so confusing;
//   - the OCS envelope wraps data in ocs.meta / ocs.data.

import http from 'node:http'

const USER = 'alice'
const APP_PASSWORD = 'app-pass-word'
const EXPECTED_AUTH = 'Basic ' + Buffer.from(USER + ':' + APP_PASSWORD, 'utf8').toString('base64')

export const seen = []

const ROOMS = [
  {
    token: 'tokB',
    displayName: 'Team B',
    lastActivity: 100,
    unreadMessages: 0,
    lastMessage: { actorDisplayName: 'Bob', message: 'older', timestamp: 90 }
  },
  {
    token: 'tokA',
    displayName: 'Team A',
    lastActivity: 200,
    unreadMessages: 3,
    lastMessage: {
      actorDisplayName: 'Ann',
      message: 'hello {file1}',
      messageParameters: { file1: { name: 'a.pdf' } },
      timestamp: 190
    }
  }
]

const MESSAGES = [
  {
    id: 10,
    token: 'tokA',
    actorId: 'ann',
    actorDisplayName: 'Ann',
    message: 'first',
    timestamp: 100,
    messageType: 'comment',
    isReplyable: true
  },
  {
    id: 11,
    token: 'tokA',
    actorId: 'alice',
    actorDisplayName: 'Alice',
    message: 'second',
    timestamp: 110,
    messageType: 'comment',
    isReplyable: true
  }
]

export const EXPECTED = { USER, APP_PASSWORD, ROOMS, MESSAGES }

export function start() {
  const messages = MESSAGES.slice()
  const aliceReaction = { actorType: 'users', actorId: USER, actorDisplayName: 'Alice A.', timestamp: 121 }
  const reactionsById = new Map([
    [10, Object.assign(Object.create(null), {
      '👍': [{ actorType: 'users', actorId: 'ann', actorDisplayName: 'Ann', timestamp: 119 }]
    })]
  ])
  const withReactions = (message) => {
    const reactions = reactionsById.get(message.id)
    if (!reactions || !Object.keys(reactions).length) return message
    const counts = {}
    const own = []
    Object.keys(reactions).forEach((emoji) => {
      counts[emoji] = reactions[emoji].length
      if (reactions[emoji].some((actor) => actor.actorId === USER)) own.push(emoji)
    })
    return { ...message, reactions: counts, ...(own.length ? { reactionsSelf: own } : {}) }
  }
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
        ocs: req.headers['ocs-apirequest'],
        accept: req.headers.accept,
        body: body
      })

      const sendJson = (code, payload, extraHeaders) => {
        res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders))
        res.end(JSON.stringify(payload))
      }

      const envelope = (data, extraHeaders) =>
        sendJson(
          200,
          { ocs: { meta: { status: 'ok', statuscode: 200, message: 'OK' }, data: data } },
          extraHeaders
        )

      if (req.headers.authorization !== EXPECTED_AUTH) {
        res.writeHead(401, { 'Content-Type': 'text/html' })
        res.end('<html><body>Please log in</body></html>')
        return
      }

      if (req.url.indexOf('/ocs/v2.php/cloud/user') === 0) {
        envelope({ id: 'alice', displayname: 'Alice A.' })
        return
      }

      if (req.url.indexOf('/ocs/v2.php/apps/spreed/api/v4/room') === 0) {
        envelope(ROOMS)
        return
      }

      if (req.url.indexOf('/chat/notfound') >= 0) {
        sendJson(404, {
          ocs: { meta: { status: 'fail', statuscode: 404, message: 'Conversation not found' } }
        })
        return
      }

      const url = new URL(req.url, 'http://localhost')
      const reactionRoute = /^\/ocs\/v2\.php\/apps\/spreed\/api\/v1\/reaction\/([^/]+)\/(\d+)$/.exec(url.pathname)
      if (reactionRoute) {
        const messageId = Number(reactionRoute[2])
        const message = messages.find((row) => row.id === messageId && row.token === reactionRoute[1])
        const fail = (code, msg) => sendJson(code, {
          ocs: { meta: { status: 'failure', statuscode: code, message: msg }, data: null }
        })
        if (!message) return fail(404, 'Message not found')
        if (req.method !== 'POST' && req.method !== 'DELETE') return fail(405, 'Method not allowed')

        let reaction
        try {
          reaction = req.method === 'POST' ? JSON.parse(body).reaction : url.searchParams.get('reaction')
        } catch (_) {
          return fail(400, 'Invalid reaction payload')
        }
        if (!reaction || typeof reaction !== 'string') return fail(400, 'Reaction required')
        // Exercise a successful mutation without a usable reaction map.
        if (reaction === '🫥') return envelope(null)

        const reactions = reactionsById.get(messageId) || Object.create(null)
        const actors = reactions[reaction] || []
        const ownIndex = actors.findIndex((actor) => actor.actorId === USER)
        if (req.method === 'DELETE') {
          if (ownIndex < 0) return fail(404, 'Reaction not found')
          actors.splice(ownIndex, 1)
          if (!actors.length) delete reactions[reaction]
          // Use both current {} and Nextcloud 24's [] when the last reaction is removed.
          return envelope(messageId === 12 && !Object.keys(reactions).length ? [] : reactions)
        }
        if (ownIndex >= 0) return envelope(reactions)
        actors.push(aliceReaction)
        reactions[reaction] = actors
        reactionsById.set(messageId, reactions)
        return sendJson(201, { ocs: { meta: { status: 'ok', statuscode: 201, message: 'OK' }, data: reactions } })
      }

      if (req.url.indexOf('/chat/tokA/read') >= 0) {
        if (req.method !== 'POST') {
          sendJson(405, {})
          return
        }
        envelope({})
        return
      }

      if (req.url.indexOf('/chat/tokA') >= 0) {
        if (req.method === 'POST') {
          const parsed = JSON.parse(body)
          const replyTo = parsed.replyTo === undefined ? 0 : parsed.replyTo
          const parent = messages.find((row) => row.id === replyTo && row.token === 'tokA')
          if (replyTo !== 0 && (!parent || parent.messageType !== 'comment')) {
            sendJson(400, {
              ocs: {
                meta: { status: 'failure', statuscode: 400, message: '' },
                data: { error: 'reply-to' }
              }
            })
            return
          }
          const data = {
            id: messages.at(-1).id + 1,
            token: 'tokA',
            actorId: 'alice',
            actorDisplayName: 'Alice',
            message: parsed.message,
            timestamp: 120,
            messageType: 'comment',
            isReplyable: true
          }
          if (parent) {
            const { parent: _ancestor, ...snapshot } = parent
            data.parent = snapshot
          }
          messages.push(data)
          sendJson(
            201,
            { ocs: { meta: { status: 'ok', statuscode: 201, message: 'OK' }, data: data } },
            { 'X-Chat-Last-Common-Read': '11' }
          )
          return
        }

        const query = url.searchParams
        const cursor = Number(query.get('lastKnownMessageId'))
        const limit = Number(query.get('limit'))
        const forward = query.get('lookIntoFuture') === '1'
        const page = (forward
          ? messages.filter((m) => m.id > cursor)
          : messages.filter((m) => !cursor || m.id < cursor).reverse()).slice(0, limit)
        if (!page.length) {
          res.writeHead(304).end()
        } else {
          envelope(page.map(withReactions), { 'X-Chat-Last-Given': String(page.at(-1).id) })
        }
        return
      }

      sendJson(500, { ocs: { meta: { status: 'fail', statuscode: 500, message: 'boom' } } })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}
