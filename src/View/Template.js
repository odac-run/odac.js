const nodeCrypto = require('crypto')
const fsPromises = require('fs').promises
const path = require('path')
const Form = require('./Form')
const Image = require('./Image')
const {cacheName, compile} = require('./Compiler')

/**
 * Loads view templates as compiled modules.
 *
 * Why: a view reads the request's `Odac.set()` values by name (`{{ user.name }}`), so each
 * compiled module declares the keys it uses as locals. One pipeline (Form and Image transforms,
 * the compiler, an atomically written module per template, production caching) and one error
 * format serve every template.
 *
 * Every compiled module has the signature `(Odac, get, __, __x, props, {locals} = props)`, where
 * `props` holds the `Odac.set()` values. The template body runs in its own block so a
 * `<script:odac>` declaration may reuse a local's name.
 */

const CACHE_DIR = 'storage/.cache'
// Lines before the template's first line in a compiled module (see #source). Error lines are
// reported relative to the template.
const HEADER_LINES = 3
// Identifier-like tokens of compiled code. A key is only declared when the template mentions it,
// so `Odac.set()` keys derived from input cannot grow the number of compiled variants.
const TOKEN = /[A-Za-z_$][\w$]*/g
const MISSING = Symbol('missing')

// A template threw while rendering, or could not be compiled or loaded. Already logged.
class RenderError extends Error {}

function store() {
  if (!global.Odac) global.Odac = {}
  if (!global.Odac.View) global.Odac.View = {}
  if (!global.Odac.View.cache) global.Odac.View.cache = {}
  return global.Odac.View.cache
}

/**
 * Logs a render failure once, with the template line.
 * @param {*} e The thrown value. A RenderError is returned unchanged (it was already logged).
 * @param {object} where
 * @param {string} where.file Template the failure belongs to.
 * @param {string} [where.module] Compiled module name, used to find the failing line in the stack.
 * @returns {RenderError}
 */
function failure(e, {file, module}) {
  if (e instanceof RenderError) return e
  const frame = module ? String(e?.stack ?? '').match(new RegExp(`${module}:(\\d+)`)) : null
  const at = frame ? Number(frame[1]) - HEADER_LINES : 'unknown'
  console.error(`${String(e).split('\n')[0]}\n  in line ${at}\n  of "${file}"`)
  return new RenderError(String(e))
}

// A template changed or disappeared: its compiled modules are unloaded and removed, so editing
// views in debug mode grows neither the module cache nor storage/.cache.
function discard(known) {
  if (!known || known === MISSING) return
  for (const {target} of known.modules.values()) {
    delete require.cache[target]
    fsPromises.unlink(target).catch(() => {})
  }
}

// Reads and compiles a template when it is new or (in debug) changed on disk. In production a
// template is read once per process; in debug once per request (`seen`).
async function entry(file, odac, {seen}) {
  const cache = store()
  const key = file
  const known = cache[key]
  if (known !== undefined && (!odac.Config?.debug || seen?.has(key))) return known === MISSING ? null : known
  seen?.add(key)

  let handle
  try {
    handle = await fsPromises.open(file, 'r')
  } catch {
    discard(known)
    cache[key] = MISSING
    return null
  }

  try {
    const {mtimeMs} = await handle.stat()
    if (known && known !== MISSING && known.mtime === mtimeMs) return known

    let source = await handle.readFile('utf8')
    source = Form.parse(source, odac)
    source = Image.parse(source)

    const code = compile(source, {file})
    const loaded = {mtime: mtimeMs, code, tokens: new Set(code.match(TOKEN)), modules: new Map()}
    discard(known)
    cache[key] = loaded
    return loaded
  } finally {
    await handle.close()
  }
}

// The compiled module source. The header is exactly HEADER_LINES lines before the template.
function source(loaded, locals) {
  const declarations = locals.length > 0 ? `, {${locals.join(', ')}} = props` : ''
  return (
    `module.exports = async (Odac, get, __, __x, props${declarations}) => {\n` +
    `let html = ''; {\n` +
    `${loaded.code}\n}\nreturn html.trim()\n}\n`
  )
}

// Written beside the target and renamed into place: workers compiling the same template at once
// never require() a half-written file.
async function write(name, content) {
  const dir = path.join(__dir, CACHE_DIR)
  const target = path.join(dir, name)
  const temp = `${target}.${process.pid}.${nodeCrypto.randomBytes(6).toString('hex')}.tmp`
  await fsPromises.mkdir(dir, {recursive: true})
  try {
    await fsPromises.writeFile(temp, content)
    await fsPromises.rename(temp, target)
  } catch (e) {
    await fsPromises.unlink(temp).catch(() => {})
    throw e
  }
  delete require.cache[require.resolve(target)]
  return target
}

/**
 * Loads the compiled module of a template.
 * @param {string} file Template path relative to the project (`./view/...`).
 * @param {object} odac Request context; `Config.debug` turns on change detection.
 * @param {object} [options]
 * @param {string[]} [options.locals] Sorted candidate local names (a view's `Odac.set()` keys).
 * @param {Set<string>} [options.seen] Templates already checked for changes in this request.
 * @returns {Promise<{fn: Function, name: string, target: string}|null>}
 *   null when the template file does not exist.
 */
async function load(file, odac, {locals = [], seen} = {}) {
  const loaded = await entry(file, odac, {seen})
  if (!loaded) return null

  const names = locals.filter(name => loaded.tokens.has(name))
  const variant = names.join(',')
  const known = loaded.modules.get(variant)
  if (known) return known

  // Each version of a template gets its own module, so no loader can return a stale one.
  const name = cacheName('view', file, variant, loaded.mtime)
  let fn, target
  try {
    target = require.resolve(await write(name, source(loaded, names)))
    fn = require(target)
  } catch (e) {
    // The compiled module does not parse (a syntax error in an <odac:js> block or expression).
    throw failure(e, {file, module: name})
  }
  const result = {fn, name, target}
  loaded.modules.set(variant, result)
  return result
}

module.exports = {RenderError, failure, load}
