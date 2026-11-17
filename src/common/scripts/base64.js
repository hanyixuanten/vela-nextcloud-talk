// Base64 encoder for HTTP Basic auth.
//
// The Vela JS runtime does not guarantee `btoa`, and `btoa` only accepts
// Latin-1 anyway. Nextcloud usernames/app passwords may contain non-ASCII
// characters, so we encode UTF-8 bytes ourselves.

function toUtf8Bytes(str) {
  const bytes = []
  for (let i = 0; i < str.length; i += 1) {
    let code = str.charCodeAt(i)

    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: try to pair it with the following low surrogate.
      const next = str.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        )
        i += 1
      } else {
        // Unpaired surrogate: emit U+FFFD replacement character.
        bytes.push(0xef, 0xbf, 0xbd)
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes.push(0xef, 0xbf, 0xbd)
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return bytes
}

const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export default function base64Encode(input) {
  const bytes = toUtf8Bytes(String(input == null ? '' : input))
  let out = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]

    out += TABLE[b0 >> 2]
    out += TABLE[((b0 & 0x03) << 4) | ((b1 === undefined ? 0 : b1) >> 4)]

    if (b1 === undefined) {
      out += '=='
    } else {
      out += TABLE[((b1 & 0x0f) << 2) | ((b2 === undefined ? 0 : b2) >> 6)]
      out += b2 === undefined ? '=' : TABLE[b2 & 0x3f]
    }
  }

  return out
}
