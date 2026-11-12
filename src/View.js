const nodeCrypto = require('crypto')
const fs = require('fs')
const fsPromises = fs.promises
const Form = require('./View/Form')
const EarlyHints = require('./View/EarlyHints')
const Image = require('./View/Image')
const {compile} = require('./View/Compiler')

const TITLE_REGEX = /<title[^>]*>([^<]*)<\/title>/i
// A skeleton placeholder: `{{ CONTENT }}`. The capture group keeps names in split() output.
const SKELETON_PLACEHOLDER = /\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/

const CACHE_DIR = './storage/.cache'

// One attribute of a start tag, with its value if it has one. Matching whole attributes in
// order keeps text inside a quoted value (`data-x="a lang=b"`) from being read as an attribute.
const HTML_ATTRIBUTE = /(\s*)([^\s"'>/=]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g
// The attributes a declared language owns. `xml:lang` and `data-lang` are other attributes.
const LANG_ATTRIBUTE_NAME = /^(?:lang|dir)$/i

// Removes `lang` and `dir` from the attribute text of a start tag.
const withoutLangAttributes = attrs => attrs.replace(HTML_ATTRIBUTE, (token, space, name) => (LANG_ATTRIBUTE_NAME.test(name) ? '' : token))

// Characters that can terminate or confuse an inline <script> block once JSON is embedded in HTML.
// `<`/`>` close the element (`</script>`, `<!--`), `&` matters for XHTML parsers and U+2028/U+2029
// are line terminators in pre-ES2019 engines. The escaped form parses to the identical value.
const SCRIPT_UNSAFE_CHARS = /[<>&\u2028\u2029]/g
const SCRIPT_ESCAPES = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029'
}

/**
 * Serializes a value as JSON that is safe to embed inside an HTML `<script>` element.
 * Why: `Odac.share()` data routinely contains user input; plain `JSON.stringify` leaves
 * `</script>` intact, letting that input break out of the data block and execute script.
 * @param {*} value
 * @returns {string}
 */
function serializeForScript(value) {
  return JSON.stringify(value).replace(SCRIPT_UNSAFE_CHARS, char => SCRIPT_ESCAPES[char])
}

// The browser translations are the same object until a language file or view/js changes,
// so their serialized form is computed once per version.
const translationScripts = new WeakMap()
function translationScript(translations) {
  let script = translationScripts.get(translations)
  if (script === undefined) translationScripts.set(translations, (script = serializeForScript(translations)))
  return script
}

// A view threw while rendering (or its compiled code did not load). Already logged.
class RenderError extends Error {}

// A requested part name is only a part when the controller set it; `__proto__`, `constructor`
// and other inherited names from a request header are not.
const partName = (parts, name) => typeof name === 'string' && Object.hasOwn(parts, name) && typeof parts[name] === 'string'

class View {
  #earlyHints = null
  #part = {}
  #refresh = new Set()
  #odac = null
  #failed = false

  constructor(odac) {
    this.#odac = odac

    if (!global.Odac?.View?.EarlyHints) {
      const config = odac.Config?.earlyHints
      this.#earlyHints = new EarlyHints(config)
      this.#earlyHints.init()

      if (!global.Odac) global.Odac = {}
      if (!global.Odac.View) global.Odac.View = {}
      global.Odac.View.EarlyHints = this.#earlyHints
    } else {
      this.#earlyHints = global.Odac.View.EarlyHints
    }
    global.Odac.View.Form = Form
    global.Odac.View.Image = Image
    this.Form = Form
    this.Image = Image
  }

  all(name) {
    this.#part.all = name
    return this
  }

  // - PRINT VIEW
  /**
   * Renders the page (or the requested parts of an AJAX navigation) and ends the response.
   * Why: a view that throws must not produce a 200 with an empty region, which a proxy cache
   * (`Odac.cache()`) would then serve to everyone. It answers 500 through abort(), so a custom
   * 500 handler can render its own page.
   */
  async print() {
    if (this.#odac.Request.res.finished) return
    try {
      await this.#print()
    } catch (e) {
      if (!(e instanceof RenderError)) throw e
      await this.#renderFailed()
    }
  }

  async #renderFailed() {
    const Request = this.#odac.Request
    Request.header('X-ODAC-Cache', null)
    Request.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    // The error page itself failed to render: answer with the bare status.
    if (this.#failed) return Request.end('')
    this.#failed = true
    await Request.abort(500)
    // A custom 500 handler that configured a view returns nothing and leaves printing to us.
    if (!Request.res.finished) await this.print()
  }

  async #print() {
    const served = await this.#served()

    // Handle AJAX load requests
    if (this.#odac.Request.isAjaxLoad === true && this.#odac.Request.ajaxLoad && this.#odac.Request.ajaxLoad.length > 0) {
      let output = {}
      let variables = {}

      // Collect variables marked for AJAX
      for (let key in this.#odac.Request.variables) {
        if (this.#odac.Request.variables[key].ajax) {
          variables[key] = this.#odac.Request.variables[key].value
        }
      }

      // Build current parts manifest (part name → view path)
      const currentParts = {}
      for (let key in this.#part) {
        if (['all', 'skeleton'].includes(key)) continue
        if (this.#part[key]) currentParts[key] = this.#part[key]
      }

      // Parse client's previous parts to detect unchanged regions
      const clientParts = this.#odac.Request.clientParts || {}

      // Render requested elements (skip unchanged parts)
      let title = null
      for (let element of this.#odac.Request.ajaxLoad) {
        if (partName(this.#part, element)) {
          // Skip rendering if the part view path has not changed and refresh is not forced
          // Content is always re-rendered since its output depends on the current URL
          if (
            element !== 'content' &&
            !this.#refresh.has(element) &&
            Object.hasOwn(clientParts, element) &&
            clientParts[element] === this.#part[element]
          )
            continue

          let viewPath = this.#part[element]
          if (viewPath.includes('.')) viewPath = viewPath.replace(/\./g, '/')
          if (await this.#exists(`./view/${element}/${viewPath}.html`)) {
            const html = await this.#render(`./view/${element}/${viewPath}.html`)
            output[element] = html

            // Extract title if present inside the part
            const titleMatch = html.match(TITLE_REGEX)
            if (titleMatch && titleMatch[1]) {
              title = titleMatch[1].trim()
            }
          }
        }
      }

      // If title not found in parts, try to extract from 'head', 'header' or 'meta' parts
      if (!title) {
        const priorityParts = ['head', 'header', 'meta']
        for (const key of priorityParts) {
          // Only extract if it wasn't already processed in the main loop above
          if (this.#part[key] && output[key] === undefined) {
            let viewPath = this.#part[key]
            if (viewPath.includes('.')) viewPath = viewPath.replace(/\./g, '/')
            if (await this.#exists(`./view/${key}/${viewPath}.html`)) {
              try {
                const partHtml = await this.#render(`./view/${key}/${viewPath}.html`)
                const titleMatch = partHtml.match(TITLE_REGEX)
                if (titleMatch && titleMatch[1]) {
                  title = titleMatch[1].trim()
                  break
                }
              } catch (e) {
                if (this.#odac.Config?.debug) {
                  console.warn(`Odac: Failed to render part '${key}' while searching for title:`, e)
                }
              }
            }
          }
        }
      }

      const currentSkeleton = this.#part.skeleton || 'main'
      const clientSkeleton = this.#odac.Request.clientSkeleton
      const skeletonChanged = clientSkeleton && clientSkeleton !== currentSkeleton

      this.#odac.Request.header('Content-Type', 'application/json')
      this.#odac.Request.header('X-Odac-Page', this.#odac.Request.page || '')
      this.#languageHeaders(served, ['X-Odac', 'X-Odac-Lang'])

      const response = {
        output: output,
        parts: currentParts,
        variables: variables,
        data: this.#odac.Request.sharedData,
        title: title,
        skeletonChanged: skeletonChanged
      }
      if (served) response.document = {lang: served.lang, dir: served.dir}
      // The browser reports the translations it holds as `lang:v`; they are sent again when
      // the language or their content changed (a language file edited on the server).
      const translations = await this.#translations()
      if (translations && this.#odac.Request.header('X-Odac-Lang') !== `${translations.lang}:${translations.v}`)
        response.lang = translations
      this.#odac.Request.end(response)
      return
    }

    // Normal page rendering
    let result = ''
    if (this.#part.skeleton && (await this.#exists(`./skeleton/${this.#part.skeleton}.html`))) {
      // Placeholders already carry data-odac-navigate (applied once per skeleton read).
      result = await this.#readSkeleton(`./skeleton/${this.#part.skeleton}.html`)
      result = this.#annotateHtmlTag(result, served)
      result = await this.#fillSkeleton(result)
    }

    if (result) {
      const hasEarlyHints = this.#odac.Request.hasEarlyHints()
      const hintKey = this.#hintCacheKey()

      // In production a page without preloadable resources is scanned once, not per request.
      if (!hasEarlyHints && (this.#odac.Config?.debug || !this.#earlyHints.isCached(hintKey))) {
        const detectedResources = this.#earlyHints.extractFromHtml(result)
        this.#earlyHints.cacheHints(hintKey, detectedResources ?? [])
      }

      // Inject Shared Data (and the translations used by view/js, if any)
      let sharedScript = `<script type="application/json" id="odac-data">${serializeForScript(this.#odac.Request.sharedData || {})}</script>`
      const translations = await this.#translations()
      if (translations) sharedScript += `<script type="application/json" id="odac-lang">${translationScript(translations)}</script>`
      if (result.includes('</body>')) {
        // Function replacer: the payload may contain `$&`/`$'` sequences that a string replacement would expand.
        result = result.replace('</body>', () => `${sharedScript}</body>`)
      } else {
        result += sharedScript
      }
    }

    this.#languageHeaders(served, [])
    this.#odac.Request.header('Content-Type', 'text/html; charset=utf-8')
    this.#odac.Request.end(result)
  }

  /**
   * Fills a skeleton's `{{ PART }}` placeholders with rendered parts.
   *
   * Why: replacing placeholders one by one with String.replace() expanded `$&`, `` $` `` and
   * `$'` inside rendered HTML (even an escaped `'` becomes `&#39;` after a `$`), re-scanned
   * already inserted content (a part containing the text `{{ FOOTER }}` was filled before the
   * real placeholder) and the final cleanup erased placeholder-like text from user content.
   * The skeleton is tokenized once and only its own placeholders are ever filled.
   *
   * Explicit parts render first in the order they were set, then `all` fills the remaining
   * placeholders in skeleton order, keeping the render order views may depend on. Only the
   * first occurrence of a placeholder is filled; unresolved placeholders render empty.
   *
   * @param {string} skeleton Skeleton HTML.
   * @returns {Promise<string>}
   */
  async #fillSkeleton(skeleton) {
    const segments = skeleton.split(SKELETON_PLACEHOLDER)
    const firstIndex = new Map()
    for (let i = 1; i < segments.length; i += 2) if (!firstIndex.has(segments[i])) firstIndex.set(segments[i], i)

    const rendered = new Map()
    for (const key in this.#part) {
      if (key === 'all' || key === 'skeleton' || !this.#part[key]) continue
      if (this.#part[key].includes('.')) this.#part[key] = this.#part[key].replace(/\./g, '/')
      const name = key.toUpperCase()
      if (!firstIndex.has(name) || rendered.has(name)) continue
      const file = `./view/${key}/${this.#part[key]}.html`
      if (await this.#exists(file)) rendered.set(name, await this.#render(file))
    }

    if (this.#part.all) {
      for (const name of firstIndex.keys()) {
        if (rendered.has(name)) continue
        const file = this.#part.all.split('.')
        file.splice(-1, 0, name.toLowerCase())
        const filePath = `./view/${file.join('/')}.html`
        if (await this.#exists(filePath)) rendered.set(name, await this.#render(filePath))
      }
    }

    let html = ''
    for (let i = 0; i < segments.length; i++) {
      if (i % 2 === 0) html += segments[i]
      else if (firstIndex.get(segments[i]) === i) html += rendered.get(segments[i]) ?? ''
    }
    return html
  }

  // The language the response is served in (see Lang#served); never fails a page render.
  async #served() {
    try {
      return (await this.#odac.Lang?.served?.()) ?? null
    } catch {
      return null
    }
  }

  // Content-Language names the served language. Vary: Accept-Language keeps a shared cache
  // from serving a page in one visitor's language to a visitor who asked for another.
  #languageHeaders(served, vary) {
    const Request = this.#odac.Request
    if (served) Request.header('Content-Language', served.lang)
    const fields = served?.varies ? [...vary, 'Accept-Language'] : vary
    if (fields.length > 0) Request.header('Vary', fields.join(', '))
  }

  // Translations for Odac.__() in the browser; never fails a page render.
  async #translations() {
    try {
      return (await this.#odac.Lang?.client?.()) ?? null
    } catch {
      return null
    }
  }

  // Runs a compiled view. A throw inside the template is logged with its view line and
  // becomes a RenderError.
  async #run(compiled, file) {
    try {
      return await compiled(
        this.#odac,
        key => this.#odac.Request.get(key),
        (...args) => this.#odac.Lang.get(...args),
        (key, context, ...args) => this.#odac.Lang.getx(key, context, ...args)
      )
    } catch (e) {
      throw this.#renderError(e, file)
    }
  }

  #renderError(e, file) {
    const stackLine = e?.stack?.split('\n')[1]?.match(/:(\d+):\d+/)
    const line = stackLine ? parseInt(stackLine[1]) - 3 : e?.lineNumber ? e.lineNumber - 3 : 'unknown'
    console.error(String(e).split('\n')[0] + `\n  in line ${line}\n  of "${file}"`)
    return new RenderError(String(e))
  }

  async #render(file) {
    if (!global.Odac.View) global.Odac.View = {}
    if (!global.Odac.View.cache) global.Odac.View.cache = {}

    // Performance: In Production, skip stat check if cached. Only a missing compiled file
    // falls back to compiling; an error inside the view is not retried by running it twice.
    if (!this.#odac.Config?.debug && global.Odac.View.cache[file]) {
      let compiled = null
      try {
        compiled = require(`${__dir}/${CACHE_DIR}/${global.Odac.View.cache[file].cache}`)
      } catch {
        compiled = null
      }
      if (compiled) return this.#run(compiled, file)
      delete global.Odac.View.cache[file]
    }

    let mtime
    let content = null

    try {
      const handle = await fsPromises.open(file, 'r')
      try {
        const stats = await handle.stat()
        mtime = stats.mtimeMs

        if (global.Odac.View.cache[file]?.mtime !== mtime) {
          content = await handle.readFile('utf8')
        }
      } finally {
        await handle.close()
      }
    } catch {
      return ''
    }

    if (content !== null) {
      content = Form.parse(content, this.#odac)
      content = Image.parse(content)

      const result = compile(content, {file})

      let cache = `${nodeCrypto.createHash('md5').update(file).digest('hex')}`
      const target = `${__dir}/${CACHE_DIR}/${cache}`
      // Written beside the target and renamed into place: workers compiling the same view at
      // once never require() a half-written file.
      const temp = `${target}.${process.pid}.${nodeCrypto.randomBytes(6).toString('hex')}.tmp`
      await fsPromises.mkdir(`${__dir}/${CACHE_DIR}`, {recursive: true})
      try {
        await fsPromises.writeFile(
          temp,
          `module.exports = async (Odac, get, __, __x) => {\nlet html = '';\n${result}\nreturn html.trim()\n}`
        )
        await fsPromises.rename(temp, target)
      } catch (e) {
        await fsPromises.unlink(temp).catch(() => {})
        throw e
      }
      delete require.cache[require.resolve(target)]
      if (!Odac.View) Odac.View = {}
      if (!Odac.View.cache) Odac.View.cache = {}
      Odac.View.cache[file] = {
        mtime: mtime,
        cache: cache
      }
    }
    let compiled
    try {
      compiled = require(`${__dir}/${CACHE_DIR}/${Odac.View.cache[file].cache}`)
    } catch (e) {
      // The compiled view does not parse (a syntax error in an <odac:js> block).
      throw this.#renderError(e, file)
    }
    return this.#run(compiled, file)
  }

  // - SET PARTS
  set(...args) {
    if (args.length === 1 && typeof args[0] === 'object') {
      for (let key in args[0]) this.#part[key] = args[0][key]
    } else if (args.length >= 2) {
      this.#part[args[0]] = args[1]
      if (args[2]?.refresh) this.#refresh.add(args[0])
    }

    if (!this.#odac.Request.page) {
      this.#odac.Request.page = this.#part.content || this.#part.all || ''
    }

    this.#sendEarlyHintsIfAvailable()
    return this
  }

  skeleton(name) {
    this.#part.skeleton = name
    this.#sendEarlyHintsIfAvailable()
    return this
  }

  // Marks every placeholder's region with data-odac-navigate. Depends on the skeleton only,
  // so the result is cached with it.
  #wrapPlaceholders(skeleton) {
    // Single-pass regex to inject data-odac-navigate into parent tags or auto-wrap unwrapped placeholders.
    // Group 1: Opening tag (<tag>)
    // Group 2: Whitespace between tag and placeholder
    // Group 3: Placeholder ({{ PART_NAME }})
    // Group 4: Part name inside wrapped placeholder
    // Group 5: Standalone/Unwrapped placeholder
    // Group 6: Part name inside unwrapped placeholder
    skeleton = skeleton.replace(
      /(<(?!\/)[^>]+>)(\s*)(\{\{\s*([A-Z_]+)\s*\}\})|(\{\{\s*([A-Z_]+)\s*\}\})/g,
      (match, openTag, spaces, wrappedPlaceholder, wrappedPartName, unwrappedPlaceholder, unwrappedPartName) => {
        if (openTag) {
          // Case 1: Placeholder immediately follows an opening tag. Inject attribute into the tag.
          const attrName = wrappedPartName.toLowerCase()
          const tagWithAttr = openTag.includes('data-odac-navigate') ? openTag : openTag.slice(0, -1) + ` data-odac-navigate="${attrName}">`
          return `${tagWithAttr}${spaces}${wrappedPlaceholder}`
        }

        if (unwrappedPlaceholder) {
          // Case 2: Placeholder is unwrapped (e.g. sibling to a closing tag). Wrap in display:contents.
          const attrName = unwrappedPartName.toLowerCase()
          return `<div style="display:contents" data-odac-navigate="${attrName}">${unwrappedPlaceholder}</div>`
        }

        return match
      }
    )
    return skeleton
  }

  // Per-request attributes on <html>: the served language and direction, and the skeleton,
  // page and parts the client diffs against. A declared language replaces the skeleton's own
  // lang/dir, which is a fixed value (`lang="en"` in new projects) that would mislabel every
  // other language.
  #annotateHtmlTag(skeleton, served) {
    const skeletonName = this.#part.skeleton || 'main'
    const pageName = this.#odac.Request.page || ''

    skeleton = skeleton.replace(/<html([^>]*)>/, (match, original) => {
      const attrs = served ? withoutLangAttributes(original) : original
      const updates = served ? [`lang="${served.lang}"`, `dir="${served.dir}"`] : []
      if (!attrs.includes('data-odac-skeleton')) {
        updates.push(`data-odac-skeleton="${skeletonName}"`)
      }
      if (!attrs.includes('data-odac-page')) {
        updates.push(`data-odac-page="${pageName}"`)
      }

      // Embed current parts manifest for client-side diffing on first load
      const partsMap = {}
      for (let key in this.#part) {
        if (['all', 'skeleton'].includes(key)) continue
        if (this.#part[key]) partsMap[key] = this.#part[key]
      }
      if (!attrs.includes('data-odac-parts') && Object.keys(partsMap).length > 0) {
        updates.push(`data-odac-parts='${JSON.stringify(partsMap)}'`)
      }

      if (updates.length === 0) return match
      return `<html${attrs} ${updates.join(' ')}>`
    })

    return skeleton
  }

  // The <head> resources of a page are determined by the views it is assembled from, so that
  // combination identifies a hint set. Dots and slashes are equivalent in view names.
  #hintCacheKey() {
    const entries = []
    for (const key of Object.keys(this.#part).sort()) {
      const value = this.#part[key]
      if (typeof value === 'string' && value) entries.push(`${key}=${value.replace(/\./g, '/')}`)
    }
    return entries.join('|')
  }

  #sendEarlyHintsIfAvailable() {
    if (this.#odac.Request.res.headersSent) return

    const viewPaths = []

    if (this.#part.skeleton) {
      viewPaths.push(`skeleton/${this.#part.skeleton}`)
    }

    for (let key in this.#part) {
      if (['skeleton'].includes(key)) continue
      if (this.#part[key]) {
        const viewPath = this.#part[key].replace(/\./g, '/')
        viewPaths.push(`view/${key}/${viewPath}`)
      }
    }

    let hints = this.#earlyHints.getHints(null, this.#hintCacheKey())

    if (!hints && viewPaths.length > 0) {
      hints = this.#earlyHints.getHintsForViewFiles(viewPaths)
    }

    if (hints && hints.length > 0) {
      this.#odac.Request.setEarlyHints(hints)
    }
  }

  async #exists(path) {
    // In production view files do not change while the process runs; each is checked once.
    const known = !this.#odac.Config?.debug ? global.Odac.View?.exists : null
    if (known?.has(path)) return known.get(path)
    let found
    try {
      await fsPromises.access(path)
      found = true
    } catch {
      found = false
    }
    if (!this.#odac.Config?.debug) {
      if (!global.Odac.View.exists) global.Odac.View.exists = new Map()
      global.Odac.View.exists.set(path, found)
    }
    return found
  }

  async #readSkeleton(path) {
    if (!global.Odac.View.skeletons) global.Odac.View.skeletons = {}

    // In production (debug=false), cache logic
    if (!this.#odac.Config?.debug && global.Odac.View.skeletons[path]) {
      return global.Odac.View.skeletons[path]
    }

    const content = this.#wrapPlaceholders(await fsPromises.readFile(path, 'utf8'))
    global.Odac.View.skeletons[path] = content
    return content
  }
}

module.exports = View
