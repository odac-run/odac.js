const nodeCrypto = require('crypto')
const fsPromises = require('fs').promises
const path = require('path')
const Form = require('./Form')
const Image = require('./Image')
const {cacheName, compileTemplate, TemplateError} = require('./Compiler')
const {isLocalName} = require('./Identifiers')

/**
 * Loads view and component templates as compiled modules.
 *
 * Why: views and components share one pipeline (Form and Image transforms, the compiler, an
 * atomically written module per template, production caching) and one error format, so a
 * failure inside a component nested five levels deep is reported exactly like one in a page.
 *
 * Every compiled module has the same signature:
 *   (Odac, get, __, __x, __r, props, attrs, slots, {locals} = props)
 * A view receives the request's `Odac.set()` values as `props` and declares the keys it uses as
 * locals; a component receives its attributes and declares its `<odac:props>` in the function
 * body, so a default may `await`. The template body runs in its own block so a `<script:odac>`
 * declaration may reuse a local's name.
 *
 * A view compiles one module per set of keys it is rendered with. Past MAX_VARIANTS sets, one
 * more module reads its locals from a scope object (`with`), which serves every further set.
 */

const CACHE_DIR = 'storage/.cache'
// Lines before the template's first line in a compiled module (see #source). Error lines are
// reported relative to the template.
const HEADER_LINES = 3
// Modules a view compiles for distinct `Odac.set()` key sets before the scoped module takes
// over. Why: a view rendered with keys taken from input (`Odac.set(Odac.Request.data.post)`)
// would otherwise compile a module per combination of its words, without limit.
const MAX_VARIANTS = 32
// The variant key of the scoped module. No list of identifiers equals it.
const SCOPED = '\u0000'
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
 * Logs a render failure once, with the template line and the chain of templates that used it.
 * @param {*} e The thrown value. A RenderError is returned unchanged (it was already logged).
 * @param {object} where
 * @param {string} where.file Template the failure belongs to.
 * @param {string} [where.module] Compiled module name, used to find the failing line in the stack.
 * @param {number} [where.line] Template line, when known without a stack.
 * @param {number} [where.headerLine] Template line reported for a failure in the module header:
 *   a component's `<odac:props>`, whose defaults run before the template's first line.
 * @param {string[]} [where.chain] Templates that rendered `file`, nearest first.
 * @returns {RenderError}
 */
function failure(e, {file, module, line, headerLine, chain = []}) {
  if (e instanceof RenderError) return e
  let at = line ?? 'unknown'
  const frame = line === undefined && module ? String(e?.stack ?? '').match(new RegExp(`${module}:(\\d+)`)) : null
  if (frame) {
    const templateLine = Number(frame[1]) - HEADER_LINES
    at = templateLine >= 1 ? templateLine : (headerLine ?? 'unknown')
  }
  // A component that renders itself repeats in the chain; consecutive repeats print once.
  let usedIn = ''
  for (let i = 0; i < chain.length; ) {
    let next = i + 1
    while (next < chain.length && chain[next] === chain[i]) next++
    usedIn += `\n  used in "${chain[i]}"${next - i > 1 ? ` (${next - i} times)` : ''}`
    i = next
  }
  console.error(`${String(e).split('\n')[0]}\n  in line ${at}\n  of "${file}"${usedIn}`)
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
async function entry(file, odac, {component, seen, chain}) {
  const cache = store()
  const key = component ? `${file}#component` : file
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

    let compiled
    try {
      compiled = compileTemplate(source, {file, components: true, component})
    } catch (e) {
      if (e instanceof TemplateError) throw failure(e, {file, line: e.line, chain})
      throw e
    }

    const loaded = {
      mtime: mtimeMs,
      component,
      code: compiled.code,
      props: compiled.props,
      propsLine: compiled.propsLine,
      tokens: component ? null : new Set(compiled.code.match(TOKEN)),
      modules: new Map()
    }
    discard(known)
    cache[key] = loaded
    return loaded
  } finally {
    await handle.close()
  }
}

// The compiled module source. The header is exactly HEADER_LINES lines before the template.
// `locals` is the list of names a view declares, or null for the scoped module.
function source(loaded, locals) {
  const pattern = loaded.props.map(prop => (prop.value === undefined ? prop.name : `${prop.name} = (${prop.value})`))
  const parameters = locals === null ? ', __scope' : locals.length > 0 ? `, {${locals.join(', ')}} = props` : ''
  const declarations = pattern.length > 0 ? `let {${pattern.join(', ')}} = props; ` : ''
  const props = JSON.stringify(loaded.props.map(prop => prop.name))
  const required = JSON.stringify(loaded.props.filter(prop => prop.value === undefined).map(prop => prop.name))
  return (
    `module.exports = async (Odac, get, __, __x, __r, props, attrs, slots${parameters}) => {\n` +
    `${declarations}let html = ''; ${locals === null ? 'with (__scope) ' : ''}{\n` +
    `${loaded.code}\n}\nreturn html.trim()\n}\n` +
    `module.exports.props = ${props}\nmodule.exports.required = ${required}\n`
  )
}

// The locals of the scoped module: the keys an exact variant would have declared.
function scopeOf(props, tokens) {
  const scope = Object.create(null)
  for (const key of Object.keys(props)) if (tokens.has(key) && isLocalName(key)) scope[key] = props[key]
  return scope
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
 * @param {boolean} [options.component] Compile as a component (`<odac:props>` allowed).
 * @param {string[]} [options.locals] Sorted candidate local names (a view's `Odac.set()` keys).
 * @param {Set<string>} [options.seen] Templates already checked for changes in this request.
 * @param {string[]} [options.chain] Templates that use this one, nearest first (for errors).
 * @returns {Promise<{fn: Function, name: string, target: string, declared: Set<string>, required: string[], headerLine: (number|undefined)}|null>}
 *   null when the template file does not exist.
 */
async function load(file, odac, {component = false, locals = [], seen, chain = []} = {}) {
  const loaded = await entry(file, odac, {component, seen, chain})
  if (!loaded) return null

  let names = component ? [] : locals.filter(name => loaded.tokens.has(name))
  let variant = names.join(',')
  let known = loaded.modules.get(variant)
  if (known) return known
  if (loaded.modules.size >= MAX_VARIANTS) {
    names = null
    variant = SCOPED
    known = loaded.modules.get(variant)
    if (known) return known
  }

  // Each version of a template gets its own module, so no loader can return a stale one.
  const name = cacheName(component ? 'component' : 'view', file, variant, loaded.mtime)
  let compiled, target
  try {
    target = require.resolve(await write(name, source(loaded, names)))
    compiled = require(target)
  } catch (e) {
    // The compiled module does not parse (a syntax error in an <odac:js> block or expression).
    throw failure(e, {file, module: name, headerLine: loaded.propsLine, chain})
  }
  const fn =
    names === null
      ? (odac, get, __, __x, runtime, props, attrs, slots) =>
          compiled(odac, get, __, __x, runtime, props, attrs, slots, scopeOf(props, loaded.tokens))
      : compiled
  const result = {fn, name, target, declared: new Set(compiled.props), required: compiled.required, headerLine: loaded.propsLine}
  loaded.modules.set(variant, result)
  return result
}

module.exports = {RenderError, failure, load}
