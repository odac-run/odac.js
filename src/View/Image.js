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
  /** @type {Map<string, {path: string, type: string}>} In-memory index of processed images */
  static #cache = new Map()

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
   * Identical source + options always produce the same hash, enabling
   * cache deduplication across templates and requests.
   * @param {string} src - Source image path (relative to public/)
   * @param {object} options - Transformation options (width, height, format, quality)
   * @returns {string} 16-character hex hash
   */
  static hash(src, options = {}) {
    const payload = JSON.stringify({
      src,
      w: options.width || null,
      h: options.height || null,
      f: options.format || null,
      q: options.quality || null
    })
    return nodeCrypto.createHash('md5').update(payload).digest('hex').substring(0, 16)
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
    return ext || 'jpeg'
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
   * @param {string} src - Source path relative to public/ (e.g. '/images/hero.jpg')
   * @param {object} options - {width, height, format, quality}
   * @returns {Promise<{path: string, type: string}|null>} Cached file info or null on failure
   */
  static async process(src, options = {}) {
    if (!this.isAvailable()) return null

    const imgHash = this.hash(src, options)
    const format = this.#resolveFormat(src, options.format)
    const cacheKey = `${imgHash}.${format}`

    // O(1) in-memory cache hit
    if (this.#cache.has(cacheKey)) return this.#cache.get(cacheKey)

    const cachePath = path.join(IMG_CACHE_DIR, cacheKey)

    // Disk cache hit — populate in-memory index without reprocessing
    try {
      await fsPromises.access(cachePath)
      const result = {path: cachePath, type: `image/${format}`}
      this.#cache.set(cacheKey, result)
      return result
    } catch {
      // Cache miss — proceed to process
    }

    // Resolve source file from public directory
    const sourcePath = path.join(global.__dir || process.cwd(), 'public', src)

    // Path traversal guard
    const publicDir = path.resolve(global.__dir || process.cwd(), 'public')
    const resolvedSource = path.resolve(sourcePath)
    if (!resolvedSource.startsWith(publicDir + path.sep) && resolvedSource !== publicDir) {
      console.error(`[ODAC Image] Path traversal blocked: ${src}`)
      return null
    }

    // Validate source extension
    const sourceExt = path.extname(src).slice(1).toLowerCase()
    if (!this.SUPPORTED_INPUTS.has(sourceExt)) return null

    try {
      await fsPromises.access(resolvedSource)
    } catch {
      return null
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

      const result = {path: cachePath, type: `image/${format}`}
      this.#cache.set(cacheKey, result)
      return result
    } catch (e) {
      console.error(`[ODAC Image] Processing failed for "${src}":`, e.message)
      return null
    }
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

    // Trigger processing — returns immediately on cache hit
    const result = await this.process(src, options)
    if (!result) {
      // Processing failed — fall back to original src
      return this.#renderImgTag(src, attrs, processingAttrs)
    }

    const imgHash = this.hash(src, options)
    const outputFormat = this.#resolveFormat(src, format)
    const processedSrc = `/_odac/img/${imgHash}.${outputFormat}`

    return this.#renderImgTag(processedSrc, attrs, processingAttrs)
  }

  /**
   * Renders a standard HTML `<img>` tag from the given attributes,
   * excluding processing-specific attributes (format, quality).
   * @param {string} src - The resolved src URL
   * @param {object} attrs - All parsed attributes
   * @param {Set<string>} exclude - Attribute names to exclude from HTML output
   * @returns {string} HTML img tag
   */
  static #renderImgTag(src, attrs, exclude) {
    let tag = `<img src="${src}"`

    // Alphabetical order for deterministic output
    const keys = Object.keys(attrs)
      .filter(k => !exclude.has(k))
      .sort()
    for (const key of keys) {
      const value = attrs[key]
      if (value === true) {
        tag += ` ${key}`
      } else {
        tag += ` ${key}="${value}"`
      }
    }

    tag += '>'
    return tag
  }

  /**
   * Clears the in-memory cache index. Useful during hot-reload in
   * development mode to pick up re-processed images.
   */
  static clearCache() {
    this.#cache.clear()
  }
}

module.exports = Image
