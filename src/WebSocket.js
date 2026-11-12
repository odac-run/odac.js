const nodeCrypto = require('crypto')

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
// Ipc channel and per-process identity used to bridge WebSocket fan-out
// (broadcast/toRoom) across cluster workers. Each worker holds its own client
// map, so a fan-out call is delivered locally AND relayed to sibling workers,
// which re-deliver to their own local clients. WORKER_ID tags each relay so a
// worker can drop its own echo instead of delivering twice.
const WS_RELAY_CHANNEL = 'odac:ws:relay'
const WORKER_ID = `${process.pid}`
const DEFAULT_MAX_PAYLOAD = 10 * 1024 * 1024
const DEFAULT_RATE_LIMIT_MAX = 50
const DEFAULT_RATE_LIMIT_WINDOW = 1000
// After the server sends its CLOSE frame and FIN, the peer gets this long to
// finish the TCP close before the socket is destroyed. HTTP server sockets are
// half-open capable, so a peer that never sends FIN would otherwise pin the fd.
const CLOSE_TIMEOUT = 1000
// A connection that answers neither data nor a ping within two intervals is half-open
// (peer vanished without a FIN) and is dropped, releasing its socket and request scope.
const DEFAULT_HEARTBEAT = 30000
// Bytes queued in the socket for a client that reads slower than it is sent to. Beyond this
// the client is dropped instead of letting broadcasts grow worker memory without bound.
const DEFAULT_MAX_BUFFERED = 16 * 1024 * 1024
const utf8 = new TextDecoder('utf-8', {fatal: true})

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
}

/**
 * RFC 6455 connection lifecycle states.
 * Exposed as static constants on WebSocketClient for consumer-side checks.
 */
const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
}

/** Structured log line for a failing user handler; never rethrows. */
const reportHandlerError = (event, err) =>
  console.error(JSON.stringify({level: 'ERROR', message: `WebSocket '${event}' handler failed`, error: err?.message ?? String(err)}))

const isBinary = data => Buffer.isBuffer(data) || ArrayBuffer.isView(data) || data instanceof ArrayBuffer

/**
 * Views must be wrapped over their backing memory rather than passed to
 * Buffer.from() directly: for anything wider than a byte (Uint16Array,
 * Float32Array, DataView) Buffer.from() reads the view as a list of numbers
 * and truncates each element to a single byte.
 */
const toPayload = data => {
  if (Buffer.isBuffer(data)) return data
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data)
}

