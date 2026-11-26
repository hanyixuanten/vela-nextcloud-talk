// Credential handoff protocol (watch side).
//
// The AstroBox plugin (astrobox-plugin/, Rust) sends a CredentialMessage over
// interconnect; the watch answers with an Ack. Keep this file and
// astrobox-plugin/src/protocol.rs in sync — the constants and field names are
// the contract.
//
// v2 adds the second way into the app: a public conversation joined as a guest.
// A v1 message is still accepted and means "account", so an older plugin keeps
// working against a newer watch; a newer plugin against an older watch fails
// loudly on the version check instead of saving half a configuration.

import { TOKEN_PATTERN, parseRoomLink } from './roomlink'

export const PKG_NAME = 'com.hanyixuanten.nctalk'
export const PROTOCOL_VERSION = 2
// v1 only ever carried an account. It is read as "account mode" instead of
// forcing an update, and the plugin's version check is what stops the reverse
// combination (a v2 message on a watch that cannot read it).
export const SUPPORTED_VERSIONS = [1, 2]

export const MODE_ACCOUNT = 'account'
export const MODE_PUBLIC = 'public'

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function httpsBaseUrl(value) {
  return readString(value).replace(/\/+$/, '')
}

/**
 * Parse an incoming credential message.
 * Returns one of:
 *   { ok: true, config: { mode, baseUrl, user, appPassword, roomToken,
 *                         roomPassword, roomDisplayName } }
 *   { ok: false, requestId, error, silent?, passwordFromLink? }
 */
export function parseCredentialMessage(raw) {
  if (raw == null || (typeof raw === 'string' && raw.trim().length === 0)) {
    return { ok: false, error: '收到的数据为空', silent: true }
  }

  let payload = raw
  try {
    if (typeof raw === 'string') payload = JSON.parse(raw)
  } catch (e) {
    // Not our message: interconnect is a shared channel, stay quiet.
    return { ok: false, error: '数据格式无法识别', silent: true }
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: '数据格式无法识别', silent: true }
  }
  if (payload.kind !== 'credentials') {
    return { ok: false, error: '不是凭据消息', silent: true }
  }
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : undefined
  if (SUPPORTED_VERSIONS.indexOf(payload.v) < 0) {
    return { ok: false, requestId, error: '插件版本与手表应用不匹配（协议 v' + payload.v + '）' }
  }

  // v1 has no mode field at all; anything that is not an explicit `public` is
  // an account, including a half-written v2 message.
  const mode = payload.mode === MODE_PUBLIC ? MODE_PUBLIC : MODE_ACCOUNT
  return mode === MODE_PUBLIC
    ? parsePublic(requestId, payload)
    : parseAccount(requestId, payload)
}

function parseAccount(requestId, payload) {
  const baseUrl = httpsBaseUrl(payload.base_url)
  const user = readString(payload.user)
  const appPassword = typeof payload.app_password === 'string' ? payload.app_password.trim() : ''

  if (!isNonEmptyString(baseUrl) || !isNonEmptyString(user) || !isNonEmptyString(appPassword)) {
    return { ok: false, requestId, error: '服务器、用户名、应用密码都不能为空' }
  }
  if (!/^https:\/\//i.test(baseUrl)) {
    return { ok: false, requestId, error: '服务器地址必须使用 https://' }
  }

  return {
    ok: true,
    requestId,
    config: {
      mode: MODE_ACCOUNT,
      baseUrl: baseUrl,
      user: user,
      appPassword: appPassword,
      roomToken: '',
      roomPassword: '',
      roomDisplayName: ''
    }
  }
}

function parsePublic(requestId, payload) {
  const displayName = readString(payload.display_name)
  const rawPassword = typeof payload.room_password === 'string' ? payload.room_password.trim() : ''

  // The plugin may send the link the user pasted (it is what the phone form
  // collects) or an already split base URL + token. Both end up here.
  let baseUrl = httpsBaseUrl(payload.base_url)
  let token = readString(payload.room_token).toLowerCase()
  let password = rawPassword

  if (isNonEmptyString(payload.room_link)) {
    const parsed = parseRoomLink(payload.room_link, baseUrl)
    if (!parsed.ok) {
      return { ok: false, requestId, error: '聊天室链接无效（形如 https://服务器/call/令牌）' }
    }
    baseUrl = parsed.baseUrl
    token = parsed.token
    if (!password && parsed.password) password = parsed.password
  }

  if (!isNonEmptyString(baseUrl) || !/^https:\/\//i.test(baseUrl)) {
    return { ok: false, requestId, error: '服务器地址必须使用 https://' }
  }
  if (!TOKEN_PATTERN.test(token)) {
    return { ok: false, requestId, error: '聊天室令牌无效（4–30 位小写字母或数字）' }
  }
  if (!displayName) {
    return { ok: false, requestId, error: '显示名称不能为空' }
  }

  return {
    ok: true,
    requestId,
    config: {
      mode: MODE_PUBLIC,
      baseUrl: baseUrl,
      user: '',
      appPassword: '',
      roomToken: token,
      roomPassword: password,
      roomDisplayName: displayName
    }
  }
}

/** Vela serialises the object passed to connect.send as JSON. */
export function buildAck(result) {
  const ack = result || {}
  const data = {
    ok: Boolean(ack.ok),
    message: typeof ack.message === 'string' ? ack.message : '',
    display_name: typeof ack.displayName === 'string' ? ack.displayName : ''
  }
  if (typeof ack.requestId === 'string') data.request_id = ack.requestId
  return data
}

// Also exported as a namespace object: page scripts import the default (keeps
// the .ux compilation path simple), tests can use either form.
export default {
  PKG_NAME,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  MODE_ACCOUNT,
  MODE_PUBLIC,
  parseCredentialMessage,
  buildAck
}
