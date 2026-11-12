'use strict'

const fsPromises = require('node:fs').promises
const path = require('node:path')
const Catalog = require('./Catalog.js')

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'])
const TEMPLATE_EXTENSION = '.html'
// Runtime data, dependencies and static files never contain translation calls.
const SKIPPED_DIRS = new Set(['node_modules', 'storage', 'public', 'coverage'])
// Larger files are generated or vendored code, not application source.
const MAX_FILE_SIZE = 2 * 1024 * 1024
const FRONTEND_DIR = 'view/js'
const CONCURRENCY = 32

/**
 * Keys the framework itself translates.
 * Why: they are used from node_modules, which is never scanned, but belong in the
 * application's language files and must not be reported as unused.
 */
const FRAMEWORK_KEYS = Object.freeze(['Too many failed attempts. Please try again later.'])

// `__(`, `__x(`, `Lang.get(` and `Lang.getx(`, including `Odac.__(` and `this.Lang.get(`.
const CALL = /(?<![\w$])(?:(__x?)|Lang\.(getx?))\s*\(/g
const ESCAPES = {n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v'}

function skipSpace(source, i) {
  while (i < source.length && /\s/.test(source[i])) i++
  return i
}

/**
 * Reads a JavaScript string literal starting at `start`.
 * @returns {{value: string, end: number}|null} null when there is no plain literal there (a
 *   variable, a template literal with `${}`, a malformed string).
 */
function readLiteral(source, start) {
  const quote = source[start]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  let value = ''
  let i = start + 1
  while (i < source.length) {
    const char = source[i]
    if (char === quote) return {value, end: i + 1}
    if (char === '\\') {
      const next = source[i + 1]
      if (next === undefined) return null
      if (next === '\r' || next === '\n' || next === ' ' || next === ' ') {
        // Line continuation.
        i += next === '\r' && source[i + 2] === '\n' ? 3 : 2
        continue
      }
      if (next === 'x') {
        const hex = source.slice(i + 2, i + 4)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null
        value += String.fromCharCode(parseInt(hex, 16))
        i += 4
        continue
      }
      if (next === 'u') {
        const braced = source[i + 2] === '{' ? /^\{([0-9a-fA-F]{1,6})\}/.exec(source.slice(i + 2, i + 11)) : null
        const hex = braced ? braced[1] : source.slice(i + 2, i + 6)
        if (!braced && !/^[0-9a-fA-F]{4}$/.test(hex)) return null
        const codePoint = parseInt(hex, 16)
        if (codePoint > 0x10ffff) return null
        value += String.fromCodePoint(codePoint)
        i += braced ? 4 + hex.length : 6
        continue
      }
      if (next === '0' && !/[0-9]/.test(source[i + 2] ?? '')) value += '\0'
      else if (/[0-9]/.test(next)) return null
      else value += ESCAPES[next] ?? next
      i += 2
      continue
    }
    if (quote === '`') {
      if (char === '$' && source[i + 1] === '{') return null
      if (char === '\r') {
        // Template literals normalize line endings to \n.
        value += '\n'
        i += source[i + 1] === '\n' ? 2 : 1
        continue
      }
    } else if (char === '\n' || char === '\r') {
      return null
    }
    value += char
    i++
  }
  return null
}

/**
 * Finds the translation calls in JavaScript source (or compiled view code).
 * Why: the key set of an application is whatever its code asks for; reading it from the
 * source instead of from runtime traffic covers pages nobody has visited yet and makes
 * unused keys detectable. Calls whose key or context is not a string literal cannot be
 * resolved statically and are reported as dynamic, so they can be listed in `lang.keep`.
 * @param {string} source
 * @returns {{entries: Array<{key: string, context: string, line: number}>, dynamic: Array<{line: number, call: string}>}}
 */
function scanSource(source) {
  const entries = []
  const dynamic = []
  let line = 1
  let lastIndex = 0
  CALL.lastIndex = 0
  let match
  while ((match = CALL.exec(source))) {
    for (let i = lastIndex; i < match.index; i++) if (source.charCodeAt(i) === 10) line++
    lastIndex = match.index

    const name = match[1] ?? `Lang.${match[2]}`
    const contextual = name.endsWith('x')
    const key = readLiteral(source, skipSpace(source, CALL.lastIndex))
    let context = {value: ''}
    if (key && contextual) {
      const comma = skipSpace(source, key.end)
      context = source[comma] === ',' ? readLiteral(source, skipSpace(source, comma + 1)) : null
    }
    if (!key || !context) {
      dynamic.push({line, call: source.slice(match.index, match.index + 60).split('\n')[0]})
      continue
    }
    entries.push({key: key.value, context: Catalog.normalizeContext(context.value), line})
  }
  return {entries, dynamic}
}

async function walk(root, dir, files) {
  let dirents
  try {
    dirents = await fsPromises.readdir(dir, {withFileTypes: true})
  } catch {
    return
  }
  const nested = []
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name)
    // Symlinks are not followed: they can loop or leave the project.
    if (dirent.isDirectory()) {
      if (dirent.name.startsWith('.') || (dir === root && SKIPPED_DIRS.has(dirent.name)) || dirent.name === 'node_modules') continue
      nested.push(walk(root, full, files))
    } else if (dirent.isFile()) {
      const ext = path.extname(dirent.name).toLowerCase()
      if (ext !== TEMPLATE_EXTENSION && !SOURCE_EXTENSIONS.has(ext)) continue
      if (dirent.name.includes('.min.')) continue
      files.push(full)
    }
  }
  await Promise.all(nested)
}