// Route parameters are matched on the raw path and decoded once, like HTTP routes.
function decodeParam(segment) {
  if (!segment.includes('%')) return segment
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

class WebSocketClient {
  static CONNECTING = READY_STATE.CONNECTING
  static OPEN = READY_STATE.OPEN
  static CLOSING = READY_STATE.CLOSING
  static CLOSED = READY_STATE.CLOSED

  #socket
  #handlers = {}
  #readyState = READY_STATE.CONNECTING
  #server
  #id
  #rooms = new Set()
  #maxPayload
  #rateLimitMax
  #rateLimitWindow
  #messageCount = 0
  #windowStart = 0
  #fragments = null
  #maxBuffered
  #alive = true
  #parseJson
  #onData
  #closeTimer = null
  data = {}

  constructor(socket, server, id, options = {}) {
    this.#socket = socket
    this.#socket.pause()
    this.#server = server
    this.#id = id
    this.#maxPayload = options.maxPayload || DEFAULT_MAX_PAYLOAD

    this.#rateLimitMax = options.rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX
    this.#rateLimitWindow = options.rateLimit?.window ?? DEFAULT_RATE_LIMIT_WINDOW
    this.#parseJson = options.parseJson !== false
    this.#maxBuffered = options.maxBuffered ?? Math.max(DEFAULT_MAX_BUFFERED, this.#maxPayload * 2)

    this.#setupListeners()
  }

  /**
   * Transitions the client from CONNECTING to OPEN and resumes the underlying socket.
   * Must be called after the handler is attached to begin receiving frames.
   */
  resume() {
    this.#readyState = READY_STATE.OPEN
    this.#socket.resume()
  }

  /** @returns {number} Current RFC 6455 ready state (0–3). */
  get readyState() {
    return this.#readyState
  }

  get id() {
    return this.#id
  }

  get rooms() {
    return Array.from(this.#rooms)
  }

  /** @returns {number} Bytes written but not yet flushed to the client. */
  get bufferedAmount() {
    return this.#socket.writableLength ?? 0
  }

  /**
   * One heartbeat step, driven by the server's shared timer.
   * Why: without pings a half-open connection (peer gone without a FIN) and its request scope
   * live forever. Any frame from the peer counts as a sign of life.
   */
  heartbeat() {
    if (this.#readyState !== READY_STATE.OPEN) return
    if (!this.#alive) {
      this.terminate()
      return
    }
    this.#alive = false
    this.#sendFrame(OPCODE.PING, Buffer.alloc(0))
  }

  /** Drops the connection without a closing handshake (dead or overloaded peer). */
  terminate() {
    clearTimeout(this.#closeTimer)
    this.#socket.destroy()
    this.#cleanup()
  }

  #setupListeners() {
    // Incoming bytes are kept as a chunk list and joined once per frame. Concatenating the
    // whole buffer on every chunk copied a 10 MB message over and over: O(n²).
    const chunks = []
    let buffered = 0
    let header = null

    const take = length => {
      let result
      if (chunks[0].length >= length) {
        result = chunks[0].subarray(0, length)
        chunks[0] = chunks[0].subarray(length)
        if (chunks[0].length === 0) chunks.shift()
      } else {
        const parts = []
        let remaining = length
        while (remaining > 0) {
          const chunk = chunks[0]
          if (chunk.length <= remaining) {
            parts.push(chunk)
            remaining -= chunk.length
            chunks.shift()
          } else {
            parts.push(chunk.subarray(0, remaining))
            chunks[0] = chunk.subarray(remaining)
            remaining = 0
          }
        }
        result = Buffer.concat(parts, length)
      }
      buffered -= length
      return result
    }

    // The header is at most 14 bytes; merging that much of the leading chunks is cheap.
    const peek = length => {
      if (chunks[0].length < length) {
        chunks.unshift(take(length))
        buffered += length
      }
      return chunks[0]
    }

    this.#onData = chunk => {
      this.#alive = true
      chunks.push(chunk)
      buffered += chunk.length

      while (this.#readyState !== READY_STATE.CLOSED && this.#readyState !== READY_STATE.CLOSING) {
        if (!header) {
          if (buffered < 2) return
          const parsed = this.#parseHeader(peek(Math.min(buffered, 14)))
          if (!parsed) return
          header = parsed
        }
        if (buffered < header.length) return
        const frame = take(header.length)
        const current = header
        header = null
        this.#handleFrame(this.#decodeFrame(current, frame))
      }
    }

    this.#socket.on('data', this.#onData)
    this.#socket.on('close', () => this.#handleClose())
    // Stays attached for the socket's whole life: a reset that lands between
    // our CLOSE frame and the TCP close is otherwise an unhandled 'error'
    // event that kills the worker. Post-close errors are expected noise.
    this.#socket.on('error', err => {
      if (this.#readyState !== READY_STATE.CLOSED) this.#emit('error', err)
    })
  }

  /**
   * Reads a frame header. Returns null when more bytes are needed and when the frame is
   * rejected (the connection is then closing).
   * Why: RSV bits without a negotiated extension, unknown opcodes, and fragmented or
   * oversized control frames are protocol errors (RFC 6455 §5.2, §5.5) and must not be
   * interpreted as data.
   */
  #parseHeader(buffer) {
    const firstByte = buffer[0]
    const secondByte = buffer[1]

    const fin = (firstByte & 0x80) !== 0
    const opcode = firstByte & 0x0f
    const masked = (secondByte & 0x80) !== 0

    if (!masked) {
      this.close(1002, 'Protocol error: client-to-server frames must be masked.')
      return null
    }
    if ((firstByte & 0x70) !== 0) {
      this.close(1002, 'Protocol error: reserved bits set')
      return null
    }
    if (!Object.values(OPCODE).includes(opcode)) {
      this.close(1002, 'Protocol error: unknown opcode')
      return null
    }

    let payloadLength = secondByte & 0x7f
    let offset = 2

    if (opcode >= OPCODE.CLOSE && (!fin || payloadLength > 125)) {
      this.close(1002, 'Protocol error: invalid control frame')
      return null
    }

    if (payloadLength === 126) {
      if (buffer.length < 4) return null
      payloadLength = buffer.readUInt16BE(2)
      offset = 4
    } else if (payloadLength === 127) {
      if (buffer.length < 10) return null
      const payloadLengthBigInt = buffer.readBigUInt64BE(2)
      if (payloadLengthBigInt > Number.MAX_SAFE_INTEGER) {
        this.close(1009, 'Payload too large')
        return null
      }
      payloadLength = Number(payloadLengthBigInt)
      offset = 10
    }

    if (payloadLength > this.#maxPayload) {
      this.close(1009, 'Payload too large')
      return null
    }

    if (buffer.length < offset + 4) return null
    return {fin, opcode, maskOffset: offset, length: offset + 4 + payloadLength}
  }

  #decodeFrame(header, frame) {
    const maskKey = frame.subarray(header.maskOffset, header.maskOffset + 4)
    const payload = Buffer.from(frame.subarray(header.maskOffset + 4))
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
    return {fin: header.fin, opcode: header.opcode, payload}
  }

  // Appends a continuation payload while enforcing a cap on the *total*
  // reassembled size. Per-frame maxPayload alone lets an attacker stream
  // unlimited small fragments and exhaust worker memory; bound the sum too.
  #appendFragment(payload) {
    this.#fragments.length += payload.length
    if (this.#fragments.length > this.#maxPayload) {
      this.#fragments = null
      this.close(1009, 'Fragmented message too large')
      return false
    }
    this.#fragments.buffers.push(payload)
    return true
  }

  #handleFrame(frame) {
    if (this.#rateLimitMax > 0) {
      // Fixed window measured on arrival; a per-connection setInterval did the same reset.
      const now = Date.now()
      if (now - this.#windowStart >= this.#rateLimitWindow) {
        this.#windowStart = now
        this.#messageCount = 0
      }
      this.#messageCount++
      if (this.#messageCount > this.#rateLimitMax) {
        this.close(1008, 'Rate limit exceeded')
        return
      }
    }

    switch (frame.opcode) {
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (this.#fragments) {
          // A new data frame may not start while a fragmented message is still open.
          this.close(1002, 'Protocol error: expected continuation frame')
          return
        }
        if (frame.fin) {
          this.#deliver(frame.opcode, frame.payload)
        } else {
          // First fragment — start accumulating
          this.#fragments = {opcode: frame.opcode, buffers: [frame.payload], length: frame.payload.length}
        }
        break
      case OPCODE.CONTINUATION:
        if (!this.#fragments) {
          this.close(1002, 'Protocol error: unexpected continuation frame')
          return
        }
        if (!this.#appendFragment(frame.payload)) return
        if (frame.fin) {
          const merged = Buffer.concat(this.#fragments.buffers, this.#fragments.length)
          const opcode = this.#fragments.opcode
          this.#fragments = null
          this.#deliver(opcode, merged)
        }
        break
      case OPCODE.PING:
        this.#sendFrame(OPCODE.PONG, frame.payload)
        this.#emit('ping', frame.payload)
        break
      case OPCODE.PONG:
        this.#emit('pong')
        break
      case OPCODE.CLOSE:
        this.close()
        break
    }
  }

  // Text must be valid UTF-8 (RFC 6455 §8.1); toString() silently replaced bad bytes.
  #deliver(opcode, payload) {
    if (opcode !== OPCODE.TEXT) return this.#handleMessage(payload)
    let text
    try {
      text = utf8.decode(payload)
    } catch {
      this.close(1007, 'Invalid UTF-8 in text message')
      return
    }
    this.#handleMessage(text)
  }

  /**
   * TEXT frames are offered to JSON.parse as a convenience; BINARY frames never
   * are. Passing a Buffer to JSON.parse would stringify it first, so a binary
   * payload of `42` would silently arrive as the number 42 instead of bytes.
   *
   * Text payloads that are not meant as JSON want neither: the convenience
   * turns "1" into the number 1. `parseJson: false` on the route opts out and
   * delivers every payload untouched.
   */
  #handleMessage(data) {
    if (!this.#parseJson || typeof data !== 'string') return this.#emit('message', data)

    let message = data
    try {
      message = JSON.parse(data)
    } catch {
      // Not JSON: deliver the raw text.
    }
    this.#emit('message', message)
  }

  /**
   * Centralised resource teardown — called by both close() and the socket 'close' event.
   * Idempotent: subsequent calls are no-ops once state reaches CLOSED.
   */
  #cleanup() {
    if (this.#readyState === READY_STATE.CLOSED) return
    this.#readyState = READY_STATE.CLOSED

    this.#fragments = null

    // Only detach our own frame parser. removeAllListeners() would also strip
    // the error guard and Node's internal socket listeners while the socket
    // is still half-open.
    this.#socket.removeListener('data', this.#onData)

    for (const room of this.#rooms) {
      this.#server.leaveRoom(this.#id, room)
    }

    this.#emit('close')
    this.#server.removeClient(this.#id)
  }

  #handleClose() {
    clearTimeout(this.#closeTimer)
    this.#closeTimer = null
    this.#cleanup()
  }

  #sendFrame(opcode, data) {
    if (this.#readyState === READY_STATE.CLOSED) return
    if (this.#readyState === READY_STATE.CLOSING && opcode !== OPCODE.CLOSE) return
    if (!this.#socket.writable) return

    const payload = toPayload(data)
    const length = payload.length

    let header
    if (length < 126) {
      header = Buffer.alloc(2)
      header[0] = 0x80 | opcode
      header[1] = length
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }

    this.#socket.write(Buffer.concat([header, payload]))
    // write() buffers without limit when the peer reads slowly; a fan-out to such a client
    // would hold every message in worker memory.
    if (opcode !== OPCODE.CLOSE && this.#socket.writableLength > this.#maxBuffered) {
      reportHandlerError('send', new Error(`client ${this.#id} too slow; ${this.#socket.writableLength} bytes queued`))
      this.terminate()
    }
  }

  /**
   * Dispatches an event to user handlers.
   *
   * Why: handlers run inside the socket 'data' listener. A synchronous throw
   * would be an uncaught exception and an async rejection an unhandled
   * rejection; both terminate the worker. Each handler is isolated so one bug
   * neither crashes the process nor skips the remaining handlers.
   */
  #emit(event, ...args) {
    const handlers = this.#handlers[event]
    if (!handlers) return
    for (const handler of handlers) {
      try {
        const result = handler(...args)
        if (result && typeof result.then === 'function') result.then(undefined, err => reportHandlerError(event, err))
      } catch (err) {
        reportHandlerError(event, err)
      }
    }
  }

  on(event, handler) {
    if (!this.#handlers[event]) this.#handlers[event] = []
    this.#handlers[event].push(handler)
    return this
  }

  off(event, handler) {
    if (!this.#handlers[event]) return this
    if (handler) {
      this.#handlers[event] = this.#handlers[event].filter(h => h !== handler)
    } else {
      delete this.#handlers[event]
    }
    return this
  }

  send(data) {
    if (this.#readyState !== READY_STATE.OPEN) return this
    if (isBinary(data)) {
      this.#sendFrame(OPCODE.BINARY, data)
      return this
    }
    const payload = typeof data === 'object' ? JSON.stringify(data) : String(data)
    this.#sendFrame(OPCODE.TEXT, payload)
    return this
  }

  sendBinary(data) {
    if (this.#readyState !== READY_STATE.OPEN) return this
    this.#sendFrame(OPCODE.BINARY, data)
    return this
  }

  ping() {
    if (this.#readyState !== READY_STATE.OPEN) return this
    this.#sendFrame(OPCODE.PING, Buffer.alloc(0))
    return this
  }

  close(code = 1000, reason = '') {
    if (this.#readyState === READY_STATE.CLOSED || this.#readyState === READY_STATE.CLOSING) return
    this.#readyState = READY_STATE.CLOSING

    const reasonBuffer = Buffer.from(reason)
    const payload = Buffer.alloc(2 + reasonBuffer.length)
    payload.writeUInt16BE(code, 0)
    reasonBuffer.copy(payload, 2)

    this.#sendFrame(OPCODE.CLOSE, payload)
    this.#socket.end()
    const socket = this.#socket
    this.#closeTimer = setTimeout(() => socket.destroy(), CLOSE_TIMEOUT)
    this.#closeTimer.unref?.()
    this.#cleanup()
  }

  join(room) {
    this.#rooms.add(room)
    this.#server.joinRoom(this.#id, room)
    return this
  }

  leave(room) {
    this.#rooms.delete(room)
    this.#server.leaveRoom(this.#id, room)
    return this
  }

  to(room) {
    return {
      send: data => this.#server.toRoom(room, data),
      sendBinary: data => this.#server.toRoomBinary(room, data)
    }
  }

  broadcast(data, includesSelf = false) {
    this.#server.broadcast(data, includesSelf ? null : this.#id)
    return this
  }
}

/**
 * Picks the one subprotocol the handshake answers with (RFC 6455 §4.2.2).
 * Why: echoing the client's whole offer is accepted only when it offered a single value;
 * a client asking for its own protocol plus the ODAC token was refused by the browser.
 * Prefers a protocol the route lists in `options.protocols`, then the ODAC token.
 */
function selectProtocol(header, supported) {
  if (!header) return null
  const offered = header
    .split(',')
    .map(protocol => protocol.trim())
    .filter(Boolean)
  if (Array.isArray(supported)) {
    const match = offered.find(protocol => supported.includes(protocol))
    if (match) return match
  }
  return offered.find(protocol => protocol.startsWith('odac-token-')) ?? offered[0] ?? null
}

/**
 * Whether a browser page from `origin` may open this socket.
 * Why: browsers attach cookies to cross-site WebSocket handshakes, so a route that relies on
 * the session (e.g. `token: false`) could be driven by any website. Requests without an Origin
 * (non-browser clients) are not affected; `options.origins` lists extra origins or '*'.
 */
function originAllowed(origin, host, allowed) {
  if (!origin) return true
  if (allowed === '*') return true
  if (Array.isArray(allowed) && allowed.includes(origin)) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

class WebSocketServer {
  #clients = new Map()
  #rooms = new Map()
  #routes = new Map()
  #bridgeReady = false
  #heartbeatTimer = null

  /**
   * Registers a WebSocket route.
   * @param {string} path
   * @param {function} handler
   * @param {object} [options]
   * @param {string|null} [site] Route file (subdomain) the route belongs to, like HTTP routes;
   *   null serves every host.
   */
  route(path, handler, options = {}, site = null) {
    this.#routes.set(site === null ? path : `${site}\u0000${path}`, {handler, options, path, site})
  }

  /**
   * Removes every route registered for `site` and returns them.
   * Why: hot reload re-runs a route file; sockets it no longer defines must stop matching.
   * @param {string} site
   * @returns {Array<[string, object]>} The removed entries, for restoreRoutes().
   */
  unrouteSite(site) {
    const removed = []
    for (const [key, config] of this.#routes) {
      if (config.site !== site) continue
      removed.push([key, config])
      this.#routes.delete(key)
    }
    return removed
  }

  /**
   * Puts back routes removed by unrouteSite() that were not registered again, used when a
   * route file fails to load so its previous sockets keep working.
   * @param {Array<[string, object]>} entries
   */
  restoreRoutes(entries) {
    for (const [key, config] of entries) if (!this.#routes.has(key)) this.#routes.set(key, config)
  }

  getRoute(path, site = null) {
    return (site !== null && this.#match(path, site)) || this.#match(path, null)
  }

  #match(path, site) {
    const exact = this.#routes.get(site === null ? path : `${site}\u0000${path}`)
    if (exact) return exact

    for (const config of this.#routes.values()) {
      if (config.site !== site) continue
      const pattern = config.path
      if (!pattern.includes('{')) continue
      const regex = new RegExp('^' + pattern.replace(/\{[^}]+\}/g, '([^/]+)') + '$')
      const match = path.match(regex)
      if (match) {
        const params = {}
        const paramNames = pattern.match(/\{([^}]+)\}/g) || []
        paramNames.forEach((name, i) => {
          params[name.slice(1, -1)] = decodeParam(match[i + 1])
        })
        return {
          handler: config.handler,
          options: config.options,
          params
        }
      }
    }
    return null
  }

  handleUpgrade(req, socket, head, Odac) {
    const path = req.url.split('?')[0]
    const routeInfo = this.getRoute(path, Odac?.Request?.route ?? null)

    if (!routeInfo) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const {handler, params = {}, options = {}} = routeInfo

    if (!originAllowed(req.headers.origin, req.headers.host, options.origins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    const key = req.headers['sec-websocket-key']
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    const acceptKey = nodeCrypto
      .createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64')

    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`
    ]

    const protocol = selectProtocol(req.headers['sec-websocket-protocol'], options.protocols)
    if (protocol) responseHeaders.push(`Sec-WebSocket-Protocol: ${protocol}`)

    responseHeaders.push('', '')

    socket.write(responseHeaders.join('\r\n'))

    if (head && head.length > 0) socket.unshift(head)

    const clientId = nodeCrypto.randomUUID()
    const client = new WebSocketClient(socket, this, clientId, options)
    this.#clients.set(clientId, client)
    this.#startHeartbeat()
    // A worker with local clients must listen for relays from its siblings, even
    // if it never itself broadcasts.
    this.#ensureBridge()

    if (params) {
      for (const [k, v] of Object.entries(params)) {
        Odac.Request.data.url[k] = v
      }
    }

    if (Odac.Request && req.headers) {
      Odac.Request._wsHeaders = req.headers
    }

    // The route handler (auth check, middleware, user code) is async. A
    // failure closes this connection with 1011 instead of becoming an
    // unhandled rejection that takes down every connection on the worker.
    const fail = err => {
      reportHandlerError('connection', err)
      client.close(1011, 'Internal error')
    }
    try {
      const pending = handler(client, Odac)
      if (pending && typeof pending.then === 'function') pending.then(undefined, fail)
    } catch (err) {
      fail(err)
    }
  }

  removeClient(id) {
    this.#clients.delete(id)
    if (this.#clients.size === 0) this.#stopHeartbeat()
  }

  // One timer per worker drives every client's heartbeat; it runs only while clients exist.
  // `websocket.heartbeat` in odac.json sets the interval in ms; 0 disables it.
  #startHeartbeat() {
    if (this.#heartbeatTimer) return
    const interval = global.Odac?.Config?.websocket?.heartbeat ?? DEFAULT_HEARTBEAT
    if (!(interval > 0)) return
    this.#heartbeatTimer = setInterval(() => {
      for (const client of [...this.#clients.values()]) client.heartbeat()
    }, interval)
    this.#heartbeatTimer.unref?.()
  }

  #stopHeartbeat() {
    clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = null
  }

  /**
   * Closes every client on this worker.
   *
   * Why: upgraded sockets are outside the HTTP server's connection list, so
   * server.closeAllConnections() cannot reach them, yet they keep
   * server.close() from calling back. Shutdown closes them here; a peer that
   * never answers the close frame is destroyed after CLOSE_TIMEOUT.
   * @param {number} [code=1001] Going Away: tells clients to reconnect elsewhere
   * @param {string} [reason='Server shutting down']
   */
  closeAll(code = 1001, reason = 'Server shutting down') {
    for (const client of [...this.#clients.values()]) client.close(code, reason)
  }

  joinRoom(clientId, room) {
    if (!this.#rooms.has(room)) this.#rooms.set(room, new Set())
    this.#rooms.get(room).add(clientId)
  }

  leaveRoom(clientId, room) {
    if (!this.#rooms.has(room)) return
    this.#rooms.get(room).delete(clientId)
    if (this.#rooms.get(room).size === 0) this.#rooms.delete(room)
  }

  toRoom(room, data) {
    this.#toRoomLocal(room, data)
    this.#relay({op: 'room', room, payload: this.#encodeData(data)})
  }

  #toRoomLocal(room, data) {
    if (!this.#rooms.has(room)) return
    for (const clientId of this.#rooms.get(room)) {
      const client = this.#clients.get(clientId)
      if (client) client.send(data)
    }
  }

  toRoomBinary(room, data) {
    this.#toRoomBinaryLocal(room, data)
    this.#relay({op: 'roomBinary', room, payload: this.#encodeData(data)})
  }

  #toRoomBinaryLocal(room, data) {
    if (!this.#rooms.has(room)) return
    for (const clientId of this.#rooms.get(room)) {
      const client = this.#clients.get(clientId)
      if (client) client.sendBinary(data)
    }
  }

  broadcast(data, excludeId = null) {
    this.#broadcastLocal(data, excludeId)
    // excludeId identifies a client on the ORIGIN worker; on sibling workers it
    // simply matches nothing, so relaying it through is safe.
    this.#relay({op: 'broadcast', excludeId, payload: this.#encodeData(data)})
  }

  #broadcastLocal(data, excludeId = null) {
    for (const [id, client] of this.#clients) {
      if (id !== excludeId) client.send(data)
    }
  }

  // --- Cross-worker relay (see WS_RELAY_CHANNEL) ---

  // Binary payloads can't survive the JSON hop that Ipc pub/sub uses, so encode
  // them as base64 with a flag the receiver uses to reconstruct a Buffer.
  #encodeData(data) {
    if (isBinary(data)) return {binary: true, data: toPayload(data).toString('base64')}
    return {binary: false, data}
  }

  #decodeData(payload) {
    if (!payload) return undefined
    return payload.binary ? Buffer.from(payload.data, 'base64') : payload.data
  }

  // Subscribe once so this worker re-delivers messages relayed by its siblings.
  // No-op when there is no Ipc (single-process/dev) — fan-out stays local-only.
  #ensureBridge() {
    if (this.#bridgeReady) return
    const Ipc = global.Odac && global.Odac.Ipc
    if (!Ipc || typeof Ipc.subscribe !== 'function') return
    this.#bridgeReady = true
    Promise.resolve(Ipc.subscribe(WS_RELAY_CHANNEL, msg => this.#onRelay(msg))).catch(err => {
      this.#bridgeReady = false
      console.error('[Odac WS] Failed to set up cross-worker relay:', err && err.message)
    })
  }

  #relay(message) {
    const Ipc = global.Odac && global.Odac.Ipc
    if (!Ipc || typeof Ipc.publish !== 'function') return
    this.#ensureBridge()
    message.origin = WORKER_ID
    Promise.resolve(Ipc.publish(WS_RELAY_CHANNEL, message)).catch(err =>
      console.error('[Odac WS] Failed to relay to other workers:', err && err.message)
    )
  }

  #onRelay(message) {
    // Drop our own echo — the origin worker already delivered locally.
    if (!message || message.origin === WORKER_ID) return
    const data = this.#decodeData(message.payload)
    switch (message.op) {
      case 'broadcast':
        this.#broadcastLocal(data, message.excludeId ?? null)
        break
      case 'room':
        this.#toRoomLocal(message.room, data)
        break
      case 'roomBinary':
        this.#toRoomBinaryLocal(message.room, data)
        break
    }
  }

  get clients() {
    return this.#clients
  }

  get clientCount() {
    return this.#clients.size
  }
}

module.exports = {WebSocketServer, WebSocketClient, READY_STATE}
