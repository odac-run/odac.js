const nodeCrypto = require('crypto')
const fs = require('fs')
const fsPromises = fs.promises
const path = require('path')
const os = require('os')
const {isTrustedProxy} = require('./Request/TrustedProxy')

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

/**
 * Parses an application/x-www-form-urlencoded string (query string or form body).
 *
 * Why: a naive split('=') truncated values containing '=' (base64, nested URLs) and left
 * '+' undecoded, so native browser form submissions kept '+' instead of spaces. Pairs
 * without '=' are skipped and the last duplicate wins, matching the historical contract.
 *
 * @param {string} input Raw encoded string without the leading '?'.
 * @param {object} target Object the decoded pairs are written into.
 */
function parseUrlEncoded(input, target) {
  for (const pair of input.split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const key = safeDecode(pair.slice(0, eq).replace(/\+/g, ' '))
    target[key] = safeDecode(pair.slice(eq + 1).replace(/\+/g, ' '))
  }
}

const DEFAULT_SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000
// Last activity is recorded at most this often, so an active session costs one write per
// interval instead of one per request.
const SESSION_TOUCH_INTERVAL = 60 * 60 * 1000

// RFC 6265 cookie-name (an RFC 7230 token).
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// application/json and structured-syntax suffixes such as application/vnd.api+json.
const JSON_CONTENT_TYPE = /^application\/(?:[\w.-]+\+)?json\s*(?:;|$)/i

class OdacRequest {
  #odac
  #complete = false
  #cookies = {data: {}, sent: []}
  data = {post: {}, get: {}, url: {}}
  #files = {}
  #multipartPending = false
  #activeWrites = new Set()
  #cleanedUp = false
  #event = {data: [], end: []}
  #headers = {}
  #status = 200
  #timeout = null
  #earlyHints = null
  #ended = false
  #sessions = {}
  #sessionUaHash = null
  #sessionPrefix = null
  #pendingClient = null
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
    const defaults = global.Odac.Config.headers
    if (defaults) for (const name of Object.keys(defaults)) if (defaults[name]) this.#headers[name] = defaults[name]
    this.method = req.method.toLowerCase()
    this.url = req.url
    // HTTP/1.0 does not require Host, and a socket reset before construction
    // drops remoteAddress; neither may throw on the upgrade path, which runs
    // outside Route.request()'s 500 guard.
    this.host = req.headers.host ?? ''
    // Client address and TLS state are only taken from the proxy headers when the socket peer
    // is a trusted proxy; anyone else could set them to impersonate another client.
    const peer = (req.socket ?? req.connection)?.remoteAddress
    const fromProxy = isTrustedProxy(peer, global.Odac.Config.request?.trustedProxies)
    // Whether the peer is the proxy (or a local client). Only then has the Host header passed
    // through something that routes configured domains; a direct client can send any Host.
    this.fromTrustedProxy = fromProxy
    this.ssl = fromProxy ? this.header('x-odac-connection-ssl') === 'true' : !!(req.socket ?? req.connection)?.encrypted
    this.ip = ((fromProxy && this.header('x-odac-connection-remoteaddress')) || peer || '').replace('::ffff:', '')
    this.language = req.headers['accept-language']?.split(',')[0] ?? 'en'
    delete this.req.headers['x-odac-connection-ssl']
    delete this.req.headers['x-odac-connection-remoteaddress']
    let route = this.host.split('.')[0]
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
    if (!this.res || this.res.finished || this.res.writableEnded) return
    clearTimeout(this.#timeout)
    const fn = () => this.#onTimeout()
    const ms = global.Odac.Config.request.timeout
    this.#timeout = typeof this.#odac.setTimeout === 'function' ? this.#odac.setTimeout(fn, ms) : setTimeout(fn, ms)
  }

