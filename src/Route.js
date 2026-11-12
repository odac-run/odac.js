const nodeCrypto = require('crypto')
const fs = require('fs')
const fsPromises = fs.promises
const path = require('path')
const {pipeline} = require('stream')

const Hook = require('./Hook.js')
const Cron = require('./Route/Cron.js')
const Internal = require('./Route/Internal.js')
const Image = require('./View/Image.js')
const MiddlewareChain = require('./Route/Middleware.js')
const RateLimit = require('./Route/RateLimit.js')
const {WebSocketServer} = require('./WebSocket.js')

let routes2 = {}
const StaticFile = require('./Route/StaticFile.js')

/**
 * Percent-decodes one URL segment for a route parameter (`/user/John%20Doe` → `John Doe`).
 * Why: matching runs on the raw path so an encoded `/` (`%2F`) never splits a segment; the
 * value handed to the controller is decoded once. Malformed escapes are kept as sent.
 */
function decodeParam(segment) {
  if (!segment.includes('%')) return segment
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

// HTTP status set by abort()/redirect() on a WebSocket request → close frame.
const WS_REJECT = {401: [4001, 'Unauthorized'], 403: [4003, 'Forbidden']}

/**
 * Closes a WebSocket whose request was ended by middleware or the handler.
 * Why: abort(401)/abort(403) keep the same close codes the built-in auth and
 * `false` middleware paths use; any other ending (redirect, custom status)
 * is a generic rejection.
 */
function closeRejected(ws, status) {
  const [code, reason] = WS_REJECT[status] ?? [4000, 'Request rejected']
  ws.close(code, reason)
}

class Route {
  loading = false
  routes = {}
  middlewares = {}
  _pendingMiddlewares = []
  _pendingRouteLoads = []
  #wsServer = new WebSocketServer()
  #configCache = {}
  #paramIndex = {}
  #paramIndexDirty = false
  auth = {
    page: (path, authFile, file) => this.authPage(path, authFile, file),
    post: (path, authFile, file, options) => this.authPost(path, authFile, file, options),
    get: (path, authFile, file, options) => this.authGet(path, authFile, file, options),
    ws: (path, handler, options) => this.authWs(path, handler, options),
    use: (...middlewares) => new MiddlewareChain(this, [...middlewares.flat()], true)
  }

  async #runMiddlewares(Odac, middlewares) {
    if (!middlewares || middlewares.length === 0) return

    for (const mw of middlewares) {
      const middleware = typeof mw === 'function' ? mw : this.middlewares[mw]?.handler

      if (!middleware) {
        console.error(`Middleware not found: ${mw}`)
        await Odac.Request.abort(500)
        // Return false (not abort's undefined) so #executeController's guard
        // stops the chain and the controller never runs after the 500.
        return false
      }

      const result = await middleware(Odac)

      if (Odac.Request.res.finished) {
        return false
      }

      if (result === false) {
        await Odac.Request.abort(403)
        return false
      }

      if (result !== undefined && result !== true) {
        return result
      }
    }
  }

  async #executeController(Odac, controller) {
    if (controller.params) {
      for (let key in controller.params) {
        Odac.Request.data.url[key] = controller.params[key]
      }
    }

    const middlewareResult = await this.#runMiddlewares(Odac, controller.middlewares)
    if (middlewareResult !== undefined) return middlewareResult

    if (controller.action) {
      const ControllerModule = controller.cache
      const actionParts = controller.action.split('.')

      // Resolve the action starting from a given root (instance or the module).
      const resolve = root => {
        let method = root
        let context = root
        for (const segment of actionParts) {
          if (method) {
            context = method
            method = method[segment]
          }
        }
        return {method, context}
      }

      // Only instantiation may legitimately fail (e.g. the controller is a plain
      // object of static handlers, not a constructor). Keep the action call
      // itself OUTSIDE the try so a synchronous error inside the action is not
      // swallowed and does not trigger a second, static invocation.
      let instance = null
      try {
        instance = new ControllerModule(Odac)
      } catch {
        instance = null
      }

      let {method, context} = instance ? resolve(instance) : {method: undefined, context: undefined}
      // Fall back to a static method on the module when there is no instance
      // method (non-constructor controller, or a statically-defined action).
      if (typeof method !== 'function') ({method, context} = resolve(ControllerModule))

      if (typeof method === 'function') {
        return method.call(context, Odac)
      }
      return Odac.Request.abort(500)
    }

    if (typeof controller.cache === 'function') {
      return controller.cache(Odac)
    }
  }

  async check(Odac) {
    let url = Odac.Request.url.split('?')[0]
    if (url.endsWith('/')) url = url.slice(0, -1)
    // Auth is loaded lazily at the points where user code can actually run
    // (form processing, controller dispatch, custom 404 handlers) so that
    // asset requests — config-route files, public files, plain 404s — never
    // trigger a token-table query. Auth.check() memoizes a successful check on
    // the request instance, so user code still sees Odac.Auth.user() loaded
    // without a manual await, at most one token query per request.

    if (url.startsWith('/_odac/')) {
      Odac.Request.route = '_odac_internal'
    }

    // The body is read only when a route will handle the request: an upload to an unknown URL
    // is answered without being parsed or written to disk.
    if (
      ['post', 'put', 'patch', 'delete'].includes(Odac.Request.method) &&
      this.#hasHandler(Odac.Request.route, Odac.Request.method, url)
    ) {
      const formToken = await Odac.request('_odac_form_token')
      if (formToken) {
        // Form set-callbacks (Odac.fn) are user code and may read Odac.Auth.user().
        if (Odac.Auth) await Odac.Auth.check()
        Odac.Request.setSession()
        await Internal.processForm(Odac)
      }
    }
    if (
      Odac.Request.url === '/' &&
      Odac.Request.method === 'get' &&
      Odac.Request.header('X-Odac') === 'token' &&
      (Odac.Request.header('Referer') ?? '').startsWith((Odac.Request.ssl ? 'https://' : 'http://') + Odac.Request.host + '/') &&
      Odac.Request.header('X-Odac-Client') === Odac.Request.cookie('odac_client')
    ) {
      Odac.Request.header('Access-Control-Allow-Origin', (Odac.Request.ssl ? 'https://' : 'http://') + Odac.Request.host)
      Odac.Request.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
      return {
        token: Odac.token()
      }
    }

    // Handle AJAX page load requests
    if (Odac.Request.method === 'get' && Odac.Request.header('X-Odac') === 'ajaxload') {
      let loadElements = Odac.Request.header('X-Odac-Load')
      if (loadElements) {
        Odac.Request.ajaxLoad = loadElements.split(',')
      }
      Odac.Request.isAjaxLoad = true
      Odac.Request.clientSkeleton = Odac.Request.header('X-Odac-Skeleton')

      // Parse client's current part values for smart diffing
      const partsHeader = Odac.Request.header('X-Odac-Parts')
      if (partsHeader) {
        // Client-supplied names: a null-prototype object keeps `__proto__` an ordinary key, and
        // a malformed escape is ignored for that entry instead of failing the request.
        const parts = Object.create(null)
        for (const entry of partsHeader.split(',')) {
          const idx = entry.indexOf('=')
          if (idx <= 0) continue
          try {
            parts[entry.substring(0, idx)] = decodeURIComponent(entry.substring(idx + 1))
          } catch {
            // Unchanged-part hints are an optimization; a bad entry just re-renders that part.
          }
        }
        Odac.Request.clientParts = parts
      }
    }
    if (Odac.Config?.route?.[url]) {
      // PROD CACHE HIT
      const cached = !Odac.Config.debug && this.#configCache[url]
      if (cached) return this.#asset(Odac, cached, range => this.#slice(cached.content, range))

      const filePath = Odac.Config.route[url]
      try {
        // One descriptor for stat and read, so the validators describe the bytes served.
        const handle = await fsPromises.open(filePath, 'r')
        let meta
        let content
        try {
          const stat = await handle.stat()
          if (stat.isFile()) {
            meta = {type: StaticFile.contentType(filePath), size: stat.size, etag: StaticFile.etag(stat), mtimeMs: stat.mtimeMs}
            // HEAD needs only the size. The prod cache holds file content, so it is
            // left for the next GET to fill.
            if (Odac.Request.method !== 'head') content = await handle.readFile()
          }
        } finally {
          await handle.close()
        }
        if (meta && !content) return this.#asset(Odac, meta)
        if (meta) {
          meta.size = content.length
          // PROD CACHE SET
          if (!Odac.Config.debug) this.#configCache[url] = {...meta, content}
          return this.#asset(Odac, meta, range => this.#slice(content, range))
        }
      } catch {
        // File not found or error, continue routing
      }
    }
    // HEAD is GET without a body (RFC 9110 §9.3.2): it resolves GET routes and
    // passes through the same auth and CSRF gates. Request.method stays 'head'
    // so user code can still tell the two apart; Node drops the body itself.
    const routeMethod = Odac.Request.method === 'head' ? 'get' : Odac.Request.method
    for (let method of ['#' + routeMethod, routeMethod]) {
      let controller = this.#controller(Odac.Request.route, method, url)
      if (controller) {
        if (!method.startsWith('#') || (await Odac.Auth.check())) {
          // Load the user before dispatch so controllers can call
          // Odac.Auth.user() synchronously (memoized: no-op for # routes
          // whose auth gate above already succeeded).
          if (Odac.Auth) await Odac.Auth.check()
          // After the auth gate (so a custom key can use Odac.Auth.user()), before the session
          // and CSRF work a flood would otherwise still pay for.
          if (controller.rateLimit && !(await RateLimit.consume(Odac, controller.rateLimit))) return
          Odac.Request.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
          Odac.Request.setSession()
          const page = controller.cache?.file || controller.file
          if (typeof page === 'string') Odac.Request.page = page

          // Keyed on the route's own flag, never on a verb allowlist: any verb
          // missing from such a list (HEAD, OPTIONS, ...) would skip the check.
          if (controller.token && (!(await Odac.request('_token')) || !Odac.token(await Odac.Request.request('_token'))))
            return Odac.Request.abort(401)

          return await this.#executeController(Odac, controller)
        }
      }
    }
    let authPageController = this.#controller(Odac.Request.route, '#page', url)
    if (authPageController && (await Odac.Auth.check())) {
      Odac.Request.setSession()
      const page = authPageController.cache?.file || authPageController.file
      if (typeof page === 'string') Odac.Request.page = page
      return await this.#executeController(Odac, authPageController)
    }
    let pageController = this.#controller(Odac.Request.route, 'page', url)
    if (pageController) {
      // Same DX contract as method controllers: user loaded before dispatch.
      if (Odac.Auth) await Odac.Auth.check()
      Odac.Request.setSession()
      const page = pageController.cache?.file || pageController.file
      if (typeof page === 'string') Odac.Request.page = page
      return await this.#executeController(Odac, pageController)
    }

    let decodedUrl
    try {
      decodedUrl = decodeURIComponent(url)
    } catch {
      decodedUrl = null // Invalid URI encoding
    }

    if (decodedUrl && !decodedUrl.includes('\0')) {
      const publicDir = path.normalize(`${__dir}/public`)
      const safeUrl = decodedUrl.replace(/^[/\\]+/, '')
      const publicPath = path.normalize(path.join(publicDir, safeUrl))
      const relativePath = path.relative(publicDir, publicPath)

      if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath) && !StaticFile.isHidden(relativePath)) {
        // The response is built from the opened descriptor: its fstat gives the size and
        // validators of exactly the bytes streamed, even if the file is replaced meanwhile.
        let handle = null
        try {
          handle = await fsPromises.open(publicPath, 'r')
          const stat = await handle.stat()
          if (stat.isFile()) {
            const file = handle
            handle = null
            const meta = {type: StaticFile.contentType(publicPath), size: stat.size, etag: StaticFile.etag(stat), mtimeMs: stat.mtimeMs}
            // autoClose (the default) releases the descriptor when the stream ends or is destroyed.
            return this.#asset(
              Odac,
              meta,
              range => file.createReadStream(range ?? {}),
              () => file.close().catch(() => {})
            )
          }
        } catch {
          // File not found in public
        } finally {
          handle?.close().catch(() => {})
        }
      }
    }

    // Custom 404 handlers (run inside Request.abort) are user code — load the
    // user first so they can call Odac.Auth.user(). Skipped when no handler
    // exists so plain asset 404s never touch the token table.
    if (Odac.Auth && this.routes[Odac.Request.route]?.error?.[404]) await Odac.Auth.check()
    return Odac.Request.abort(404)
  }

  /**
   * Shared response for config-route and public files.
   *
   * Why: one place applies the validators (ETag/Last-Modified → 304), byte ranges (206/416)
   * and the cache policy. HEAD, 304 and 416 never produce the body, so no stream is opened
   * just for Node to discard it; `release` frees whatever `body` would have consumed.
   *
   * @param {object} Odac Request-scoped instance.
   * @param {{type: string, size: number, etag: string, mtimeMs: number}} meta
   * @param {(range: {start: number, end: number}|null) => *} [body] Produces the response body.
   * @param {() => void} [release] Called when the body is not produced.
   */
  #asset(Odac, meta, body, release = () => {}) {
    const request = Odac.Request
    const lastModified = new Date(meta.mtimeMs).toUTCString()
    const readHeader = name => request.header(name)
    request.header('Cache-Control', StaticFile.cacheControl(request.url))
    request.header('ETag', meta.etag)
    request.header('Last-Modified', lastModified)
    request.header('Accept-Ranges', 'bytes')

    if (StaticFile.isFresh(readHeader, meta.etag, meta.mtimeMs)) {
      release()
      request.status(304)
      return request.end()
    }

    // If-Range carries a date here: weak ETags never satisfy it (RFC 9110 §13.1.5).
    const ifRange = readHeader('if-range')
    const range = !ifRange || ifRange === lastModified ? StaticFile.parseRange(readHeader('range'), meta.size) : null
    if (range === false) {
      release()
      request.header('Content-Range', `bytes */${meta.size}`)
      request.status(416)
      return request.end()
    }

    request.header('Content-Type', meta.type)
    if (range) {
      request.status(206)
      request.header('Content-Range', `bytes ${range.start}-${range.end}/${meta.size}`)
    }
    request.header('Content-Length', range ? range.end - range.start + 1 : meta.size)
    if (request.method === 'head' || !body) {
      release()
      return request.end()
    }
    return body(range)
  }

  #slice(content, range) {
    return range ? content.subarray(range.start, range.end + 1) : content
  }

  /**
   * Resolves a URL to its matching route controller using a two-phase strategy:
   * Phase 1 — O(1) exact hash-map match for static routes.
   * Phase 2 — Pre-indexed parametric match grouped by segment count to avoid full iteration.
   */
  #hasHandler(route, method, url) {
    for (const type of ['#' + method, method, '#page', 'page']) if (this.#controller(route, type, url)) return true
    return false
  }

  #controller(route, method, url) {
    const methodRoutes = this.routes[route]?.[method]
    if (!methodRoutes) return false

    // Phase 1: O(1) exact match
    if (methodRoutes[url]) return methodRoutes[url]

    // Phase 2: Parametric match via pre-built index (lazy rebuild on dirty)
    if (this.#paramIndexDirty) {
      this.#buildParamIndex()
      this.#paramIndexDirty = false
    }
    const methodIndex = this.#paramIndex[route]?.[method]
    if (!methodIndex) return false

    const urlSegments = url.split('/')
    const candidates = methodIndex.get(urlSegments.length)
    if (!candidates) return false

    candidateLoop: for (const {paramMap, staticChecks, routeObj} of candidates) {
      for (const {index, value} of staticChecks) {
        if (urlSegments[index] !== value) continue candidateLoop
      }

      const params = {}
      for (const {index, name} of paramMap) {
        params[name] = decodeParam(urlSegments[index])
      }

      return {
        action: routeObj.action,
        cache: routeObj.cache,
        file: routeObj.file,
        middlewares: routeObj.middlewares,
        params,
        token: routeObj.token
      }
    }

    return false
  }

  /**
   * Builds a segment-count-grouped index of parametric routes for O(1) lookup by segment count.
   * Eliminates per-request string parsing by pre-computing segment metadata at init time.
   * Called after every route initialization cycle (startup + hot-reload).
   */
  #buildParamIndex() {
    const index = {}
    for (const route in this.routes) {
      index[route] = {}
      for (const method in this.routes[route]) {
        const methodMap = new Map()
        for (const key in this.routes[route][method]) {
          if (!key.includes('{')) continue
          const routeObj = this.routes[route][method][key]
          if (!routeObj) continue

          const segments = key.split('/')
          const paramMap = []
          const staticChecks = []
          for (let i = 0; i < segments.length; i++) {
            if (segments[i].startsWith('{') && segments[i].endsWith('}')) {
              paramMap.push({index: i, name: segments[i].slice(1, -1)})
            } else {
              staticChecks.push({index: i, value: segments[i]})
            }
          }

          const count = segments.length
          let bucket = methodMap.get(count)
          if (!bucket) {
            bucket = []
            methodMap.set(count, bucket)
          }
          bucket.push({key, paramMap, routeObj, staticChecks})
        }
        if (methodMap.size > 0) {
          index[route][method] = methodMap
        }
      }
    }
    this.#paramIndex = index
  }

  async #loadMiddlewares() {
    const middlewareDir = `${__dir}/middleware/`
    try {
      await fsPromises.access(middlewareDir)
    } catch {
      return
    }

    const files = await fsPromises.readdir(middlewareDir)
    for (const file of files) {
      if (!file.endsWith('.js')) continue
      const name = file.replace('.js', '')
      const path = `${middlewareDir}${file}`
      const stat = await fsPromises.stat(path)
      const mtime = stat.mtimeMs

      if (this.middlewares[name] && this.middlewares[name].mtime >= mtime - 1000) continue

      delete require.cache[require.resolve(path)]
      try {
        this.middlewares[name] = {path, mtime, handler: require(path)}
      } catch (err) {
        // A file saved mid-edit must not stop hot reload; the previous handler stays until
        // the file loads again (mtime is recorded so the same broken save is not retried).
        if (this.middlewares[name]) this.middlewares[name].mtime = mtime
        console.error(`\x1b[31m[Odac]\x1b[0m Failed to load middleware: \x1b[33m${path}\x1b[0m`)
        console.error(`\x1b[31m[Odac]\x1b[0m ${err.message}`)
      }
    }
  }

  /**
   * Loads middleware, hook, class and route files, reloading those that changed.
   * Why: runs at startup and every 5 s in debug mode; any failure is logged and `loading` is
   * always released, so one broken save can never stop hot reload for the rest of the run.
   */
  async #init() {
    if (this.loading) return
    this.loading = true
    try {
      await this.#loadAll()
    } catch (e) {
      console.error(e)
    } finally {
      delete Odac.Route.buff
      this._pendingRouteLoads = []
      this.loading = false
    }
  }

  async #loadAll() {
    await this.#loadMiddlewares()
    await Hook.load()
    const classDir = `${__dir}/class/`
    try {
      await fsPromises.access(classDir)
      const files = await fsPromises.readdir(classDir)
      for (const file of files) {
        if (!file.endsWith('.js')) continue
        let name = file.replace('.js', '')
        if (!Odac.Route.class) Odac.Route.class = {}
        const filePath = `${__dir}/class/${file}`

        let shouldLoad = true
        let stat = null

        if (Odac.Route.class[name]) {
          stat = await fsPromises.stat(Odac.Route.class[name].path)
          if (Odac.Route.class[name].mtime >= stat.mtimeMs || Date.now() < stat.mtimeMs + 1000) {
            shouldLoad = false
          } else {
            delete require.cache[require.resolve(Odac.Route.class[name].path)]
          }
        } else {
          stat = await fsPromises.stat(filePath)
        }

        if (shouldLoad) {
          Odac.Route.class[name] = {
            path: filePath,
            mtime: stat.mtimeMs,
            module: require(filePath)
          }
        }
      }
    } catch {
      // Class dir might not exist
    }

    let dir
    try {
      dir = await fsPromises.readdir(`${__dir}/route/`)
    } catch (e) {
      if (e.code === 'ENOENT') console.error(`[ODAC] Route directory not found: \x1b[33m${__dir}/route/\x1b[0m`)
      else console.error(e)
      dir = []
    }

    for (const file of dir) {
      if (!file.endsWith('.js')) continue
      await this.#loadRouteFile(file)
      await this.#reloadChangedControllers(file.replace('.js', ''))
    }

    Cron.init()
    this.#buildParamIndex()
  }

  /**
   * Loads one route file when it is new or changed, then drops the routes it no longer
   * defines. If the file throws, its previous routes are kept so a half-saved edit does not
   * take the site down; the next save reloads it.
   */
  async #loadRouteFile(file) {
    const filePath = `${__dir}/route/${file}`
    const name = file.replace('.js', '')
    const stat = await fsPromises.stat(filePath)
    const mtime = stat.mtimeMs
    if (routes2[name] && routes2[name] >= mtime - 1000) return

    Odac.Route.buff = name
    delete require.cache[require.resolve(filePath)]
    Cron.clear(name)
    routes2[name] = mtime
    const previousWs = this.#wsServer.unrouteSite(name)

    try {
      const routeModule = require(filePath)
      // routeModule calls .set(), which pushes promises to _pendingRouteLoads
      if (typeof routeModule === 'function') routeModule(Odac)
    } catch (err) {
      this.#wsServer.restoreRoutes(previousWs)
      console.error(`\x1b[31m[Odac]\x1b[0m Failed to load route file: \x1b[33m${filePath}\x1b[0m`)
      console.error(err)
      await Promise.allSettled(this._pendingRouteLoads)
      this._pendingRouteLoads = []
      delete Odac.Route.buff
      return
    }

    // Wait for all route sets to complete for this file
    await Promise.all(this._pendingRouteLoads)
    this._pendingRouteLoads = []
    delete Odac.Route.buff

    // Drop routes of every type (page, post, put, error, ...) the file no longer defines.
    const site = this.routes[name]
    if (!site) return
    for (const type of Object.keys(site)) {
      for (const url of Object.keys(site[type])) {
        const routeObj = site[type][url]
        if (!routeObj) continue

        if (routes2[name] > routeObj.loaded) {
          if (routeObj.type === 'controller' && routeObj.path) {
            try {
              delete require.cache[require.resolve(routeObj.path)]
            } catch {
              // Controller file already gone
            }
          }
          delete site[type][url]
        }
      }
    }
  }

  // Controllers edited without touching the route file are reloaded in place.
  async #reloadChangedControllers(name) {
    const site = this.routes[name]
    if (!site) return
    for (const type of Object.keys(site)) {
      for (const routeObj of Object.values(site[type])) {
        if (routeObj?.type !== 'controller' || !routeObj.path) continue
        try {
          const cStat = await fsPromises.stat(routeObj.path)
          if (routeObj.mtime >= cStat.mtimeMs) continue
          delete require.cache[require.resolve(routeObj.path)]
          routeObj.cache = require(routeObj.path)
          routeObj.mtime = cStat.mtimeMs
        } catch (err) {
          if (err.code !== 'ENOENT')
            console.error(`\x1b[31m[Odac]\x1b[0m Failed to reload controller: \x1b[33m${routeObj.path}\x1b[0m`, err.message)
        }
      }
    }
  }

  async init() {
    await this.#init()
    this.#registerInternalRoutes()

    // Hot Reload only in Debug Mode
    if (Odac.Config.debug) {
      setInterval(async () => {
        await this.#init()
      }, 5000)
    }
  }

  #registerInternalRoutes() {
    if (!Odac.Route) Odac.Route = {}
    Odac.Route.buff = '_odac_internal'

    this.set(
      'POST',
      '/_odac/register',
      async Odac => {
        const csrfToken = await Odac.request('_token')
        if (!csrfToken || !Odac.token(csrfToken)) {
          return Odac.Request.abort(401)
        }
        return await Internal.register(Odac)
      },
      {token: true}
    )

    this.set(
      'POST',
      '/_odac/login',
      async Odac => {
        const csrfToken = await Odac.request('_token')
        if (!csrfToken || !Odac.token(csrfToken)) {
          return Odac.Request.abort(401)
        }
        return await Internal.login(Odac)
      },
      {token: true}
    )

    this.set(
      'POST',
      '/_odac/form',
      async Odac => {
        const csrfToken = await Odac.request('_token')
        if (!csrfToken || !Odac.token(csrfToken)) {
          return Odac.Request.abort(401)
        }
        const result = await Internal.customForm(Odac)
        if (result !== null) return result

        return Odac.return({
          result: {
            success: false,
            message: 'No handler defined for this form'
          },
          errors: {_odac_form: 'Form action not configured'}
        })
      },
      {token: true}
    )

    this.set(
      'POST',
      '/_odac/magic-login',
      async Odac => {
        const csrfToken = await Odac.request('_token')
        if (!csrfToken || !Odac.token(csrfToken)) {
          return Odac.Request.abort(401)
        }
        return await Internal.magicLogin(Odac)
      },
      {token: true}
    )

    this.set(
      'GET',
      '/_odac/magic-verify',
      async Odac => {
        return await Internal.magicVerify(Odac)
      },
      {token: false}
    )

    this.set(
      'GET',
      '/_odac/img/{file}',
      async Odac => {
        const filename = Odac.Request.data.url.file
        if (!filename) return Odac.Request.abort(404)

        // Validate filename format: {name}-{dimension}-{hash8}.{ext}
        if (!/^[\w-]+-(?:\d+|o)-[a-f0-9]{8}\.(webp|avif|png|jpeg|jpg|tiff)$/.test(filename)) {
          return Odac.Request.abort(404)
        }

        const result = await Image.serve(filename)
        if (!result) return Odac.Request.abort(404)

        Odac.Request.header('Content-Type', result.type)
        Odac.Request.header('Content-Length', result.size)
        Odac.Request.header('Cache-Control', 'public, max-age=31536000, immutable')
        return result.stream
      },
      {token: false}
    )

    delete Odac.Route.buff
  }

  async request(req, res) {
    // Same generator as the WebSocket upgrade path; Odac.Request.id may be used to correlate logs.
    const id = nodeCrypto.randomUUID()
    let param
    try {
      // Instance construction parses the request (query/cookies/body wiring) and
      // can throw on malformed input; keep it inside the try so a crafted request
      // becomes a 500 instead of an unhandled rejection that kills the worker.
      param = Odac.instance(id, req, res)
      // Unknown virtual host / route table → 404, not a status-less empty 200.
      if (!this.routes[param.Request.route]) {
        await param.Request.abort(404)
        return param.cleanup()
      }
      let result = this.check(param)
      if (result instanceof Promise) result = await result
      const Stream = require('./Stream.js')
      if (result instanceof Stream) return
      if (result && typeof result.pipe === 'function') {
        // HEAD has no body: release the source (image route, user controllers)
        // instead of reading it to the end only for Node to drop every chunk.
        if (param.Request.method === 'head') {
          result.destroy?.()
          param.Request.end()
          return param.cleanup()
        }
        param.Request.print()
        // pipeline() destroys the source when the client disconnects and
        // routes read errors here; pipe() did neither, leaking the file
        // descriptor on aborted downloads and crashing on a failed read.
        pipeline(result, param.Request.res, err => {
          param.Request.clearTimeout()
          if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error(JSON.stringify({level: 'ERROR', message: 'Response stream failed', error: err.message}))
          }
          param.cleanup()
        })
        // The request timeout is an idle deadline: each chunk proves progress.
        // Backpressure stops the chunks when the client stops reading, so a
        // stalled download still times out after one idle period.
        result.on('data', () => param.Request.refreshTimeout())
        return
      }
      if (param.Request.res.finished || param.Request.res.writableEnded) {
        param.cleanup()
        return
      }
      if (result) param.Request.end(result)
      await param.View.print(param)
      param.Request.print(param)
      param.cleanup()
    } catch (e) {
      console.error(e)
      // param may be undefined if instance construction itself threw.
      if (param) {
        try {
          await param.Request.abort(500)
          if (!param.Request.res.writableEnded) param.Request.end()
        } catch (err) {
          console.error(err)
          param.Request.res.destroy?.()
        }
        return param.cleanup()
      }
      try {
        res.statusCode = 500
        res.end()
      } catch {
        res.destroy?.()
      }
    }
  }

  use(...middlewares) {
    return new MiddlewareChain(this, [...middlewares.flat()])
  }

  /**
   * Creates a rate-limit middleware whose single budget is shared by every route it wraps.
   *
   * Why: the per-route `{rateLimit}` option limits one route; this covers a group
   * (`Odac.Route.use(Odac.Route.rateLimit({max: 100})).post(...).post(...)`).
   * @param {{max: number, window?: number, key?: function, name?: string}} options
   * @returns {function} Middleware.
   */
  rateLimit(options) {
    return RateLimit.middleware(options)
  }

  set(type, url, file, options = {}) {
    // Odac.Route.buff names the route file currently being loaded; set() reads
    // it to bucket the route. It only exists during synchronous loading. A route
    // registered from an async callback (setTimeout/promise/event) runs after
    // loading finished and buff was deleted — the route would silently land
    // under the `undefined` bucket and never match. Fail loudly instead.
    if (!Odac.Route.buff) {
      throw new Error(
        'Route.set() called with no active route file (Odac.Route.buff is unset). ' +
          'Register routes synchronously at the top level of a route file, not from ' +
          'async callbacks (setTimeout/promise/event handlers).'
      )
    }

    const capturedMiddlewares = this._pendingMiddlewares.length > 0 ? [...this._pendingMiddlewares] : undefined
    // Captured now: the load task below awaits fs.stat, and buff names whichever route file
    // is loading by the time it resumes.
    const routeName = Odac.Route.buff

    if (Array.isArray(type)) {
      type = type.map(t => t.toLowerCase())
      for (const t of type) {
        this.set(t, url, file, options)
      }
      return this
    }

    if (!options) options = {}
    if (typeof url !== 'string') url = String(url)
    if (url.length && url.endsWith('/')) url = url.slice(0, -1)

    type = type.toLowerCase()
    // Validated now so a bad declaration fails the route file load, not the first request.
    const rateLimit = options.rateLimit ? RateLimit.normalize(options.rateLimit, `${routeName}:${type}:${url}`) : undefined

    const isFunction = typeof file === 'function'
    let path = `${__dir}/route/${routeName}.js`

    let action = null

    if (!isFunction && file) {
      if (typeof file === 'string' && file.includes('@')) {
        let arr = file.split('@')
        file = arr[0]
        action = arr[1]
        path = `${__dir}/controller/${file.replace(/\./g, '/')}.js`
      } else {
        path = `${__dir}/controller/${type.replace('#', '')}/${file}.js`
        if (typeof file === 'string' && file.includes('.')) {
          let arr = file.split('.')
          path = `${__dir}/controller/${arr[0]}/${type.replace('#', '')}/${arr.slice(1).join('.')}.js`
        }
      }
    }

    if (!this.routes[routeName]) this.routes[routeName] = {}
    if (!this.routes[routeName][type]) this.routes[routeName][type] = {}

    // Declaration-derived fields, refreshed on every (re)registration.
    const applyOptions = entry => {
      entry.file = file
      entry.middlewares = capturedMiddlewares
      entry.token = options.token ?? true
      entry.action = action
      entry.rateLimit = rateLimit
    }

    const task = async () => {
      if (this.routes[routeName][type][url]) {
        this.routes[routeName][type][url].loaded = routes2[routeName]
        if (!isFunction) {
          try {
            const stat = await fsPromises.stat(path)
            if (this.routes[routeName][type][url].mtime < stat.mtimeMs) {
              delete this.routes[routeName][type][url]
              delete require.cache[require.resolve(path)]
            } else {
              // The controller is unchanged, but the route file may have changed what wraps it.
              applyOptions(this.routes[routeName][type][url])
              return
            }
          } catch {
            // File error, proceed to reload or re-set
          }
        } else {
          // Update inline function reference on hot reload
          this.routes[routeName][type][url].cache = file
          this.routes[routeName][type][url].mtime = Date.now()
          applyOptions(this.routes[routeName][type][url])
          return
        }
      }

      if (isFunction) {
        if (!this.routes[routeName][type][url]) this.routes[routeName][type][url] = {}
        this.routes[routeName][type][url].cache = file
        this.routes[routeName][type][url].type = 'function'
        this.routes[routeName][type][url].mtime = Date.now()
        this.routes[routeName][type][url].path = path
        this.routes[routeName][type][url].loaded = routes2[routeName]
        applyOptions(this.routes[routeName][type][url])
      } else {
        try {
          const stat = await fsPromises.stat(path)
          if (!this.routes[routeName][type][url]) this.routes[routeName][type][url] = {}
          this.routes[routeName][type][url].cache = require(path)
          this.routes[routeName][type][url].type = 'controller'
          this.routes[routeName][type][url].mtime = stat.mtimeMs
          this.routes[routeName][type][url].path = path
          this.routes[routeName][type][url].loaded = routes2[routeName]
          applyOptions(this.routes[routeName][type][url])
        } catch (err) {
          if (file && typeof file === 'string') {
            if (err.code === 'ENOENT') {
              console.error(`\x1b[31m[Odac]\x1b[0m Controller not found: \x1b[33m${path}\x1b[0m`)
            } else {
              console.error(`\x1b[31m[Odac]\x1b[0m Failed to load controller: \x1b[33m${path}\x1b[0m`)
              console.error(`\x1b[31m[Odac]\x1b[0m ${err.message}`)
            }
          }
        }
      }
    }

    this._pendingRouteLoads.push(task())

    // Mark parametric index for rebuild when route contains dynamic segments
    if (url.includes('{')) this.#paramIndexDirty = true

    return this
  }

  page(path, file) {
    if (typeof file === 'object' && !Array.isArray(file)) {
      this.set('page', path, _odac => {
        _odac.set(file)
        _odac.View.set(file)
        return
      })
      return this
    }
    if (file) this.set('page', path, file)
    return this
  }

  post(path, file, options) {
    this.set('post', path, file, options)
    return this
  }

  get(path, file, options) {
    this.set('get', path, file, options)
    return this
  }

  authPage(path, authFile, file) {
    if (typeof authFile === 'object' && authFile !== null && !Array.isArray(authFile)) {
      this.set('#page', path, _odac => {
        _odac.set(authFile)
        _odac.View.set(authFile)
        return
      })
      if (typeof file === 'object' && !Array.isArray(file)) {
        this.set('page', path, _odac => {
          _odac.set(file)
          _odac.View.set(file)
          return
        })
      } else if (file) {
        this.set('page', path, file)
      }
      return this
    }
    if (authFile) this.set('#page', path, authFile)
    if (file) {
      if (typeof file === 'object' && !Array.isArray(file)) {
        this.set('page', path, _odac => {
          _odac.set(file)
          _odac.View.set(file)
          return
        })
      } else {
        this.set('page', path, file)
      }
    }
    return this
  }

  authPost(path, authFile, file, options) {
    let opts = options
    let publicFile = file

    if (publicFile && typeof publicFile === 'object' && !opts) {
      opts = publicFile
      publicFile = undefined
    }

    if (authFile) this.set('#post', path, authFile, opts)
    if (publicFile) this.post(path, publicFile, opts)
    return this
  }

  authGet(path, authFile, file, options) {
    let opts = options
    let publicFile = file

    if (publicFile && typeof publicFile === 'object' && !opts) {
      opts = publicFile
      publicFile = undefined
    }

    if (authFile) this.set('#get', path, authFile, opts)
    if (publicFile) this.get(path, publicFile, opts)
    return this
  }

  error(code, file) {
    if (typeof file === 'object' && file !== null && !Array.isArray(file)) {
      this.set('error', code, _odac => {
        _odac.set(file)
        _odac.View.set(file)
      })
      return
    }
    this.set('error', code, file)
  }

  cron(controller) {
    return Cron.job(controller)
  }

  /**
   * Stops the cron scheduler during graceful shutdown.
   * Prevents new cron jobs from spawning while the process is terminating.
   */
  stopCron() {
    Cron.stop()
  }

  ws(path, handler, options = {}) {
    this.setWs('ws', path, handler, options)
    return this
  }

  authWs(path, handler, options = {}) {
    this.setWs('#ws', path, handler, options)
    return this
  }

  setWs(type, path, handler, options = {}) {
    const middlewares = this._pendingMiddlewares.length > 0 ? [...this._pendingMiddlewares] : undefined
    this._pendingMiddlewares = []

    const {token = true} = options
    const requireAuth = type === '#ws'

    if (typeof handler !== 'function') {
      let path = `${__dir}/controller/${type.replace('#', '')}/${handler}.js`
      if (typeof handler === 'string' && handler.includes('.')) {
        let arr = handler.split('.')
        path = `${__dir}/controller/${arr[0]}/${type.replace('#', '')}/${arr.slice(1).join('.')}.js`
      }

      if (fs.existsSync(path)) {
        handler = require(path)
      } else {
        console.error(`\x1b[31m[Odac]\x1b[0m WebSocket Controller not found: \x1b[33m${path}\x1b[0m`)
        return
      }
    }

    if (typeof handler !== 'function') {
      console.error(`\x1b[31m[Odac]\x1b[0m Invalid WebSocket handler (not a function).`)
      return
    }

    const wrappedHandler = async (ws, Odac) => {
      Odac.ws = ws

      ws.on('close', () => {
        if (Odac.cleanup && typeof Odac.cleanup === 'function') {
          Odac.cleanup()
        }
      })

      // Global Auth Check: Load user if valid tokens exist to simplify DX
      // This allows calling Odac.Auth.user() anywhere without manual await Odac.Auth.check()
      if (Odac.Auth) await Odac.Auth.check()

      if (requireAuth) {
        let isAuthenticated = false
        if (Odac.Auth) {
          isAuthenticated = await Odac.Auth.check()
        }
        if (!isAuthenticated) {
          ws.close(4001, 'Unauthorized')
          return
        }
      }

      if (token) {
        const wsToken = Odac.Request._wsHeaders ? Odac.Request._wsHeaders['sec-websocket-protocol'] : null
        const tokens = wsToken ? wsToken.split(',').map(t => t.trim()) : []
        const odacToken = tokens.find(t => t.startsWith('odac-token-'))

        if (!odacToken) {
          ws.close(4002, 'Missing token')
          return
        }

        const tokenValue = odacToken.replace('odac-token-', '')
        if (!Odac.token(tokenValue)) {
          ws.close(4002, 'Invalid token')
          return
        }
      }

      if (middlewares) {
        for (const mw of middlewares) {
          const middleware = typeof mw === 'function' ? mw : this.middlewares[mw]?.handler

          if (!middleware) {
            console.error(`Middleware not found: ${mw}`)
            ws.close(4000, 'Internal error')
            return
          }

          const result = await middleware(Odac)

          if (Odac.Request.ended) {
            closeRejected(ws, Odac.Request.statusCode)
            return
          }

          if (result === false) {
            ws.close(4003, 'Forbidden')
            return
          }

          if (result !== undefined && result !== true) {
            ws.close(4000, 'Middleware rejected')
            return
          }
        }
      }
      const res = handler(Odac)
      if (res instanceof Promise) await res
      if (Odac.Request.ended) {
        closeRejected(ws, Odac.Request.statusCode)
        return
      }
      ws.resume()
      return res
    }

    // Scoped to the route file being loaded (its subdomain), like HTTP routes, so a socket
    // defined for one site is not reachable through another host name.
    const site = global.Odac?.Route?.buff ?? null
    if (site !== null && !this.routes[site]) this.routes[site] = {}
    this.#wsServer.route(path, wrappedHandler, options, site)
  }

  handleWebSocketUpgrade(req, socket, head, Odac) {
    this.#wsServer.handleUpgrade(req, socket, head, Odac)
  }

  get wsServer() {
    return this.#wsServer
  }
}

module.exports = Route
