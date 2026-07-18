const nodeCrypto = require('crypto')
const fs = require('fs')
const fsPromises = fs.promises
const path = require('path')
const os = require('os')

// decodeURIComponent throws a URIError on malformed percent-encoding (e.g. `%`
// or `%ZZ`). A single crafted query/body/path would otherwise bubble out and
// crash the worker (Node >=15 exits on unhandled rejection), so fall back to
// the raw value instead of throwing.
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

class OdacRequest {
  #odac
  #complete = false
  #cookies = {data: {}, sent: []}
  data = {post: {}, get: {}, url: {}}
  #files = {}
  #activeWrites = new Set()
  #cleanedUp = false
  #event = {data: [], end: []}
  #headers = {Server: 'Odac'}
  #status = 200
  #timeout = null
  #earlyHints = null
  #sessions = {}
  variables = {}
  sharedData = {}
  isAjaxLoad = false
  ajaxLoad = null
  clientSkeleton = null
  clientParts = null
  page = null

  constructor(id, req, res, odac) {
    this.id = id
    this.req = req
    this.res = res
    this.#odac = odac
    this.method = req.method.toLowerCase()
    this.url = req.url
    this.host = req.headers.host
    this.ssl = this.header('x-odac-connection-ssl') === 'true'
    this.ip = (this.header('x-odac-connection-remoteaddress') ?? req.connection.remoteAddress).replace('::ffff:', '')
    this.language = req.headers['accept-language']?.split(',')[0] ?? 'en'
    delete this.req.headers['x-odac-connection-ssl']
    delete this.req.headers['x-odac-connection-remoteaddress']
    let route = req.headers.host.split('.')[0]
    if (!global.Odac.Route.routes[route]) route = 'www'
    this.route = route
    if (this.res) {
      this.#armTimeout()
      // Client disconnected before we responded (e.g. aborted upload): drop temp files.
      if (typeof this.res.on === 'function') this.res.on('close', () => this.#cleanupFiles())
    }
    this.#data()
    if (!global.Odac.Request) global.Odac.Request = {}
  }

  // (Re)arm the idle timeout. Called once at construction and again on every
  // upload data chunk so a slow-but-progressing upload isn't killed at the
  // fixed timeout; the timer now measures idle time, not total request time.
  #armTimeout() {
    if (!this.res || this.res.finished) return
    clearTimeout(this.#timeout)
    const fn = () => !this.res.finished && this.abort(408)
    const ms = global.Odac.Config.request.timeout
    this.#timeout = typeof this.#odac.setTimeout === 'function' ? this.#odac.setTimeout(fn, ms) : setTimeout(fn, ms)
  }

  // - ABORT REQUEST
  async abort(code) {
    this.status(code)
    let result = {401: 'Unauthorized', 404: 'Not Found', 408: 'Request Timeout'}[code] ?? null
    const errorRoute = this.#odac.Route?.routes?.[this.route]?.error?.[code]
    if (errorRoute && typeof errorRoute.cache === 'function') {
      try {
        const handlerResult = await errorRoute.cache(this.#odac)
        // If the handler returned nothing, assume it configured the view via Odac.View.set()
        // and let Route.request() continue to View.print() like normal pages.
        if (handlerResult === undefined) return
        result = handlerResult
      } catch (e) {
        console.error(JSON.stringify({level: 'ERROR', message: `Error in custom error handler for ${code}`, error: e.message}))
      }
    }
    this.end(result)
  }

  // - SET COOKIE
  cookie(key, value, options = {}) {
    if (value === undefined) {
      if (this.#cookies.data[key]) return this.#cookies.data[key]
      const raw = this.req.headers.cookie?.split('; ').find(c => c.startsWith(key + '='))
      // Split on the first '=' only so base64 / padded values (which contain '=')
      // survive intact instead of being truncated by a naive split('=')[1].
      value = raw ? raw.slice(raw.indexOf('=') + 1) : null
      if (value && value.startsWith('{') && value.endsWith('}')) {
        try {
          value = JSON.parse(value)
        } catch {
          // Malformed JSON cookie: keep the raw string instead of throwing a 500.
        }
      }
      return value
    }
    this.#cookies.data[key] = value
    if (options.path === undefined) options.path = '/'
    if (options.expires === undefined) options.expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toUTCString()
    if (options.secure === undefined) options.secure = true
    if (options.httpOnly === undefined) options.httpOnly = true
    if (options.sameSite === undefined) options.sameSite = 'Lax'
    if (typeof value === 'object') value = JSON.stringify(value)
    let cookie = `${key}=${value}`
    for (const option of Object.keys(options)) if (options[option]) cookie += `; ${option}=${options[option]}`
    this.#cookies.sent.push(cookie)
  }

  #data() {
    let split = this.url.split('?')
    if (split[1]) {
      let data = split[1].split('&')
      for (let i = 0; i < data.length; i++) {
        if (data[i].indexOf('=') === -1) continue
        let key = safeDecode(data[i].split('=')[0])
        let val = safeDecode(data[i].split('=')[1] || '')
        this.data.get[key] = val
      }
    }

    const contentType = this.req.headers['content-type'] || ''
    if (contentType.startsWith('multipart/form-data')) {
      return this.#multipart()
    }

    // Non-multipart: urlencoded or JSON (buffered path)
    let body = ''
    this.req.on('data', chunk => {
      body += chunk.toString()
      const maxBodySize = global.Odac.Config.request.maxBodySize
      if (body.length > maxBodySize) {
        body = ''
        this.status(413)
        this.end()
        this.req.removeAllListeners('data')
        this.req.resume()
        this.#complete = true
        return
      }

      for (const event of this.#event.data) {
        event.callback(event.active ? chunk : body)
        event.active = true
      }
    })

    this.req.on('end', () => {
      if (!body) return (this.#complete = true)
      if (body.startsWith('{') && body.endsWith('}')) {
        try {
          this.data.post = JSON.parse(body)
        } catch {
          // invalid JSON, ignore
        }
      } else {
        let data = body.split('&')
        for (let i = 0; i < data.length; i++) {
          if (data[i].indexOf('=') === -1) continue
          let key = safeDecode(data[i].split('=')[0])
          let val = safeDecode(data[i].split('=')[1] || '')
          this.data.post[key] = val
        }
      }
      this.#complete = true
      for (const event of this.#event.end) event.callback()
    })
  }

  async #multipart() {
    const cfg = global.Odac.Config.request
    const busboy = require('busboy')

    const uploadDir = cfg.uploadDir || path.join(os.tmpdir(), 'odac-uploads')
    try {
      await fsPromises.mkdir(uploadDir, {recursive: true})
    } catch (err) {
      console.error('Failed to create upload directory:', err.message)
      this.status(500)
      this.end()
      this.#complete = true
      return
    }

    const bb = busboy({
      headers: this.req.headers,
      defParamCharset: 'utf8',
      limits: {fileSize: cfg.maxFileSize, files: cfg.maxFiles, fieldSize: cfg.maxBodySize, fields: 200}
    })

    // busboy 'close' can fire before our writeStreams flush to disk, so a file
    // isn't complete until BOTH the parser closed and every pending write ended.
    // Otherwise req.file() could resolve before #files is populated.
    let bbClosed = false
    const finalize = () => {
      if (this.#complete || !bbClosed || this.#activeWrites.size > 0) return
      this.#complete = true
      for (const event of this.#event.end) event.callback()
    }

    bb.on('field', (name, val) => {
      this.data.post[name] = val
    })

    bb.on('file', (fieldname, stream, info) => {
      // Empty optional file input: browsers send filename === '' for untouched input
      if (!info.filename) {
        stream.resume()
        return
      }

      const fileExt = path.extname(info.filename).toLowerCase().slice(1) || 'bin'
      const tmpPath = path.join(uploadDir, `odac-${nodeCrypto.randomBytes(16).toString('hex')}`)
      const writeStream = fs.createWriteStream(tmpPath)

      const active = {writeStream, tmpPath}
      this.#activeWrites.add(active)

      let fileSize = 0
      let truncated = false

      stream.on('data', chunk => {
        fileSize += chunk.length
      })

      // busboy stops feeding data once fileSize limit is hit and lets the
      // stream end naturally; just flag it so the writeStream 'finish' handler
      // can drop the partial file and record a truncated metadata object.
      stream.on('limit', () => {
        truncated = true
      })

      stream.pipe(writeStream)

      writeStream.on('finish', () => {
        this.#activeWrites.delete(active)

        // Oversize file: remove the partial write but still surface metadata so
        // the validator reports a per-field "too large" error instead of hanging.
        if (truncated) fs.unlink(tmpPath, () => {})

        const fileObj = {
          field: fieldname,
          name: path.basename(info.filename),
          ext: fileExt,
          mimetype: info.mimeType,
          size: fileSize,
          path: truncated ? null : tmpPath,
          truncated: truncated,
          stored: false,
          move: async dest => this.#moveFile(fileObj, dest)
        }

        if (!Array.isArray(this.#files[fieldname])) {
          this.#files[fieldname] = []
        }
        this.#files[fieldname].push(fileObj)
        finalize()
      })

      writeStream.on('error', () => {
        this.#activeWrites.delete(active)
        stream.resume()
        fs.unlink(tmpPath, () => {})
        finalize()
      })
    })

    bb.on('close', () => {
      bbClosed = true
      finalize()
    })

    bb.on('error', err => {
      if (this.#complete) return
      console.error('Busboy error:', err.message)
      this.#complete = true
      for (const event of this.#event.end) event.callback()
      // Malformed multipart body: send 400 instead of letting the handler run on
      // partial data. #complete is already set so any pending req.file()/request()
      // pollers resolve, and res.finished blocks any later controller response.
      this.abort(400)
    })

    // Keep the timeout as an *idle* deadline: reset it while upload data keeps
    // arriving so large-but-progressing uploads aren't aborted at 408.
    this.req.on('data', () => this.#armTimeout())
    this.req.pipe(bb)
  }

  // Move the uploaded temp file to a permanent, caller-chosen location. The
  // destination is developer-controlled (like any fs call): if you build it from
  // raw user input, sanitize it yourself — the file object's own `.name` is
  // already basename-only. Handles cross-device moves via copy+unlink fallback.
  async #moveFile(fileObj, dest) {
    if (!fileObj.path || fileObj.stored) {
      throw new Error('Cannot move a truncated or already-moved file')
    }

    const resolved = path.resolve(dest)

    try {
      await fsPromises.mkdir(path.dirname(resolved), {recursive: true})
    } catch {
      // directory may already exist
    }

    try {
      await fsPromises.rename(fileObj.path, resolved)
    } catch (err) {
      if (err.code === 'EXDEV') {
        // Source and destination are on different filesystems: copy then remove.
        await fsPromises.copyFile(fileObj.path, resolved)
        await fsPromises.unlink(fileObj.path)
      } else {
        throw err
      }
    }

    fileObj.path = resolved
    fileObj.stored = true
    return resolved
  }

  // - RETURN REQUEST
  end(data) {
    if (data instanceof Promise) return data.then(result => this.end(result))
    if (this.res.finished) return
    if (typeof data === 'object' && data !== null && data.type !== 'Buffer') {
      let json = JSON.stringify(data)
      if (json.length > 0 && JSON.parse(json).type !== 'Buffer') {
        data = json
        this.header('Content-Type', 'application/json')
      }
    }
    clearTimeout(this.#timeout)
    this.print()
    this.res.end(data)
    this.#cleanupFiles()
    this.req.connection.destroy()
  }

  // Remove temp files that were never moved to permanent storage. Runs after a
  // normal response (end) and on early client disconnect (res 'close'), covering
  // both in-progress writes (aborted mid-upload) and finished-but-unstored files.
  #cleanupFiles() {
    if (this.#cleanedUp) return
    this.#cleanedUp = true

    for (const active of this.#activeWrites) {
      active.writeStream.destroy()
      fs.unlink(active.tmpPath, () => {})
    }
    this.#activeWrites.clear()

    for (const fieldFiles of Object.values(this.#files)) {
      for (const file of fieldFiles) {
        if (!file.stored && file.path) {
          fs.unlink(file.path, () => {})
        }
      }
    }
  }

  // - GET
  get(key) {
    return this.variables[key] ? this.variables[key].value : null
  }

  // - SET HEADER
  header(key, value) {
    if (value === null) delete this.#headers[key]
    else if (value !== undefined) this.#headers[key] = value
    else for (const header of Object.keys(this.req.headers)) if (header.toLowerCase() === key.toLowerCase()) return this.req.headers[header]
  }

  // - ON EVENT
  on(event, callback) {
    if (this.#event[event]) this.#event[event].push({callback: callback, active: false})
    else return false
  }

  // - PRINT HEADERS
  print() {
    if (this.res.headersSent) return

    if (this.#earlyHints && this.#earlyHints.length > 0 && global.Odac?.View?.EarlyHints) {
      global.Odac.View.EarlyHints.send(this.res, this.#earlyHints)
    }

    this.#headers['Set-Cookie'] = this.#cookies.sent
    this.res.writeHead(this.#status, this.#headers)
  }

  // - SET EARLY HINTS
  setEarlyHints(hints) {
    this.#earlyHints = hints
  }

  // - HAS EARLY HINTS
  hasEarlyHints() {
    return this.#earlyHints !== null && this.#earlyHints.length > 0
  }

  // - REDIRECT
  redirect(url) {
    this.header('Location', url)
    this.status(302)
    this.end()
  }

  // - GET REQUEST
  async request(key, method) {
    if (method) method = method.toLowerCase()
    // Buckets to search, in priority order: a scoped call looks only at its own
    // bucket; an unscoped call falls back through post → get → url.
    const buckets = method ? [method] : ['post', 'get', 'url']

    // No key → return the whole bucket (post by default) once available.
    const lookup = () => {
      if (!key) return this.data[method || 'post']
      for (const bucket of buckets) {
        const value = this.data[bucket]?.[key]
        if (value !== undefined && value !== null) return value
      }
      return undefined
    }

    const found = lookup()
    if (found !== undefined && found !== null) return found
    // Body already parsed: nothing more will arrive, resolve with what we have.
    if (this.#complete) return lookup()

    // Wait for the body to finish parsing instead of polling every 10ms.
    return new Promise(resolve => {
      this.#event.end.push({callback: () => resolve(lookup())})
    })
  }

  // - GET FILE
  async file(name) {
    const resolveFiles = () => {
      if (!name) return this.#files
      const arr = this.#files[name]
      if (!arr || arr.length === 0) return null
      return arr.length === 1 ? arr[0] : arr
    }
    if (this.#complete) return resolveFiles()
    return new Promise(resolve => {
      this.#event.end.push({
        callback: () => resolve(resolveFiles())
      })
    })
  }

  setSession() {
    if (!this.cookie('odac_client') || !this.session('_client') || this.session('_client') !== this.cookie('odac_client')) {
      let client = nodeCrypto.randomBytes(16).toString('hex')
      this.cookie('odac_client', client, {expires: null, httpOnly: false})
      this.session('_client', client)
    }
  }

  // - SESSION
  session(key, value) {
    let pri = nodeCrypto
      .createHash('sha256')
      .update(this.req.headers['user-agent'] ?? '.')
      .digest('hex')
    let pub = this.cookie('odac_session')
    if (!pub || !global.Odac.Storage.get(`sess:${pub}:${pri}:_created`)) {
      const lockKey = `lock:${this.ip}:${pri}`
      const now = Date.now()

      const existingLock = global.Odac.Storage.get(lockKey)
      if (existingLock) {
        if (now - existingLock.timestamp < 2000 && global.Odac.Storage.get(`sess:${existingLock.sessionId}:${pri}:_created`)) {
          pub = existingLock.sessionId
        } else {
          global.Odac.Storage.remove(lockKey)
        }
      }

      if (!pub) {
        do {
          pub = nodeCrypto.randomBytes(16).toString('hex')
        } while (global.Odac.Storage.get(`sess:${pub}:${pri}:_created`))
        global.Odac.Storage.put(lockKey, {sessionId: pub, timestamp: now})
        global.Odac.Storage.put(`sess:${pub}:${pri}:_created`, now)
        this.cookie('odac_session', `${pub}`)
        setTimeout(() => {
          const lock = global.Odac.Storage.get(lockKey)
          if (lock?.timestamp === now) {
            global.Odac.Storage.remove(lockKey)
          }
        }, 2000)
      }
    }

    const dbKey = `sess:${pub}:${pri}:${key}`
    if (value === undefined) {
      if (Object.prototype.hasOwnProperty.call(this.#sessions, dbKey)) return this.#sessions[dbKey]
      const dbValue = global.Odac.Storage.get(dbKey) ?? null
      return dbValue
    } else if (value === null) {
      delete this.#sessions[dbKey]
      delete this.#sessions[dbKey]
      global.Odac.Storage.remove(dbKey)
    } else {
      this.#sessions[dbKey] = value
      global.Odac.Storage.put(dbKey, value)
    }
  }

  // - SET
  set(key, value, ajax = false) {
    if (typeof key === 'object') for (const k in key) this.variables[k] = {value: key[k], ajax: ajax}
    else this.variables[key] = {value: value, ajax: ajax}
  }

  // - SHARE DATA (Client Side)
  share(key, value) {
    if (typeof key === 'object' && key !== null) {
      Object.assign(this.sharedData, key)
    } else {
      this.sharedData[key] = value
    }
  }

  // - SET PROXY CACHE
  /**
   * Enables ODAC Proxy caching for the current response.
   * Sets the X-ODAC-Cache header with the specified TTL (in seconds)
   * and updates Cache-Control to allow proxy caching.
   *
   * Why: Allows controllers to declaratively opt-in to proxy-level
   * caching for static or semi-static HTML responses, offloading
   * repeated rendering from the application server.
   *
   * @param {number} seconds - Cache TTL in seconds (must be a positive integer)
   * @throws {TypeError} If seconds is not a positive integer
   */
  cache(seconds) {
    if (!Number.isInteger(seconds) || seconds < 1) {
      throw new TypeError('Odac.cache() requires a positive integer (seconds)')
    }
    this.header('X-ODAC-Cache', seconds)
    this.header('Cache-Control', `public, max-age=${seconds}`)
  }

  // - HTTP CODE
  status(code) {
    this.#status = code
  }

  // - CLEAR TIMEOUT (for long-running connections like SSE)
  clearTimeout() {
    clearTimeout(this.#timeout)
  }

  // - WRITE DATA
  write(data) {
    if (this.res.finished) return
    this.res.write(data)
  }
}

module.exports = OdacRequest