/**
 * Collects every translation entry an application uses.
 * Views (`.html`) are compiled with the view compiler and the compiled code is scanned, so
 * the keys are derived exactly as at runtime (placeholders become `%s1`, contexts apply).
 * Files under `view/js/` are marked as frontend entries: they are the only ones sent to the
 * browser.
 * @param {string} root Project directory.
 * @param {object} [options]
 * @param {string} [options.dir] Limit the scan to this directory (relative to root).
 * @returns {Promise<{
 *   entries: Map<string, {key: string, context: string, files: Set<string>, frontend: boolean}>,
 *   dynamic: Array<{file: string, line: number|null, call: string}>,
 *   errors: Array<{file: string, message: string}>
 * }>}
 */
async function extract(root, {dir} = {}) {
  const {compile} = require('../View/Compiler.js')
  const files = []
  await walk(root, dir ? path.join(root, dir) : root, files)
  files.sort()

  const entries = new Map()
  const dynamic = []
  const errors = []
  const frontendPrefix = path.join(root, FRONTEND_DIR) + path.sep

  const scan = async file => {
    try {
      const stat = await fsPromises.stat(file)
      if (stat.size > MAX_FILE_SIZE) return null
      const content = await fsPromises.readFile(file, 'utf8')
      const isTemplate = path.extname(file).toLowerCase() === TEMPLATE_EXTENSION
      return {file, isTemplate, ...scanSource(isTemplate ? compile(content, {file}) : content)}
    } catch (e) {
      errors.push({file: path.relative(root, file), message: e.message})
      return null
    }
  }
  // Bounded concurrency: a large project must not exhaust file descriptors.
  const results = []
  for (let i = 0; i < files.length; i += CONCURRENCY) results.push(...(await Promise.all(files.slice(i, i + CONCURRENCY).map(scan))))

  for (const result of results) {
    if (!result) continue
    const relative = path.relative(root, result.file)
    const frontend = result.file.startsWith(frontendPrefix)
    // Line numbers of compiled views do not point into the template.
    for (const {key, context, line} of result.entries) {
      const id = Catalog.entryId(key, context)
      let entry = entries.get(id)
      if (!entry) entries.set(id, (entry = {key, context, files: new Set(), frontend: false}))
      entry.files.add(result.isTemplate ? relative : `${relative}:${line}`)
      if (frontend) entry.frontend = true
    }
    for (const {line, call} of result.dynamic) dynamic.push({file: relative, line: result.isTemplate ? null : line, call})
  }
  errors.sort((a, b) => (a.file < b.file ? -1 : 1))
  return {entries, dynamic, errors}
}

/**
 * Builds the matcher for `lang.keep`: exact keys, or prefixes ending in `*`.
 * Why: keys built at runtime (`Odac.__(`status.${code}`)`) cannot be found in the source;
 * listing them here keeps `lang:check` and `lang:prune` from treating them as unused.
 * @param {object} [config]
 * @returns {(key: string) => boolean}
 */
function keepMatcher(config) {
  const patterns = Array.isArray(config?.lang?.keep) ? config.lang.keep.filter(p => typeof p === 'string' && p !== '') : []
  const exact = new Set(patterns.filter(p => !p.endsWith('*')))
  const prefixes = patterns.filter(p => p.endsWith('*')).map(p => p.slice(0, -1))
  return key => exact.has(key) || prefixes.some(prefix => key.startsWith(prefix))
}

module.exports = {FRAMEWORK_KEYS, FRONTEND_DIR, extract, keepMatcher, readLiteral, scanSource}
