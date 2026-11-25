// Text metrics and row splitting, shared by pages/chat (the bubble preview) and
// pages/message (the full-message page).
//
// Why this is a module instead of a few helpers inside chat.ux: the full-message
// page renders the very same rows the bubble is built from, and both have to
// agree on where a line breaks. Two copies would drift, and the watch has no
// inspector to show the drift.
//
// The shape that renders on this firmware is one `text` per visual line, with a
// definite pixel width and `lines: 1` (see docs/design.md §11). Natural
// multi-line text inside a bubble measured 0 tall for three releases, so the
// wrap is estimated here and the template only ever renders single-line rows.

// The bubble is 394 (413 on the rect screen) wide with 16px on each side.
export const ROW_WIDTH = 362

// Font scale drives both a class name (colour/type) and the metrics used to
// split a message into single-line rows.
export const FONT_SCALES = ['small', 'normal', 'large']
export const FONT_METRICS = {
  small: { size: 20 },
  normal: { size: 23 },
  large: { size: 27 }
}

/** Unknown or missing scale names fall back to `normal`, never to NaN. */
export function scaleName(value) {
  return FONT_SCALES.indexOf(value) >= 0 ? value : 'normal'
}

export function fontSizeOf(value) {
  return FONT_METRICS[scaleName(value)].size
}

/** CJK, kana, hangul and fullwidth forms are two latin units wide. */
export function isWideChar(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )
}

/**
 * Splits text into single-line rows of at most `ROW_WIDTH` design pixels.
 *
 * A row is a fixed-width `lines: 1` text, so the wrapping has to be estimated:
 * CJK counts 2 units, latin 1, and one row holds ROW_WIDTH / (size / 2) units.
 * A row can therefore end a glyph narrow or wide.
 *
 * `maxRows` caps the result (the bubble shows a preview); the last kept row
 * ends in an ellipsis. Omit it for the full message page.
 */
export function splitRows(text, size, maxRows) {
  const source = String(text == null ? '' : text)
  const metrics = Number(size) > 0 ? Number(size) : FONT_METRICS.normal.size
  // One unit is half a latin glyph: a latin char is 1, a CJK glyph 2.
  const perRow = Math.max(6, Math.floor(ROW_WIDTH / (metrics / 2)))
  const cap = Number(maxRows) > 0 ? Number(maxRows) : 0
  const rows = []
  const paragraphs = source.split('\n')
  // The cap is enforced while splitting: a 5000-character message must not build
  // 300 row strings that are then thrown away. `truncated` is what appends the
  // ellipsis — and it is only true when there really is more text.
  let truncated = false

  for (let p = 0; p < paragraphs.length; p += 1) {
    const chars = Array.from(paragraphs[p])
    let row = ''
    let used = 0
    for (let i = 0; i < chars.length; i += 1) {
      const cost = isWideChar(chars[i].charCodeAt(0)) ? 2 : 1
      if (row && used + cost > perRow) {
        rows.push(row)
        row = ''
        used = 0
        if (cap && rows.length >= cap) {
          truncated = true
          break
        }
      }
      row += chars[i]
      used += cost
    }
    if (truncated) break
    rows.push(row)
    if (cap && rows.length >= cap && p < paragraphs.length - 1) {
      truncated = true
      break
    }
  }

  if (truncated) {
    // One glyph over the row budget is fine: the row clips at its width.
    rows[rows.length - 1] = rows[rows.length - 1] + '…'
  }
  return rows
}

/**
 * How many rows the whole message needs, without building the strings.
 * Used to decide whether the bubble needs a 「展开全文」 line.
 */
export function countRows(text, size) {
  const source = String(text == null ? '' : text)
  const metrics = Number(size) > 0 ? Number(size) : FONT_METRICS.normal.size
  const perRow = Math.max(6, Math.floor(ROW_WIDTH / (metrics / 2)))
  let rows = 0
  source.split('\n').forEach((paragraph) => {
    let used = 0
    rows += 1
    const chars = Array.from(paragraph)
    for (let i = 0; i < chars.length; i += 1) {
      const cost = isWideChar(chars[i].charCodeAt(0)) ? 2 : 1
      if (used + cost > perRow) {
        rows += 1
        used = 0
      }
      used += cost
    }
  })
  return rows
}

/** Clips to `limit` without cutting a surrogate pair in half. */
export function clipDisplay(value, limit) {
  const source = String(value == null ? '' : value)
  if (source.length <= limit) return source
  const last = source.charCodeAt(limit - 1)
  return source.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit) + '…'
}

/** Removes one trailing character, surrogate pairs intact (backspace). */
export function trimLastChar(text) {
  const source = String(text || '')
  if (source.length === 0) return ''
  const last = source.charCodeAt(source.length - 1)
  if (last >= 0xdc00 && last <= 0xdfff && source.length >= 2) {
    return source.slice(0, source.length - 2)
  }
  return source.slice(0, source.length - 1)
}

export default {
  ROW_WIDTH,
  FONT_SCALES,
  FONT_METRICS,
  scaleName,
  fontSizeOf,
  isWideChar,
  splitRows,
  countRows,
  clipDisplay,
  trimLastChar
}
