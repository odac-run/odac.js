const nodeCrypto = require('crypto')
const fs = require('fs')
const fsPromises = fs.promises
const path = require('path')

const IMG_CACHE_DIR = './storage/.cache/img'

/**
 * Handles on-demand image processing (resize + format conversion) for the
 * ODAC template engine's `<odac:img>` tag. Uses sharp as an optional dependency
 * to keep the framework lightweight — when sharp is unavailable, the tag
 * gracefully degrades to a standard `<img>` element with no processing.
 *
 * Processed images are cached to disk so that only the first request incurs
 * the transformation cost; subsequent requests are served at near-zero latency.
 */
class Image {
  /** @type {Map<string, {path: string, type: string, cacheKey: string}>} In-memory index of processed images */
  static #cache = new Map()

  /** @type {Map<string, Promise>} In-flight processing promises to prevent duplicate work */
  static #inflight = new Map()

  /** @type {Map<string, number>} Source file mtime cache — eliminates per-render stat() in production */
  static #mtimeCache = new Map()

  /** @type {number} Maximum entries in the in-memory cache to prevent unbounded growth */
  static #MAX_CACHE_SIZE = 1000

  /** @type {boolean|null} Lazy-evaluated sharp availability flag */
  static #sharpAvailable = null

  /** @type {Set<string>} Supported output formats for format conversion */
  static SUPPORTED_FORMATS = new Set(['webp', 'avif', 'png', 'jpeg', 'jpg', 'tiff'])

  /** @type {Set<string>} Supported source extensions that sharp can process */
  static SUPPORTED_INPUTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif', 'webp', 'avif', 'svg'])

  /** @type {number} Default JPEG/WebP quality when not specified by the user */
  static DEFAULT_QUALITY = 80

  /** @type {number} Maximum allowed dimension to prevent abuse */
  static MAX_DIMENSION = 4096

  /**
   * Checks whether sharp is installed and usable. The result is memoized
   * so the require() probe runs at most once per process lifetime.
   * @returns {boolean}
   */
  static isAvailable() {
    if (this.#sharpAvailable !== null) return this.#sharpAvailable

    try {
      require('sharp')
      this.#sharpAvailable = true
    } catch {
      this.#sharpAvailable = false
      console.warn('[ODAC] <odac:img> image processing is disabled. Run: npm install sharp')
    }

    return this.#sharpAvailable
  }

  /**
   * Generates a deterministic hash from the image transformation parameters.
   * Identical source + options + mtime always produce the same hash, enabling
   * cache deduplication across templates and requests while ensuring cache
   * invalidation when the source file changes.
   * @param {string} src - Source image path (relative to public/)
   * @param {object} options - Transformation options (width, height, format, quality)
   * @param {number} [mtime=0] - Source file modification time (ms) for cache busting
   * @returns {string} 8-character hex hash
   */
  static hash(src, options = {}, mtime = 0) {
    const payload = JSON.stringify({
      src,
      w: options.width || null,
      h: options.height || null,
      f: options.format || null,
      q: options.quality || null,
      m: mtime
    })
    return nodeCrypto.createHash('md5').update(payload).digest('hex').substring(0, 8)
  }

  /**
   * Builds a human-readable cache filename from the source path and options.
   * Pattern: {name}-{dimension}-{hash8}.{ext}
   * Examples: logo-250-a1b2c3d4.webp, hero-o-f9e8d7c6.avif
   *
   * The dimension segment uses width if specified, otherwise 'o' (original).
   * The hash suffix guarantees uniqueness across different paths, quality
   * settings, height values, and source file versions (via mtime).
   *
   * @param {string} src - Source image path (e.g. '/images/logo.jpg')
   * @param {object} options - {width, height, format, quality}
   * @param {number} [mtime=0] - Source file modification time for cache busting
   * @returns {string} Cache filename (e.g. 'logo-250-a1b2c3d4.webp')
   */
  static buildFilename(src, options = {}, mtime = 0) {
    const imgHash = this.hash(src, options, mtime)
    const format = this.#resolveFormat(src, options.format)
    const basename = path.basename(src, path.extname(src)).replace(/[^a-zA-Z0-9_-]/g, '_')
    const dimension = options.width ? String(parseInt(options.width, 10)) : 'o'
    return `${basename}-${dimension}-${imgHash}.${format}`
  }

  /**
   * Resolves the output format: uses the requested format if valid,
   * otherwise falls back to the source file's extension.
   * @param {string} src - Source file path
   * @param {string|null} requestedFormat - User-requested output format
   * @returns {string} Normalized format string (e.g. 'webp', 'jpeg')
   */
  static #resolveFormat(src, requestedFormat) {
    if (requestedFormat) {
      const normalized = requestedFormat.toLowerCase()
      if (normalized === 'jpg') return 'jpeg'
      if (this.SUPPORTED_FORMATS.has(normalized)) return normalized
    }

    const ext = path.extname(src).slice(1).toLowerCase()
    if (ext === 'jpg') return 'jpeg'
    if (this.SUPPORTED_FORMATS.has(ext)) return ext

    return 'jpeg'
  }

