// Live credential smoke check for manual watch / VM testing.
//
//   node scripts/check-credentials.mjs           # 读 .env.local
//   node scripts/check-credentials.mjs --file other.env
//
// 只做三件事：探 /status.php、验 /ocs/v2.php/cloud/user、列 Talk 会话。
// 不打印密码，不写任何文件。口令可以只读访问，确认凭据有效即可。
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const OCS = '/ocs/v2.php'
const TIMEOUT_MS = 15000

export function parseEnv(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at < 1) continue
    const key = trimmed.slice(0, at).trim()
    let value = trimmed.slice(at + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export function readConfig(env) {
  const baseUrl = (env.NCTALK_BASE_URL || '').trim()
  const user = (env.NCTALK_USER || '').trim()
  const password = env.NCTALK_APP_PASSWORD || ''
  if (!baseUrl || !user || !password) {
    throw new Error('缺少 NCTALK_BASE_URL / NCTALK_USER / NCTALK_APP_PASSWORD，见 .env.example')
  }
  let instance
  try {
    instance = new URL(baseUrl)
  } catch {
    throw new Error('NCTALK_BASE_URL 不是合法 URL')
  }
  if (instance.protocol !== 'https:') throw new Error('只支持 HTTPS 实例')
  if (instance.username || instance.password || instance.search || instance.hash) {
    throw new Error('NCTALK_BASE_URL 不能带凭据、查询串或片段')
  }
  if (user.includes(':')) throw new Error('用户名不能包含冒号')
  return { baseUrl: instance.href.replace(/\/+$/, ''), user, password }
}

function authHeader(user, password) {
  return 'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64')
}

export async function checkCredentials({ baseUrl, user, password, send = fetch }) {
  const authorization = authHeader(user, password)
  const call = async (url, ocs) => {
    const response = await send(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: Object.assign(
        { Authorization: authorization },
        ocs ? { 'OCS-APIRequest': 'true', Accept: 'application/json' } : {}
      )
    })
    return response
  }

  const result = {}

  const status = await call(`${baseUrl}/status.php`)
  const statusBody = await status.json().catch(() => null)
  result.status = { http: status.status, installed: !!(statusBody && statusBody.installed) }
  if (!statusBody || !result.status.installed) throw new Error(`status.php 不可用（HTTP ${status.status}）`)

  const who = await call(`${baseUrl}${OCS}/cloud/user?format=json`, true)
  if (who.status !== 200) throw new Error(`cloud/user 返回 HTTP ${who.status}（应用密码无效或已吊销？）`)
  const whoBody = await who.json()
  const data = whoBody?.ocs?.data || {}
  result.user = { id: data.id, displayName: data.displayname, isAdmin: (data.groups || []).includes('admin') }

  const rooms = await call(`${baseUrl}${OCS}/apps/spreed/api/v4/room?format=json`, true)
  if (rooms.status !== 200) throw new Error(`Talk 会话列表返回 HTTP ${rooms.status}（spreed 未启用或版本过低？）`)
  const roomsBody = await rooms.json()
  const list = roomsBody?.ocs?.data
  if (!Array.isArray(list)) throw new Error('Talk 会话列表结构异常，响应可能不是 JSON（检查 OCS-APIRequest 头）')
  result.rooms = list
    .map((room) => ({
      token: room.token,
      name: room.displayName || room.name || '',
      unread: room.unreadMessages || 0,
      type: room.type
    }))
    .sort((a, b) => b.unread - a.unread)

  return result
}

async function main() {
  const args = process.argv.slice(2)
  const at = args.indexOf('--file')
  const file = path.resolve(at >= 0 && args[at + 1] ? args[at + 1] : '.env.local')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new Error(`读不到 ${path.basename(file)}，先复制 .env.example 再填`)
  }
  const config = readConfig(parseEnv(text))
  console.log(`目标：${config.baseUrl}（用户 ${config.user}）`)
  const result = await checkCredentials(config)
  console.log(`status.php：HTTP ${result.status.http}，已安装`)
  console.log(`身份校验：200，id=${result.user.id}，显示名=${result.user.displayName}${result.user.isAdmin ? '（管理员）' : ''}`)
  console.log(`Talk 会话：${result.rooms.length} 个`)
  for (const room of result.rooms) {
    console.log(`  - ${room.token}  ${room.name}  未读=${room.unread}`)
  }
  console.log('\n凭据可用。手表登录页填：服务器 ' + config.baseUrl + '，用户 ' + config.user + '，密码见 .env.local。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // URL 解析错误可能回显输入，只打自己的文案
    console.error('检查失败：' + (error.code === 'ERR_INVALID_URL' ? 'URL 不合法' : error.message))
    process.exitCode = 1
  })
}
