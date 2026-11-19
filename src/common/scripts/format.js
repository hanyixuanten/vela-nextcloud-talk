// Display helpers: timestamps, Rich Object Strings, avatar initials.

const WEEKDAY_KEYS = ['common.weekdaySun', 'common.weekdayMon', 'common.weekdayTue', 'common.weekdayWed', 'common.weekdayThu', 'common.weekdayFri', 'common.weekdaySat']

let translate = (key) => key

function setTranslator(fn) {
  if (typeof fn === 'function') translate = fn
}

function translated(key, fallback) {
  const value = translate(key)
  return !value || value === key ? fallback : value
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value)
}

/**
 * Format a Nextcloud unix timestamp (seconds) for a watch-sized row.
 * Today     -> 14:07
 * Yesterday -> 昨天
 * This year -> 3/14
 * Older     -> 2024/3/14
 */
function formatTime(seconds) {
  const ts = Number(seconds)
  if (!ts) return ''

  const date = new Date(ts * 1000)
  const now = new Date()

  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  if (sameDay) {
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
  }

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()

  if (isYesterday) return translated('common.yesterday', '昨天')

  if (date.getFullYear() === now.getFullYear()) {
    return date.getMonth() + 1 + '/' + date.getDate()
  }

  return date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate()
}

function formatClock(seconds) {
  const date = new Date(Number(seconds) * 1000)
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

function weekday(seconds) {
  const day = new Date(Number(seconds) * 1000).getDay()
  const fallback = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][day]
  return translated(WEEKDAY_KEYS[day], fallback)
}

/**
 * Nextcloud Talk messages are Rich Object Strings: the text contains
 * {placeholder} tokens that must be substituted from messageParameters.
 * Unknown placeholders are left untouched so nothing is silently lost.
 */
function renderMessage(message) {
  if (!message) return ''
  if (message.messageType === 'comment_deleted') return translated('chat.deleted', '消息已删除')

  const params = message.messageParameters || {}
  const text = String(message.message == null ? '' : message.message)

  return text.replace(/\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    const param = params[key]
    if (!param) return match
    if (param.name) return param.name
    if (param.id) return param.id
    return match
  })
}

/** Single-line preview for the conversation list. */
function preview(message) {
  const text = renderMessage(message)
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text
}

function previewWithAuthor(message) {
  if (!message) return ''
  const body = preview(message)
  if (!body) return ''
  if (message.systemMessage) return body
  const author = message.actorDisplayName || ''
  if (!author) return body
  return author + '：' + body
}

/** First visible character of a display name, for the round avatar. */
function initials(name) {
  const text = String(name || '').trim()
  if (!text) return '#'
  const first = Array.from(text)[0]
  return first.toUpperCase()
}

/** Stable color per conversation/user, so avatars stay recognisable. */
const AVATAR_COLORS = [
  '#0082c9', '#e9322d', '#d97706', '#059669',
  '#7c3aed', '#db2777', '#0891b2', '#65a30d'
]

function colorFor(seed) {
  const text = String(seed || '')
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 100000
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

export default {
  setTranslator,
  formatTime,
  formatClock,
  weekday,
  renderMessage,
  preview,
  previewWithAuthor,
  initials,
  colorFor
}