  /**
   * Clamps a dimension value to safe bounds, preventing resource exhaustion
   * from absurdly large resize requests.
   * @param {string|number|null} value - Raw dimension value from template attribute
   * @returns {number|null} Clamped integer or null if not specified
   */
  static #parseDimension(value) {
    if (!value) return null
    const num = parseInt(value, 10)
    if (isNaN(num) || num <= 0) return null
    return Math.min(num, this.MAX_DIMENSION)
  }

  /**
   * Processes a source image: resizes and/or converts format, then writes
   * the result to the cache directory. Returns the cached file path.
   *
   * Uses sharp's pipeline API for single-pass processing (no intermediate
   * buffers), keeping memory pressure minimal even for large images.
   *
   * Concurrent requests for the same variant are coalesced via an in-flight
   * promise map, preventing duplicate sharp pipelines and file write races.
   *
   * @param {string} src - Source path relative to public/ (e.g. '/images/hero.jpg')
   * @param {object} options - {width, height, format, quality}
   * @returns {Promise<{path: string, type: string}|null>} Cached file info or null on failure
   */
  static async process(src, options = {}, mtime = 0) {
    if (!this.isAvailable()) return null

    const cacheKey = this.buildFilename(src, options, mtime)

    // O(1) in-memory cache hit
    if (this.#cache.has(cacheKey)) return this.#cache.get(cacheKey)

    // Coalesce concurrent requests for the same variant
    if (this.#inflight.has(cacheKey)) return this.#inflight.get(cacheKey)

    const format = this.#resolveFormat(src, options.format)
    const promise = this.#processInternal(src, cacheKey, format, options, mtime > 0)
    this.#inflight.set(cacheKey, promise)

    try {
      return await promise
    } finally {
      this.#inflight.delete(cacheKey)
    }
  }

  /**
   * Internal processing pipeline — separated from process() to keep the
   * in-flight coalescing logic clean and the actual I/O isolated.
   * @param {string} src - Source path relative to public/
   * @param {string} cacheKey - Pre-computed cache key (hash.format)
   * @param {string} format - Resolved output format
   * @param {object} options - Processing options
   * @param {boolean} sourceVerified - When true, skips the redundant access check (caller already stat'd the file)
   * @returns {Promise<{path: string, type: string}|null>}
   */
  static async #processInternal(src, cacheKey, format, options, sourceVerified = false) {
    const cachePath = path.join(IMG_CACHE_DIR, cacheKey)

    // Disk cache hit — populate in-memory index without reprocessing
    try {
      await fsPromises.access(cachePath)
      const result = {path: cachePath, type: `image/${format}`, cacheKey}
      this.#setCacheEntry(cacheKey, result)
      return result
    } catch {
      // Cache miss — proceed to process
    }

    // Resolve source file from public directory
    const baseDir = global.__dir || process.cwd()
    const sourcePath = path.join(baseDir, 'public', src)

    // Path traversal guard
    const publicDir = path.resolve(baseDir, 'public')
    const resolvedSource = path.resolve(sourcePath)
    if (!resolvedSource.startsWith(publicDir + path.sep) && resolvedSource !== publicDir) {
      console.error(`[ODAC Image] Path traversal blocked: ${src}`)
      return null
    }

    // Validate source extension
    const sourceExt = path.extname(src).slice(1).toLowerCase()
    if (!this.SUPPORTED_INPUTS.has(sourceExt)) return null

    // Skip access check when render() already confirmed the file exists via stat
    if (!sourceVerified) {
      try {
        await fsPromises.access(resolvedSource)
      } catch {
        return null
      }
    }

    const width = this.#parseDimension(options.width)
    const height = this.#parseDimension(options.height)
    const quality = Math.min(Math.max(parseInt(options.quality, 10) || this.DEFAULT_QUALITY, 1), 100)

    try {
      const sharp = require('sharp')
      let pipeline = sharp(resolvedSource)

      // Resize only if dimensions are specified
      if (width || height) {
        pipeline = pipeline.resize(width, height, {
          fit: 'inside',
          withoutEnlargement: true
        })
      }

      // Format conversion with quality setting
      pipeline = pipeline.toFormat(format, {quality})

      await fsPromises.mkdir(IMG_CACHE_DIR, {recursive: true})
      await pipeline.toFile(cachePath)

      const result = {path: cachePath, type: `image/${format}`, cacheKey}
      this.#setCacheEntry(cacheKey, result)
      return result
    } catch (e) {
      console.error(`[ODAC Image] Processing failed for "${src}":`, e.message)
      return null
    }
  }

  /**
   * Adds an entry to the in-memory cache with FIFO eviction.
   * When the cache exceeds MAX_CACHE_SIZE, the oldest entry (first inserted)
   * is evicted to bound memory usage in high-variant deployments.
   * @param {string} key - Cache key
   * @param {{path: string, type: string}} value - Cached result
   */
  static #setCacheEntry(key, value) {
    if (this.#cache.size >= this.#MAX_CACHE_SIZE) {
      const oldest = this.#cache.keys().next().value
      this.#cache.delete(oldest)
    }
    this.#cache.set(key, value)
  }

  /**
   * Serves a previously processed image by its cache hash. Called by the
   * internal `/_odac/img/{hash}.{ext}` route handler.
   *
   * Returns a readable stream for zero-copy transfer to the HTTP response,
   * avoiding full file buffering in memory.
   *
   * @param {string} filename - Cache filename (e.g. 'abc123def.webp')
   * @returns {Promise<{stream: ReadableStream, type: string, size: number}|null>}
   */
  static async serve(filename) {
    const cachePath = path.join(IMG_CACHE_DIR, filename)

    // Prevent directory traversal in the filename
    const resolvedCache = path.resolve(cachePath)
    const cacheDir = path.resolve(IMG_CACHE_DIR)
    if (!resolvedCache.startsWith(cacheDir + path.sep) && resolvedCache !== cacheDir) {
      return null
    }

    try {
      const stat = await fsPromises.stat(resolvedCache)
      if (!stat.isFile()) return null

      const ext = path.extname(filename).slice(1).toLowerCase()
      const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`

      return {
        stream: fs.createReadStream(resolvedCache),
        type,
        size: stat.size
      }
    } catch {
      return null
    }
  }

  /**
   * Processes the image (if needed) and returns the complete `<img>` HTML tag.
   * Called at template render time via the compiled `<odac:img>` tag output.
   * When sharp is unavailable, gracefully degrades to a standard `<img>`.
   *
   * @param {object} attrs - Parsed attributes from the `<odac:img>` tag
   * @returns {Promise<string>} Complete `<img>` HTML tag
   */
  static async render(attrs) {
    const src = attrs.src || ''
    const format = attrs.format || global.Odac?.Config?.image?.format || null
    const quality = attrs.quality || global.Odac?.Config?.image?.quality || null

    // Attributes that control processing (not passed to HTML output)
    const processingAttrs = new Set(['src', 'format', 'quality'])

    if (!this.isAvailable() || !src) {
      return this.#renderImgTag(src, attrs, processingAttrs)
    }

    const options = {
      width: attrs.width || null,
      height: attrs.height || null,
      format,
      quality
    }

    // Production mtime cache: eliminates a stat() syscall per render when the
    // source file hasn't changed. Development always stats for hot-reload.
    const isDebug = global.Odac?.Config?.debug !== false
    const baseDir = global.__dir || process.cwd()
    const sourcePath = path.join(baseDir, 'public', src)
    let mtime = 0

    if (!isDebug && this.#mtimeCache.has(src)) {
      mtime = this.#mtimeCache.get(src)
    } else {
      try {
        const stat = await fsPromises.stat(sourcePath)
        mtime = stat.mtimeMs
        if (!isDebug) this.#mtimeCache.set(src, mtime)
      } catch {
        // Source not found — process() will handle the error
      }
    }

    // Trigger processing — returns immediately on cache hit
    const result = await this.process(src, options, mtime)
    if (!result) {
      return this.#renderImgTag(src, attrs, processingAttrs)
    }

    // Use cacheKey from process() result — avoids recomputing hash + buildFilename
    const processedSrc = `/_odac/img/${result.cacheKey}`

    return this.#renderImgTag(processedSrc, attrs, processingAttrs)
  }

  /**
   * Returns the processed image URL without generating an HTML tag.
   * Designed for use in controllers, cron jobs, mail templates, or anywhere
   * a raw URL is needed (e.g. CSS background-image, JSON API responses).
   *
   * When sharp is unavailable or processing fails, returns the original
   * source path so the caller always gets a usable URL.
   *
   * @param {string} src - Source path relative to public/ (e.g. '/images/hero.jpg')
   * @param {object} [options] - {width, height, format, quality}
   * @returns {Promise<string>} Processed image URL or original src as fallback
   */
  static async url(src, options = {}) {
    if (!src) return ''
    if (!this.isAvailable()) return src

    const format = options.format || global.Odac?.Config?.image?.format || null
    const quality = options.quality || global.Odac?.Config?.image?.quality || null
    const opts = {width: options.width || null, height: options.height || null, format, quality}

    const isDebug = global.Odac?.Config?.debug !== false
    const baseDir = global.__dir || process.cwd()
    const sourcePath = path.join(baseDir, 'public', src)
    let mtime = 0

    if (!isDebug && this.#mtimeCache.has(src)) {
      mtime = this.#mtimeCache.get(src)
    } else {
      try {
        const stat = await fsPromises.stat(sourcePath)
        mtime = stat.mtimeMs
        if (!isDebug) this.#mtimeCache.set(src, mtime)
      } catch {
        return src
      }
    }

    const result = await this.process(src, opts, mtime)
    if (!result) return src

    return `/_odac/img/${result.cacheKey}`
  }

  /**
   * Compile-time parser that converts `<odac:img>` template tags into
   * `<script:odac>` blocks containing runtime Image.render() calls.
   *
   * Runs in the View#render pipeline BEFORE jsBlocks extraction, so the
   * generated `<script:odac>` blocks are properly protected from template
   * literal escaping — identical to how Form.parse operates.
   *
   * @param {string} content - Raw template HTML
   * @returns {string} Template with `<odac:img>` tags replaced by `<script:odac>` blocks
   */
  static parse(content) {
    return content.replace(/<odac:img\s+([^>]*?)\/?>/g, (fullMatch, attributes) => {
      const attrs = {}
      const attrRegex = /(\w[\w-]*)(?:=(["'])((?:(?!\2).)*)\2|=([^\s>]+))?/g
      let match
      while ((match = attrRegex.exec(attributes))) {
        const key = match[1]
        const value = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : true
        attrs[key] = value
      }

      if (!attrs.src) return fullMatch

      let attrsStr = JSON.stringify(attrs)

      // Unquote dynamic template expressions so they become live JS at runtime
      attrsStr = attrsStr.replace(/"\{\{([\s\S]*?)\}\}"/g, '(await Odac.Var(await $1).html())')
      attrsStr = attrsStr.replace(/"\{!!([\s\S]*?)!!\}"/g, '(await $1)')

      return `<script:odac>html += await Odac.View.Image.render(${attrsStr});</script:odac>`
    })
  }

  /**
   * Escapes HTML special characters in attribute values to prevent XSS
   * injection through dynamic template expressions or user-controlled input.
   * @param {string} value - Raw attribute value
   * @returns {string} Escaped value safe for HTML attribute context
   */
  static #escapeAttr(value) {
    if (typeof value !== 'string') return value
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  /**
   * Renders a standard HTML `<img>` tag from the given attributes,
   * excluding processing-specific attributes (format, quality).
   * All attribute values are HTML-escaped to prevent XSS injection.
   * @param {string} src - The resolved src URL
   * @param {object} attrs - All parsed attributes
   * @param {Set<string>} exclude - Attribute names to exclude from HTML output
   * @returns {string} HTML img tag
   */
  static #renderImgTag(src, attrs, exclude) {
    let tag = `<img src="${this.#escapeAttr(src)}"`

    // Alphabetical order for deterministic output
    const keys = Object.keys(attrs)
      .filter(k => !exclude.has(k))
      .sort()
    for (const key of keys) {
      const value = attrs[key]
      if (value === true) {
        tag += ` ${key}`
      } else {
        tag += ` ${key}="${this.#escapeAttr(value)}"`
      }
    }

    tag += '>'
    return tag
  }

  /**
   * Clears all in-memory caches (processed image index + source mtime).
   * Useful during hot-reload in development mode to pick up re-processed
   * images and detect source file changes immediately.
   */
  static clearCache() {
    this.#cache.clear()
    this.#mtimeCache.clear()
  }
}

module.exports = Image
