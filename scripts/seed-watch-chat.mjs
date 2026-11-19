// Test data only: run against a dedicated Nextcloud Talk test room.
import { pathToFileURL } from 'node:url'

export const BASELINE_COUNT = 72

export function baselineMessage(run, index, count) {
  const prefix = `[watch-baseline ${run} ${String(index).padStart(3, '0')}/${count}]`
  if (index % 6 !== 0) return `${prefix} 普通文本 / short text 👋`
  return `${prefix} 长消息 ${'内存测试 Talk 😀 '.repeat(160)} END-OF-LONG-TEXT`
}

export async function seedChat({ baseUrl, token, user, password, count = BASELINE_COUNT, run, send = fetch }) {
  const instance = new URL(baseUrl)
  if (instance.protocol !== 'https:' || instance.username || instance.password || instance.search || instance.hash) {
    throw new Error('Use an HTTPS Nextcloud base URL without credentials, query, or fragment.')
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token) || !user || user.includes(':') || !password ||
      !Number.isInteger(count) || count < 1 || count > BASELINE_COUNT || !/^[A-Za-z0-9-]{1,40}$/.test(run)) {
    throw new Error('Invalid room token, test credentials, count, or run label.')
  }
  const endpoint = `${instance.href.replace(/\/+$/, '')}/ocs/v2.php/apps/spreed/api/v1/chat/${token}`
  const authorization = 'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64')
  for (let index = 1; index <= count; index++) {
    let response
    try {
      response = await send(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { Authorization: authorization, 'OCS-APIRequest': 'true', Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: baselineMessage(run, index, count) })
      })
    } catch {
      throw new Error(`Message ${index}/${count}: request failed, timed out, or was redirected. Stop and inspect the room before retrying.`)
    }
    // This fixture does not need a response body; don't buffer it or print it.
    if (response.body) await response.body.cancel().catch(() => {})
    if (response.status !== 201) {
      throw new Error(`Message ${index}/${count}: HTTP ${response.status}, expected 201. Stop and inspect the room before retrying.`)
    }
  }
}

async function main() {
  const [baseUrl, token, user, rawCount = String(BASELINE_COUNT), ...extra] = process.argv.slice(2)
  if (!baseUrl || !token || !user || !/^\d+$/.test(rawCount) || extra.length || process.stdin.isTTY) {
    throw new Error('Usage (password on stdin): node scripts/seed-watch-chat.mjs <https-base-url> <test-room-token> <test-user> [count]')
  }
  process.stdin.setEncoding('utf8')
  let password = ''
  for await (const chunk of process.stdin) {
    password += chunk
    if (password.length > 4096) throw new Error('Password input is too long.')
  }
  password = password.replace(/\r?\n$/, '')
  const run = new Date().toISOString().replace(/[^A-Za-z0-9-]/g, '-')
  const count = Number(rawCount)
  console.log(`Starting watch baseline run ${run} (${count} messages).`)
  await seedChat({ baseUrl, token, user, password, count, run })
  console.log(`Posted ${count} synthetic messages for ${run}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // URL parsing errors can embed user input; don't print them verbatim.
    console.error(error.code === 'ERR_INVALID_URL' ? 'Invalid Nextcloud base URL.' : error.message)
    process.exitCode = 1
  })
}
