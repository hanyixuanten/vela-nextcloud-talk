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
    messageType: 'comment'
  },
  {
    id: 11,
    token: 'tokA',
    actorId: 'alice',
    actorDisplayName: 'Alice',
    message: 'second',
    timestamp: 110,
    messageType: 'comment'
  }
]

export const EXPECTED = { USER, APP_PASSWORD, ROOMS, MESSAGES }

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
        if (req.method !== 'PUT') {
          sendJson(405, {})
          return
        }
        envelope({})
        return
      }

      if (req.url.indexOf('/chat/tokA') >= 0) {
        if (req.method === 'POST') {
          const parsed = JSON.parse(body)
          sendJson(
            201,
            {
              ocs: {
                meta: { status: 'ok', statuscode: 200, message: 'OK' },
                data: {
                  id: 12,
                  actorId: 'alice',
                  actorDisplayName: 'Alice',
                  message: parsed.message,
                  timestamp: 120,
                  messageType: 'comment'
                }
              }
            },
            { 'X-Chat-Last-Common-Read': '11' }
          )
          return
        }

        // With a cursor the server returns only newer messages: none here.
        const hasCursor = req.url.indexOf('lastKnownMessageId') >= 0
        sendJson(
          200,
          {
            ocs: {
              meta: { status: 'ok', statuscode: 200, message: 'OK' },
              data: hasCursor ? [] : MESSAGES
            }
          },
          { 'X-Chat-Last-Given': '11' }
        )
        return
      }

      sendJson(500, { ocs: { meta: { status: 'fail', statuscode: 500, message: 'boom' } } })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}
