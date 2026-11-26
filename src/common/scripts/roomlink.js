// Public conversation links → (server root, room token).
//
// Talk shares a public conversation as `https://<host>/call/<token>`; setups
// behind a path prefix add `/index.php` or `/apps/spreed`. The guest API needs
// the server root and the token separately, so the login form accepts the link
// people actually paste and this module does the split.
//
// A bare token is also accepted: it is the other half of a link, and the server
// half is already known once anything has been configured on this watch.
//
// No `URL` global on purpose: this runtime does not document it, and every other
// script in the app parses strings by hand for the same reason.

export const TOKEN_PATTERN = /^[a-z0-9]{4,30}$/

// Path segments that sit between the server root and the token. Popped from the
// right until one is not in this list, so `/nextcloud/index.php/call/<token>`
// yields `https://host/nextcloud`.
const LINK_SEGMENTS = ['call', 'spreed', 'apps', 'index.php']

export function normaliseBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function decode(value) {
  try {
    return decodeURIComponent(value)
  } catch (e) {
    return value
  }
}

function passwordFromQuery(query) {
  if (!query) return ''
  const parts = String(query).split('&')
  for (let i = 0; i < parts.length; i += 1) {
    const eq = parts[i].indexOf('=')
    const key = decode(eq < 0 ? parts[i] : parts[i].slice(0, eq))
    if (key === 'password') return decode(eq < 0 ? '' : parts[i].slice(eq + 1))
  }
  return ''
}

/**
 * Split a share link (or a bare token) into the two values the guest API needs.
 * Resolves as a plain object — this runtime has no exceptions worth bisecting:
 *   { ok: true, baseUrl, token, password }
 *   { ok: false, error: 'empty'|'scheme'|'host'|'token'|'base' }
 * `password` is only ever filled from a `?password=` in the pasted link; it is
 * never inferred.
 */
export function parseRoomLink(input, fallbackBaseUrl) {
  const text = String(input || '').trim()
  if (!text) return { ok: false, error: 'empty' }

  const url = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(text)
  if (!url) {
    // Accept a bare token only when a server is already known.
    const token = text.toLowerCase()
    if (!TOKEN_PATTERN.test(token)) {
      // `cloud.example.com/call/abcdef` is a link that lost its scheme; the
      // generic "invalid link" text would make that harder to fix.
      if (text.indexOf('/') >= 0) return { ok: false, error: 'scheme' }
      return { ok: false, error: 'token' }
    }
    const baseUrl = normaliseBaseUrl(fallbackBaseUrl)
    if (!baseUrl) return { ok: false, error: 'base' }
    return { ok: true, baseUrl: baseUrl, token: token, password: '' }
  }

  if (url[1].toLowerCase() !== 'https') return { ok: false, error: 'scheme' }
  const host = url[2] || ''
  if (!host || /\s/.test(host) || host.indexOf('@') >= 0) return { ok: false, error: 'host' }

  const segments = String(url[3] || '')
    .split('/')
    .filter((part) => part.length > 0)
  if (!segments.length) return { ok: false, error: 'token' }

  const token = decode(segments[segments.length - 1]).toLowerCase()
  // `…/call/` (a link that lost its token) must not parse as token `call`.
  if (LINK_SEGMENTS.indexOf(token) >= 0 || !TOKEN_PATTERN.test(token)) {
    return { ok: false, error: 'token' }
  }

  const rest = segments.slice(0, segments.length - 1)
  while (rest.length > 0 && LINK_SEGMENTS.indexOf(rest[rest.length - 1].toLowerCase()) >= 0) {
    rest.pop()
  }

  let baseUrl = 'https://' + host
  if (rest.length > 0) baseUrl += '/' + rest.join('/')

  return {
    ok: true,
    baseUrl: baseUrl,
    token: token,
    password: passwordFromQuery(url[4])
  }
}

/** Build the link again, for display in settings. */
export function buildRoomLink(baseUrl, token) {
  const base = normaliseBaseUrl(baseUrl)
  const room = String(token || '').trim()
  if (!base || !room) return ''
  return base + '/call/' + room
}

export default {
  TOKEN_PATTERN,
  normaliseBaseUrl,
  parseRoomLink,
  buildRoomLink
}
