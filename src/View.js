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

class View {
  #earlyHints = null
  #part = {}
  #refresh = new Set()
  #odac = null

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
  async print() {
    if (this.#odac.Request.res.finished) return

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
        if (this.#part[element]) {
          // Skip rendering if the part view path has not changed and refresh is not forced
          // Content is always re-rendered since its output depends on the current URL
          if (element !== 'content' && !this.#refresh.has(element) && clientParts[element] && clientParts[element] === this.#part[element])
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
      this.#odac.Request.header('Vary', 'X-Odac')

      this.#odac.Request.end({
        output: output,
        parts: currentParts,
        variables: variables,
        data: this.#odac.Request.sharedData,
        title: title,
        skeletonChanged: skeletonChanged
      })
      return
    }

    // Normal page rendering
    let result = ''
    if (this.#part.skeleton && (await this.#exists(`./skeleton/${this.#part.skeleton}.html`))) {
      result = await this.#readSkeleton(`./skeleton/${this.#part.skeleton}.html`)

      // Add data-odac-navigate to content wrapper for auto-navigation
      result = this.#addNavigateAttribute(result)
      result = await this.#fillSkeleton(result)
    }

    if (result) {
      const hasEarlyHints = this.#odac.Request.hasEarlyHints()

      if (!hasEarlyHints) {
        const detectedResources = this.#earlyHints.extractFromHtml(result)

        if (detectedResources && detectedResources.length > 0) {
          this.#earlyHints.cacheHints(this.#hintCacheKey(), detectedResources)
        }
      }

      // Inject Shared Data
      const sharedScript = `<script type="application/json" id="odac-data">${serializeForScript(this.#odac.Request.sharedData || {})}</script>`
      if (result.includes('</body>')) {
        // Function replacer: the payload may contain `$&`/`$'` sequences that a string replacement would expand.
        result = result.replace('</body>', () => `${sharedScript}</body>`)
      } else {
        result += sharedScript
      }
    }

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

  async #render(file) {
    if (!global.Odac.View) global.Odac.View = {}
    if (!global.Odac.View.cache) global.Odac.View.cache = {}

    // Performance: In Production, skip stat check if cached
    if (!this.#odac.Config?.debug && global.Odac.View.cache[file]) {
      try {
        return await require(`${__dir}/${CACHE_DIR}/${global.Odac.View.cache[file].cache}`)(
          this.#odac,
          key => this.#odac.Request.get(key),
          (...args) => this.#odac.Lang.get(...args)
        )
      } catch {
        // Fallback if cache file missing
      }
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
      await fsPromises.mkdir(`${__dir}/${CACHE_DIR}`, {recursive: true})
      await fsPromises.writeFile(
        `${__dir}/${CACHE_DIR}/${cache}`,
        `module.exports = async (Odac, get, __) => {\nlet html = '';\n${result}\nreturn html.trim()\n}`
      )
      delete require.cache[require.resolve(`${__dir}/${CACHE_DIR}/${cache}`)]
      if (!Odac.View) Odac.View = {}
      if (!Odac.View.cache) Odac.View.cache = {}
      Odac.View.cache[file] = {
        mtime: mtime,
        cache: cache
      }
    }
    try {
      return await require(`${__dir}/${CACHE_DIR}/${Odac.View.cache[file].cache}`)(
        this.#odac,
        key => this.#odac.Request.get(key),
        (...args) => this.#odac.Lang.get(...args)
      )
    } catch (e) {
      let stackLine = e.stack.split('\n')[1].match(/:(\d+):\d+/)
      let line = stackLine ? parseInt(stackLine[1]) - 3 : e.lineNumber ? e.lineNumber - 3 : 'unknown'
      console.error(e.toString().split('\n')[0] + `\n  in line ${line}\n  of "${file}"`)
    }
    return ''
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

  #addNavigateAttribute(skeleton) {
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

    const skeletonName = this.#part.skeleton || 'main'
    const pageName = this.#odac.Request.page || ''

    skeleton = skeleton.replace(/<html([^>]*)>/, (match, attrs) => {
      const updates = []
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
    try {
      await fsPromises.access(path)
      return true
    } catch {
      return false
    }
  }

  async #readSkeleton(path) {
    if (!global.Odac.View.skeletons) global.Odac.View.skeletons = {}

    // In production (debug=false), cache logic
    if (!this.#odac.Config?.debug && global.Odac.View.skeletons[path]) {
      return global.Odac.View.skeletons[path]
    }

    const content = await fsPromises.readFile(path, 'utf8')
    global.Odac.View.skeletons[path] = content
    return content
  }
}

module.exports = View
