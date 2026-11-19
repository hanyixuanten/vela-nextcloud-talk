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

        const query = new URL(req.url, 'http://localhost').searchParams
        const cursor = Number(query.get('lastKnownMessageId'))
        const limit = Number(query.get('limit'))
        const forward = query.get('lookIntoFuture') === '1'
        const page = (forward
          ? messages.filter((m) => m.id > cursor)
          : messages.filter((m) => !cursor || m.id < cursor).reverse()).slice(0, limit)
        if (!page.length) {
          res.writeHead(304).end()
        } else {
          envelope(page, { 'X-Chat-Last-Given': String(page.at(-1).id) })
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
