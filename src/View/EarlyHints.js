const fs = require('fs').promises
const path = require('path')

// Upper bound for learned hint sets. Keys are view combinations, which are finite in a normal
// app; the cap only guards against apps that build view names from request input.
const DEFAULT_MAX_CACHE_ENTRIES = 1000

// Resource paths by type; a query string or fragment may follow the extension.
const STYLE_PATH = /\.css(?:[?#]|$)/i
const SCRIPT_PATH = /\.m?js(?:[?#]|$)/i
const FONT_PATH = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i

// Attributes of one start tag as a lower-cased name -> value map (a bare attribute is '').
function parseAttributes(tag) {
  const attrs = new Map()
  const body = tag.replace(/^<[a-z]+/i, '').replace(/\/?>$/, '')
  for (const match of body.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g)) {
    const name = match[1].toLowerCase()
    if (!attrs.has(name)) attrs.set(name, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

class EarlyHints {
  #manifest = {}
  #cache = new Map()
  #config = null
  #initialized = false

  constructor(config) {
    this.#config = config || {
      enabled: true,
      auto: true,
      maxResources: 5
    }
  }

  async init() {
    if (this.#initialized) return
    this.#initialized = true

    if (!this.#config.enabled) return

    await this.#buildManifest()
  }

  async #buildManifest() {
    const viewDir = path.join(process.cwd(), 'view')
    const skeletonDir = path.join(process.cwd(), 'skeleton')

    try {
      try {
        await fs.access(viewDir)
        const files = await this.#getAllViewFiles(viewDir)
        await Promise.all(
          files.map(async file => {
            const html = await fs.readFile(file, 'utf8')
            const resources = this.#extractResources(html)

            const relativePath = path.relative(viewDir, file)
            const viewName = 'view/' + relativePath.replace(/\.html$/, '').replace(/\\/g, '/')

            if (resources.length > 0) {
              this.#manifest[viewName] = resources
            }
          })
        )
      } catch {
        // viewDir might not exist
      }

      try {
        await fs.access(skeletonDir)
        const files = await this.#getAllViewFiles(skeletonDir)
        await Promise.all(
          files.map(async file => {
            const html = await fs.readFile(file, 'utf8')
            const resources = this.#extractResources(html)

            const relativePath = path.relative(skeletonDir, file)
            const viewName = 'skeleton/' + relativePath.replace(/\.html$/, '').replace(/\\/g, '/')

            if (resources.length > 0) {
              this.#manifest[viewName] = resources
            }
          })
        )
      } catch {
        // skeletonDir might not exist
      }
    } catch {
      // Silently fail, manifest building is optional
    }
  }

  async #getAllViewFiles(dir, files = []) {
    const entries = await fs.readdir(dir, {withFileTypes: true})

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.#getAllViewFiles(fullPath, files)
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        files.push(fullPath)
      }
    }

    return files
  }

  /**
   * Finds the render-blocking resources in a page's <head>.
   * Why: attributes are parsed instead of searched as text, so a file named
   * "deferred-loader.js" or a "data-async" attribute no longer hides a blocking script, and
   * query strings (app.js?v=3), .mjs files and unquoted attributes are recognised. Module
   * scripts are deferred by the browser and are not hinted as classic scripts.
   */
  #extractResources(html) {
    const resources = []

    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i)
    if (!headMatch) return resources

    const head = headMatch[1]
    const links = [...head.matchAll(/<link\b[^>]*>/gi)].map(match => parseAttributes(match[0]))
    const scripts = [...head.matchAll(/<script\b[^>]*>/gi)].map(match => parseAttributes(match[0]))

    for (const attrs of links) {
      const href = attrs.get('href')
      if (!href || attrs.has('defer') || !STYLE_PATH.test(href)) continue
      if (!(attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet')) continue
      resources.push({href, as: 'style'})
    }

    for (const attrs of scripts) {
      const src = attrs.get('src')
      if (!src || attrs.has('defer') || attrs.has('async') || !SCRIPT_PATH.test(src)) continue
      if ((attrs.get('type') ?? '').toLowerCase() === 'module') continue
      resources.push({href: src, as: 'script'})
    }

    for (const attrs of links) {
      const href = attrs.get('href')
      if (!href || attrs.has('defer') || !FONT_PATH.test(href)) continue
      resources.push({href, as: 'font', crossorigin: 'anonymous'})
    }

    return resources.slice(0, this.#config.maxResources)
  }

  getHints(viewPath, cacheKey) {
    if (!this.#config.enabled || !this.#config.auto) return null

    let hints = this.#manifest[viewPath]

    if (!hints && cacheKey) {
      hints = this.#cache.get(cacheKey)
      if (hints) {
        // Refresh recency for the LRU.
        this.#cache.delete(cacheKey)
        this.#cache.set(cacheKey, hints)
      }
    }

    // An empty cached set means "scanned, nothing to hint"; callers may still use the manifest.
    return hints && hints.length > 0 ? hints : null
  }

  getHintsForViewFiles(viewPaths) {
    if (!this.#config.enabled || !this.#config.auto) return null

    for (const viewPath of viewPaths) {
      const hints = this.#manifest[viewPath]
      if (hints && hints.length > 0) {
        return hints
      }
    }

    return null
  }

  /**
   * Remembers the preload resources detected in a rendered page.
   * Why: hints are only useful if they are known before rendering starts. The key must
   * identify the views that produced the HTML (see View), not the request URL; URL keys
   * add one permanent entry per distinct path and let any client grow worker memory.
   * The cache is an LRU bounded by `maxCacheEntries`.
   * @param {string} key View-combination key.
   * @param {Array<{href: string, as: string}>} resources
   */
  cacheHints(key, resources) {
    if (!this.#config.enabled || !this.#config.auto) return
    // An empty list is cached too: it records that the page was scanned and has nothing to hint.
    if (!key || !Array.isArray(resources)) return

    this.#cache.delete(key)
    this.#cache.set(key, resources)

    const limit = this.#config.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES
    while (this.#cache.size > limit) this.#cache.delete(this.#cache.keys().next().value)
  }

  /**
   * Whether a hint set (possibly empty) is cached for `key`.
   * Why: lets View skip re-scanning a page whose resources are already known.
   * @param {string} key
   * @returns {boolean}
   */
  isCached(key) {
    if (!this.#config.enabled || !this.#config.auto) return true
    return this.#cache.has(key)
  }

  extractFromHtml(html) {
    if (!this.#config.enabled || !this.#config.auto) return []

    return this.#extractResources(html)
  }

  formatLinkHeader(resource) {
    let header = `<${resource.href}>; rel=preload; as=${resource.as}`
    if (resource.crossorigin) {
      header += `; crossorigin`
    }
    if (resource.type) {
      header += `; type=${resource.type}`
    }
    return header
  }

  send(res, resources) {
    if (!this.#config.enabled || !resources || resources.length === 0) return false
    if (res.headersSent || res.writableEnded) return false

    try {
      const links = resources.map(r => this.formatLinkHeader(r))

      if (typeof res.writeEarlyHints === 'function') {
        res.writeEarlyHints({link: links})
      }

      res.setHeader('X-Odac-Early-Hints', JSON.stringify(links))

      return true
    } catch {
      return false
    }
  }
}

module.exports = EarlyHints
