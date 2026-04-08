const nodeCrypto = require('crypto')

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const DEFAULT_MAX_PAYLOAD = 10 * 1024 * 1024
const DEFAULT_RATE_LIMIT_MAX = 50
const DEFAULT_RATE_LIMIT_WINDOW = 1000

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
  #rateLimitTimer
  #fragments = null
  data = {}

  constructor(socket, server, id, options = {}) {
    this.#socket = socket
    this.#socket.pause()
    this.#server = server
    this.#id = id
    this.#maxPayload = options.maxPayload || DEFAULT_MAX_PAYLOAD

    this.#rateLimitMax = options.rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX
    this.#rateLimitWindow = options.rateLimit?.window ?? DEFAULT_RATE_LIMIT_WINDOW

    if (this.#rateLimitMax > 0) {
      this.#rateLimitTimer = setInterval(() => {
        this.#messageCount = 0
      }, this.#rateLimitWindow)
    }

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

  #setupListeners() {
    let buffer = Buffer.alloc(0)

    this.#socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])

      while (buffer.length >= 2) {
        const frame = this.#parseFrame(buffer)
        if (!frame) break

        buffer = buffer.slice(frame.totalLength)
        this.#handleFrame(frame)
      }
    })

    this.#socket.on('close', () => this.#handleClose())
    this.#socket.on('error', err => this.#emit('error', err))
  }

  #parseFrame(buffer) {
    if (buffer.length < 2) return null

    const firstByte = buffer[0]
    const secondByte = buffer[1]

    const fin = (firstByte & 0x80) !== 0
    const opcode = firstByte & 0x0f
    const masked = (secondByte & 0x80) !== 0

    if (!masked) {
      this.close(1002, 'Protocol error: client-to-server frames must be masked.')
      return null
    }

    let payloadLength = secondByte & 0x7f

    let offset = 2

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

    let maskKey = null
    if (masked) {
      if (buffer.length < offset + 4) return null
      maskKey = buffer.slice(offset, offset + 4)
      offset += 4
    }

    if (buffer.length < offset + payloadLength) return null

    let payload = buffer.slice(offset, offset + payloadLength)

    if (masked && maskKey) {
      payload = Buffer.from(payload)
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4]
      }
    }

    return {
      fin,
      opcode,
      payload,
      totalLength: offset + payloadLength
    }
  }

  #handleFrame(frame) {
    if (this.#rateLimitMax > 0) {
      this.#messageCount++
      if (this.#messageCount > this.#rateLimitMax) {
        this.close(1008, 'Rate limit exceeded')
        return
      }
    }

    switch (frame.opcode) {
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (frame.fin) {
          if (this.#fragments) {
            // Final fragment of a fragmented sequence
            this.#fragments.buffers.push(frame.payload)
            const merged = Buffer.concat(this.#fragments.buffers)
            const opcode = this.#fragments.opcode
            this.#fragments = null
            this.#handleMessage(opcode === OPCODE.TEXT ? merged.toString('utf8') : merged)
          } else {
            // Single, unfragmented message
            this.#handleMessage(frame.opcode === OPCODE.TEXT ? frame.payload.toString('utf8') : frame.payload)
          }
        } else {
          // First fragment — start accumulating
          this.#fragments = {opcode: frame.opcode, buffers: [frame.payload]}
        }
        break
      case OPCODE.CONTINUATION:
        if (!this.#fragments) {
          this.close(1002, 'Protocol error: unexpected continuation frame')
          return
        }
        this.#fragments.buffers.push(frame.payload)
        if (frame.fin) {
          const merged = Buffer.concat(this.#fragments.buffers)
          const opcode = this.#fragments.opcode
          this.#fragments = null
          this.#handleMessage(opcode === OPCODE.TEXT ? merged.toString('utf8') : merged)
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

  #handleMessage(data) {
    try {
      const parsed = JSON.parse(data)
      this.#emit('message', parsed)
    } catch {
      this.#emit('message', data)
    }
  }

  /**
   * Centralised resource teardown — called by both close() and the socket 'close' event.
   * Idempotent: subsequent calls are no-ops once state reaches CLOSED.
   */
  #cleanup() {
    if (this.#readyState === READY_STATE.CLOSED) return
    this.#readyState = READY_STATE.CLOSED

    if (this.#rateLimitTimer) clearInterval(this.#rateLimitTimer)
    this.#fragments = null

    this.#socket.removeAllListeners()

    for (const room of this.#rooms) {
      this.#server.leaveRoom(this.#id, room)
    }

    this.#emit('close')
    this.#server.removeClient(this.#id)
  }

  #handleClose() {
    this.#cleanup()
  }

  #sendFrame(opcode, data) {
    if (this.#readyState === READY_STATE.CLOSED) return
    if (this.#readyState === READY_STATE.CLOSING && opcode !== OPCODE.CLOSE) return
    if (!this.#socket.writable) return

    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data)
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
  }

  #emit(event, ...args) {
    if (this.#handlers[event]) {
      for (const handler of this.#handlers[event]) {
        handler(...args)
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

class WebSocketServer {
  #clients = new Map()
  #rooms = new Map()
  #routes = new Map()

  route(path, handler, options = {}) {
    this.#routes.set(path, {handler, options})
  }

  getRoute(path) {
    if (this.#routes.has(path)) return this.#routes.get(path)

    for (const [pattern, config] of this.#routes) {
      if (!pattern.includes('{')) continue
      const regex = new RegExp('^' + pattern.replace(/\{[^}]+\}/g, '([^/]+)') + '$')
      const match = path.match(regex)
      if (match) {
        const params = {}
        const paramNames = pattern.match(/\{([^}]+)\}/g) || []
        paramNames.forEach((name, i) => {
          params[name.slice(1, -1)] = match[i + 1]
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
    const routeInfo = this.getRoute(path)

    if (!routeInfo) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const {handler, params = {}, options = {}} = routeInfo

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

    if (req.headers['sec-websocket-protocol']) {
      responseHeaders.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`)
    }

    responseHeaders.push('', '')

    socket.write(responseHeaders.join('\r\n'))

    if (head && head.length > 0) socket.unshift(head)

    const clientId = nodeCrypto.randomUUID()
    const client = new WebSocketClient(socket, this, clientId, options)
    this.#clients.set(clientId, client)

    if (params) {
      for (const [k, v] of Object.entries(params)) {
        Odac.Request.data.url[k] = v
      }
    }

    if (Odac.Request && req.headers) {
      Odac.Request._wsHeaders = req.headers
    }

    handler(client, Odac)
  }

  removeClient(id) {
    this.#clients.delete(id)
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
    if (!this.#rooms.has(room)) return
    for (const clientId of this.#rooms.get(room)) {
      const client = this.#clients.get(clientId)
      if (client) client.send(data)
    }
  }

  toRoomBinary(room, data) {
    if (!this.#rooms.has(room)) return
    for (const clientId of this.#rooms.get(room)) {
      const client = this.#clients.get(clientId)
      if (client) client.sendBinary(data)
    }
  }

  broadcast(data, excludeId = null) {
    for (const [id, client] of this.#clients) {
      if (id !== excludeId) client.send(data)
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
