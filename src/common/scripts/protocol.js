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
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: '收到的数据为空' }
  }

  let payload = null
  try {
    payload = JSON.parse(raw)
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
  if (payload.v !== PROTOCOL_VERSION) {
    return { ok: false, error: '插件版本与手表应用不匹配（协议 v' + payload.v + '）' }
  }

  const baseUrl = typeof payload.base_url === 'string' ? payload.base_url.trim().replace(/\/+$/, '') : ''
  const user = typeof payload.user === 'string' ? payload.user.trim() : ''
  const appPassword = typeof payload.app_password === 'string' ? payload.app_password.trim() : ''

  if (!isNonEmptyString(baseUrl) || !isNonEmptyString(user) || !isNonEmptyString(appPassword)) {
    return { ok: false, error: '服务器、用户名、应用密码都不为空' }
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, error: '服务器地址需以 http:// 或 https:// 开头' }
  }

  return { ok: true, config: { baseUrl: baseUrl, user: user, appPassword: appPassword } }
}

/** Build the acknowledgement string sent back to the plugin. */
export function buildAck(result) {
  const ack = result || {}
  return JSON.stringify({
    ok: Boolean(ack.ok),
    message: typeof ack.message === 'string' ? ack.message : '',
    display_name: typeof ack.displayName === 'string' ? ack.displayName : ''
  })
}

// Also exported as a namespace object: page scripts import the default (keeps
// the .ux compilation path simple), tests can use either form.
export default {
  PKG_NAME,
  PROTOCOL_VERSION,
  parseCredentialMessage,
  buildAck
}
