// Credential handoff protocol (watch side).
//
// The AstroBox plugin (astrobox-plugin/, Rust) sends a CredentialMessage over
// interconnect; the watch answers with an Ack. Keep this file and
// astrobox-plugin/src/protocol.rs in sync — the constants and field names are
// the contract.

export const PKG_NAME = 'com.hanyixuanten.nctalk'
export const PROTOCOL_VERSION = 1

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Parse an incoming credential message.
 * Returns { ok: true, config: { baseUrl, user, appPassword } }
 *      or { ok: false, error: '<human readable reason>' }.
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
  if (payload.v !== PROTOCOL_VERSION) {
    return { ok: false, requestId, error: '插件版本与手表应用不匹配（协议 v' + payload.v + '）' }
  }

  const baseUrl = typeof payload.base_url === 'string' ? payload.base_url.trim().replace(/\/+$/, '') : ''
  const user = typeof payload.user === 'string' ? payload.user.trim() : ''
  const appPassword = typeof payload.app_password === 'string' ? payload.app_password.trim() : ''

  if (!isNonEmptyString(baseUrl) || !isNonEmptyString(user) || !isNonEmptyString(appPassword)) {
    return { ok: false, requestId, error: '服务器、用户名、应用密码都不能为空' }
  }
  if (!/^https:\/\//i.test(baseUrl)) {
    return { ok: false, requestId, error: '服务器地址必须使用 https://' }
  }

  return { ok: true, requestId, config: { baseUrl: baseUrl, user: user, appPassword: appPassword } }
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
  parseCredentialMessage,
  buildAck
}
