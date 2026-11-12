const path = require('path')
const mime = require('./MimeTypes.js')

// Anything without a known extension is an opaque download. Rendering it as text/html let a
// user-uploaded file in public/ (or one named to dodge the MIME validator) run as a page.
const FALLBACK_TYPE = 'application/octet-stream'

// A URL that carries a version (`?v=…`) changes whenever the file does, so it may be cached
// forever. Every other URL is revalidated: the build writes /assets/css/app.css and
// /assets/js/app.js under fixed names, and a year-long cache hid every deploy from returning
// visitors.
const VERSIONED_QUERY = /(?:^|&)v=[^&]/
const IMMUTABLE = 'public, max-age=31536000, immutable'
const REVALIDATE = 'public, max-age=0, must-revalidate'

/**
 * Resolves the Content-Type for a file served from disk.
 *
 * Why: one lookup shared by public files and config routes, with a safe default for
 * unknown extensions instead of text/html.
 *
 * @param {string} filePath File name or path; only the extension is used.
 * @returns {string} The MIME type, including a charset for text formats.
 */
function contentType(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return (ext && Object.hasOwn(mime, ext) && mime[ext]) || FALLBACK_TYPE
}

/**
 * Whether a path relative to public/ touches a dotfile or dot-directory.
 *
 * Why: public/.env, public/.git/config and editor leftovers were served like any asset.
 * `.well-known` stays reachable because ACME challenges and security.txt live there.
 *
 * @param {string} relativePath Path relative to the public directory.
 * @returns {boolean}
 */
function isHidden(relativePath) {
  for (const segment of relativePath.split(/[/\\]/)) {
    if (segment.startsWith('.') && segment !== '.well-known') return true
  }
  return false
}

/**
 * Cache-Control value for a static response.
 *
 * Why: only URLs that change with their content can be cached without revalidation.
 *
 * @param {string} requestUrl Full request URL including the query string.
 * @returns {string}
 */
function cacheControl(requestUrl) {
  const queryStart = requestUrl.indexOf('?')
  if (queryStart !== -1 && VERSIONED_QUERY.test(requestUrl.slice(queryStart + 1))) return IMMUTABLE
  return REVALIDATE
}

/**
 * Weak validator derived from size and modification time.
 *
 * Why: lets revalidation cost a 304 instead of the full body, without hashing file content.
 *
 * @param {{size: number, mtimeMs: number}} stat
 * @returns {string}
 */
function etag(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
}

function stripWeak(tag) {
  return tag.startsWith('W/') ? tag.slice(2) : tag
}

/**
 * Whether the client's cached copy is still current (RFC 9110 §13.1).
 *
 * Why: answers revalidation with 304. If-None-Match takes precedence over
 * If-Modified-Since, and ETags are compared weakly as required for GET/HEAD.
 *
 * @param {(name: string) => string|undefined} header Request header reader.
 * @param {string} tag Current ETag.
 * @param {number} mtimeMs Current modification time.
 * @returns {boolean}
 */
function isFresh(header, tag, mtimeMs) {
  const noneMatch = header('if-none-match')
  if (noneMatch) {
    const current = stripWeak(tag)
    return noneMatch.split(',').some(candidate => {
      const value = candidate.trim()
      return value === '*' || stripWeak(value) === current
    })
  }
  const modifiedSince = header('if-modified-since')
  if (!modifiedSince) return false
  const since = Date.parse(modifiedSince)
  // HTTP dates have one-second resolution; compare at that resolution.
  return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since
}

/**
 * Parses a Range header against a file size.
 *
 * Why: Safari refuses to seek (and often to play) media served without byte ranges.
 * Only a single range is honoured; multiple ranges are answered with the full body,
 * which RFC 9110 §14.2 permits.
 *
 * @param {string|undefined} rangeHeader Raw Range header.
 * @param {number} size File size in bytes.
 * @returns {null|{start: number, end: number}|false} null: serve the full body;
 *   false: unsatisfiable (416); otherwise the inclusive byte range.
 */
function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) return null
  const [, first, last] = match
  if (first === '' && last === '') return null
  let start
  let end
  if (first === '') {
    // Suffix range: the last N bytes.
    const length = Number(last)
    if (length === 0) return false
    start = Math.max(size - length, 0)
    end = size - 1
  } else {
    start = Number(first)
    end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  }
  if (start >= size || start > end) return false
  return {start, end}
}

module.exports = {cacheControl, contentType, etag, isFresh, isHidden, parseRange}