  // Once the status line is on the wire a 408 can no longer be sent; writing
  // the error body would append it to the partial response and end it as if
  // it were complete. Destroying the socket makes the client see a truncated
  // transfer instead of a corrupt "successful" one.
  #onTimeout() {
    if (this.res.finished || this.res.writableEnded) return
    if (this.res.headersSent) return this.res.destroy()
    this.abort(408)
  }

  /**
   * Pushes the idle deadline back by the configured request timeout.
   *
   * Why: streamed responses (downloads) never pass through end(), so the
   * timer set at construction would cut any transfer longer than the timeout.
   * Route calls this per streamed chunk; a client that stops reading stalls
   * the stream through backpressure and is dropped after one idle period.
   */
  refreshTimeout() {
    this.#armTimeout()
  }

  // - ABORT REQUEST
  /**
   * Answers the request with an error status, through the app's custom error route if any.
   * Why: abort() is also called where nothing continues the response afterwards (request
   * timeout, oversized or malformed bodies, the 500 fallback), so it always finishes the
   * response itself: a handler that only configured a view (View.set, returns undefined) is
   * rendered here, and a handler that fails falls back to the plain status page. Once headers
   * are on the wire no status can be sent, so the connection is dropped instead.
   */
  async abort(code) {
    // WebSocket upgrades have no HTTP response and no error page to render;
    // ending the request lets the WS route close the socket with this status.
    if (!this.res) {
      this.status(code)
      return this.end()
    }
    if (this.res.writableEnded) return
    if (this.res.headersSent) return this.res.destroy()
    this.status(code)
    let result = {401: 'Unauthorized', 404: 'Not Found', 408: 'Request Timeout'}[code] ?? null
    const errorRoute = this.#odac.Route?.routes?.[this.route]?.error?.[code]
    if (errorRoute && typeof errorRoute.cache === 'function') {
      try {
        const handlerResult = await errorRoute.cache(this.#odac)
        if (handlerResult === undefined) {
          // The handler configured a view (Odac.View.set()) or answered on its own.
          if (!this.res.writableEnded && this.#odac.View) await this.#odac.View.print()
          if (this.res.writableEnded) return
        } else {
          result = handlerResult
        }
      } catch (e) {
        console.error(JSON.stringify({level: 'ERROR', message: `Error in custom error handler for ${code}`, error: e.message}))
      }
    }
    if (this.res.writableEnded) return
    if (this.res.headersSent) return this.res.destroy()
    this.status(code)
    this.end(result)
  }

  /**
   * Reads a request cookie (`value` omitted) or queues a Set-Cookie (`value` given).
   * Why: values are percent-encoded on write and decoded on read, so a value holding `;`,
   * `,` or spaces cannot inject cookie attributes. A `{...}` value is parsed as JSON so object
   * cookies round-trip; the browser controls that type, so code that needs a string (tokens,
   * ids) must check it. `Secure` is on by default except for plain-HTTP requests in debug
   * mode, where browsers such as Safari would drop the cookie on http://localhost.
   */
  cookie(key, value, options = {}) {
    if (value === undefined) {
      if (this.#cookies.data[key]) return this.#cookies.data[key]
      const raw = this.req.headers.cookie?.split(/;\s*/).find(c => c.startsWith(key + '='))
      // Split on the first '=' only so base64 / padded values (which contain '=')
      // survive intact instead of being truncated by a naive split('=')[1].
      value = raw ? safeDecode(raw.slice(raw.indexOf('=') + 1)) : null
      if (value && value.startsWith('{') && value.endsWith('}')) {
        try {
          value = JSON.parse(value)
        } catch {
          // Malformed JSON cookie: keep the raw string instead of throwing a 500.
        }
      }
      return value
    }
    if (!COOKIE_NAME.test(key)) throw new TypeError(`ODAC: invalid cookie name "${key}"`)
    this.#cookies.data[key] = value
    if (options.path === undefined) options.path = '/'
    if (options.expires === undefined) options.expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toUTCString()
    if (options.secure === undefined) options.secure = this.ssl || !global.Odac.Config.debug
    if (options.httpOnly === undefined) options.httpOnly = true
    if (options.sameSite === undefined) options.sameSite = 'Lax'
    if (typeof value === 'object') value = JSON.stringify(value)
    let cookie = `${key}=${encodeURIComponent(value)}`
    for (const option of Object.keys(options)) {
      const setting = options[option]
      if (!setting && setting !== 0) continue
      if (setting === true) cookie += `; ${option}`
      else if (/[;\r\n]/.test(String(setting))) throw new TypeError(`ODAC: invalid cookie option ${option}`)
      else cookie += `; ${option}=${setting}`
    }
    this.#cookies.sent.push(cookie)
  }

  #data() {
    const queryStart = this.url.indexOf('?')
    if (queryStart !== -1) parseUrlEncoded(this.url.slice(queryStart + 1), this.data.get)

    const contentType = this.req.headers['content-type'] || ''
    if (contentType.startsWith('multipart/form-data')) {
      // Parsed on first request()/file() call, so a multipart body sent to a URL with no
      // route, or to a handler that never reads it, is never written to disk.
      this.#multipartPending = true
      return
    }

    // Non-multipart: urlencoded or JSON (buffered path). Chunks stay raw until 'end' so a
    // multi-byte UTF-8 character split across two chunks is decoded intact, and the size
    // limit counts bytes rather than UTF-16 code units.
    const chunks = []
    let received = 0
    this.req.on('data', chunk => {
      chunks.push(chunk)
      received += chunk.length
      const maxBodySize = global.Odac.Config.request.maxBodySize
      if (received > maxBodySize) {
        chunks.length = 0
        this.status(413)
        this.end()
        this.req.removeAllListeners('data')
        this.req.resume()
        this.#finish()
        return
      }

      for (const event of this.#event.data) {
        event.callback(event.active ? chunk : Buffer.concat(chunks))
        event.active = true
      }
    })

    this.req.on('end', () => {
      if (this.#complete) return
      if (received === 0) return this.#finish()
      const body = Buffer.concat(chunks, received).toString('utf8')
      chunks.length = 0
      // The body's own shape is not trusted to pick the parser: only a declared JSON media
      // type is parsed as JSON, so a text/plain form cannot smuggle a JSON payload in.
      if (JSON_CONTENT_TYPE.test(contentType)) {
        try {
          const parsed = JSON.parse(body)
          if (parsed !== null && typeof parsed === 'object') this.data.post = parsed
        } catch {
          // Invalid JSON leaves post empty, the same as an absent body.
        }
      } else {
        parseUrlEncoded(body, this.data.post)
      }
      this.#finish()
    })
  }

  /**
   * Marks the body as fully parsed and releases every request()/file() waiter.
   *
   * Why: Route.check() awaits the body for every POST/PUT/PATCH/DELETE. Any
   * completion path that flips #complete without draining the queue (empty
   * body, 413, upload-dir failure) leaves those promises pending forever and
   * the request dies at the idle timeout. Idempotent so racing paths (busboy
   * error vs. close) cannot fire callbacks twice.
   */
  #finish() {
    if (this.#complete) return
    this.#complete = true
    const waiters = this.#event.end
    this.#event.end = []
    for (const event of waiters) event.callback()
  }

  #startBody() {
    if (!this.#multipartPending) return
    this.#multipartPending = false
    this.#multipart()
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
      this.#finish()
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
      if (!bbClosed || this.#activeWrites.size > 0) return
      this.#finish()
    }

    // maxBodySize bounds all text fields together, as it bounds a urlencoded body. Per-field
    // limits alone let 200 fields of maxBodySize each hold 200 MB in memory.
    let fieldBytes = 0
    const tooLarge = () => {
      if (this.#complete) return
      this.#finish()
      this.req.unpipe(bb)
      this.req.resume()
      this.abort(413)
    }

    bb.on('field', (name, val, info) => {
      if (this.#complete) return
      fieldBytes += Buffer.byteLength(name) + Buffer.byteLength(val)
      if (info?.valueTruncated || fieldBytes > cfg.maxBodySize) return tooLarge()
      this.data.post[name] = val
    })
    bb.on('fieldsLimit', tooLarge)

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
      this.#finish()
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
    if (!this.res) {
      this.#ended = true
      return
    }
    if (this.res.finished) return
    // Binary bodies go out as-is. Anything else that is an object is serialized exactly once:
    // detecting Buffers by a `type` field stringified and re-parsed every Buffer (a 2 MB file
    // blocked the loop for ~90 ms) and sent API objects with `type: 'Buffer'` unserialized.
    // Numbers and booleans are JSON values too; res.end() only accepts strings and bytes.
    if (typeof data === 'number' || typeof data === 'boolean') {
      data = JSON.stringify(data)
      if (!this.#hasHeader('Content-Type')) this.header('Content-Type', 'application/json')
    } else if (typeof data === 'object' && data !== null && !Buffer.isBuffer(data) && !ArrayBuffer.isView(data)) {
      data = JSON.stringify(data)
      if (!this.#hasHeader('Content-Type')) this.header('Content-Type', 'application/json')
    }
    // A body without Content-Type is MIME-sniffed by desktop browsers, but
    // Android Chrome / iOS Safari hand it to the download manager instead of
    // rendering it. Plain string responses (magic-link verify errors, abort()
    // pages, controllers returning text) therefore downloaded as a file on
    // mobile. Buffers are left alone: there is nothing to guess from.
    if (typeof data === 'string' && data.length > 0 && !this.#hasHeader('Content-Type')) {
      this.header('Content-Type', 'text/html; charset=utf-8')
    }
    clearTimeout(this.#timeout)
    this.print()
    this.res.end(data)
    this.#cleanupFiles()
    // Do not destroy the socket here: it defeats keep-alive (Server.js sets
    // keepAliveTimeout=65000) and forces a fresh TCP handshake per request.
    // res.end() finishes the response; idle sockets are reaped by keepAliveTimeout.
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

  // Response headers are set with mixed casing across the framework and by apps, so lookups
  // must be case-insensitive to avoid emitting the same header twice.
  #headerName(key) {
    const lower = key.toLowerCase()
    for (const name of Object.keys(this.#headers)) if (name.toLowerCase() === lower) return name
    return undefined
  }

  #hasHeader(key) {
    return this.#headerName(key) !== undefined
  }

  /**
   * Reads a request header, or sets/removes a response header.
   *
   * Why: one accessor for both directions. Writes replace an existing header regardless of
   * its casing, so overriding a default such as `x-frame-options` never sends two values.
   *
   * @param {string} key Header name.
   * @param {*} [value] New value; null removes the header; omitted reads the request header.
   */
  /**
   * Reads a request header (`value` omitted) or sets/removes (`null`) a response header.
   * Why: Node lower-cases incoming header names, so a read is one property lookup instead of
   * a scan over every header; writes replace any differently-cased duplicate.
   */
  header(key, value) {
    if (value === undefined) return this.req.headers[key.toLowerCase()]
    const existing = this.#headerName(key)
    if (existing !== undefined) delete this.#headers[existing]
    if (value !== null) this.#headers[key] = value
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
    this.#startBody()
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
    this.#startBody()
    if (this.#complete) return resolveFiles()
    return new Promise(resolve => {
      this.#event.end.push({
        callback: () => resolve(resolveFiles())
      })
    })
  }

  /**
   * Issues the per-browser client id (`odac_client` cookie) that forms and token requests
   * are bound to.
   * Why: the id is stored in the session only once the session exists. A visitor that never
   * writes session data (bots, health checks, plain page views) gets the cookie but no
   * session record; the first write persists the id issued in this request.
   */
  setSession() {
    const cookieClient = this.cookie('odac_client')
    if (this.#resolveSession(false)) {
      const client = this.session('_client')
      if (cookieClient && client === cookieClient) return
    } else if (this.#pendingClient && this.#pendingClient === cookieClient) {
      return
    }
    const client = nodeCrypto.randomBytes(16).toString('hex')
    this.cookie('odac_client', client, {expires: null, httpOnly: false})
    if (this.#sessionPrefix) this.session('_client', client)
    else this.#pendingClient = client
  }

  // The User-Agent cannot change within a request; hash it once. Version numbers are left
  // out, so a browser update keeps the session while another browser or platform does not.
  #uaHash() {
    return (this.#sessionUaHash ??= nodeCrypto
      .createHash('sha256')
      .update((this.req.headers['user-agent'] ?? '.').replace(/\d+(?:[._]\d+)*/g, ''))
      .digest('hex'))
  }

  // Sessions created before version-free hashing are keyed by the full User-Agent.
  #legacyUaHash() {
    return nodeCrypto
      .createHash('sha256')
      .update(this.req.headers['user-agent'] ?? '.')
      .digest('hex')
  }

  #lifetime() {
    return global.Odac.Storage.sessionLifetime ?? DEFAULT_SESSION_LIFETIME
  }

  #sessionCookie(pub) {
    this.cookie('odac_session', pub, {expires: new Date(Date.now() + this.#lifetime()).toUTCString()})
  }

  /**
   * Finds this request's session, optionally creating one.
   * Why: reads never create a session, so a request that only checks for session data
   * leaves nothing behind in storage. Last activity is refreshed for the sliding expiry.
   * @param {boolean} create Whether to start a session when there is none.
   * @returns {string|null} The session's storage key prefix.
   */
  #resolveSession(create) {
    if (this.#sessionPrefix) return this.#sessionPrefix
    const Storage = global.Odac.Storage
    const pub = this.cookie('odac_session')
    if (typeof pub === 'string' && pub) {
      const prefix = `sess:${pub}:${this.#uaHash()}:`
      if (Storage.get(`${prefix}_created`)) return this.#openSession(pub, prefix)
      const legacy = `sess:${pub}:${this.#legacyUaHash()}:`
      if (legacy !== prefix && Storage.get(`${legacy}_created`)) {
        this.#moveSession(legacy, prefix)
        return this.#openSession(pub, prefix)
      }
    }
    if (!create) return null

    // Every cookieless request gets its own session. Reusing a recent session by IP and
    // User-Agent merged unrelated visitors behind the same NAT into one session.
    const fresh = this.#newSessionId(this.#uaHash())
    const prefix = `sess:${fresh}:${this.#uaHash()}:`
    Storage.put(`${prefix}_created`, Date.now())
    this.#sessionPrefix = prefix
    this.#sessionCookie(fresh)
    if (this.#pendingClient) {
      Storage.put(`${prefix}_client`, this.#pendingClient)
      this.#sessions[`${prefix}_client`] = this.#pendingClient
      this.#pendingClient = null
    }
    return prefix
  }

  #openSession(pub, prefix) {
    this.#sessionPrefix = prefix
    const Storage = global.Odac.Storage
    const now = Date.now()
    const last = Storage.get(`${prefix}_active`) ?? Storage.get(`${prefix}_created`)
    if (!(now - last < SESSION_TOUCH_INTERVAL)) {
      Storage.put(`${prefix}_active`, now)
      this.#sessionCookie(pub)
    }
    return prefix
  }

  #moveSession(fromPrefix, toPrefix) {
    const Storage = global.Odac.Storage
    for (const [key, value] of Storage.entries(fromPrefix)) {
      Storage.put(toPrefix + key.slice(fromPrefix.length), value)
      Storage.remove(key)
    }
    const cached = this.#sessions
    this.#sessions = {}
    for (const key of Object.keys(cached)) {
      this.#sessions[key.startsWith(fromPrefix) ? toPrefix + key.slice(fromPrefix.length) : key] = cached[key]
    }
  }

  #newSessionId(pri) {
    let pub
    do {
      pub = nodeCrypto.randomBytes(16).toString('hex')
    } while (global.Odac.Storage.get(`sess:${pub}:${pri}:_created`))
    return pub
  }

  /**
   * Moves the current session's data to a new session identifier.
   * Why: an identifier the visitor held before signing in, possibly planted by an attacker
   * (session fixation), must not turn into an authenticated session. Auth.login() calls it;
   * the data carries over and the old identifier stops resolving.
   */
  regenerateSession() {
    const pri = this.#uaHash()
    const oldPrefix = this.#resolveSession(false)
    const pub = this.#newSessionId(pri)
    const prefix = `sess:${pub}:${pri}:`

    if (oldPrefix) this.#moveSession(oldPrefix, prefix)
    global.Odac.Storage.put(`${prefix}_created`, Date.now())
    global.Odac.Storage.put(`${prefix}_active`, Date.now())
    this.#sessionPrefix = prefix
    this.#sessionCookie(pub)
    if (this.#pendingClient) {
      global.Odac.Storage.put(`${prefix}_client`, this.#pendingClient)
      this.#sessions[`${prefix}_client`] = this.#pendingClient
      this.#pendingClient = null
    }
  }

  // - SESSION
  /**
   * Reads (`value` omitted), writes or removes (`value` null) a session value.
   * Why: only a write creates a session; reading from a visitor without one returns null.
   */
  session(key, value) {
    const prefix = this.#resolveSession(value !== undefined && value !== null)
    if (!prefix) return key === '_client' && value === undefined ? this.#pendingClient : null

    const dbKey = prefix + key
    if (value === undefined) {
      if (Object.prototype.hasOwnProperty.call(this.#sessions, dbKey)) return this.#sessions[dbKey]
      return global.Odac.Storage.get(dbKey) ?? null
    } else if (value === null) {
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

  /**
   * Whether a response has been produced for this request.
   *
   * Why: middleware shared between HTTP and WebSocket routes signals rejection
   * by ending the request (abort, redirect, return). A WebSocket request has no
   * HTTP response to inspect, so callers read this instead of res.finished.
   * @returns {boolean}
   */
  get ended() {
    if (!this.res) return this.#ended
    return Boolean(this.res.finished || this.res.writableEnded)
  }

  /**
   * The status code set so far via status()/abort()/redirect().
   *
   * Why: the WebSocket route maps an aborted request's HTTP status to a close code.
   * @returns {number}
   */
  get statusCode() {
    return this.#status
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
