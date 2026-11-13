const fs = require('fs')
const http = require('http')
const net = require('net')
const path = require('path')

// Server.init() as a worker with real listeners: the TCP port and the ODAC proxy's unix socket
// serve the same app, and only the socket counts as the proxy without an address check.
// cluster is mocked to take the worker branch; net still sees a plain process and binds directly.

jest.mock('node:cluster', () => {
  const {EventEmitter} = require('events')
  const cluster = new EventEmitter()
  cluster.isPrimary = false
  cluster.workers = {}
  return cluster
})

const Server = require('../../src/Server.js')
const OdacRequest = require('../../src/Request')
const {WebSocketServer} = require('../../src/WebSocket')
const {tempDir} = require('./ProxySocket/helpers')

const realCreateServer = http.createServer

function request(options) {
  return new Promise((resolve, reject) => {
    http
      .get({path: '/', agent: false, ...options}, res => {
        let body = ''
        res.on('data', chunk => (body += chunk))
        res.on('end', () => resolve(JSON.parse(body)))
      })
      .on('error', reject)
  })
}

// Minimal WebSocket client: performs the upgrade and returns the first text frame's payload.
function firstWebSocketMessage(socketPath, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({path: socketPath})
    let buffer = Buffer.alloc(0)
    socket.on('error', reject)
    socket.on('connect', () => {
      const lines = [
        'GET /ws HTTP/1.1',
        'Host: example.com',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
      ]
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      const status = buffer.subarray(0, buffer.indexOf('\r\n')).toString()
      const frame = buffer.subarray(end + 4)
      if (frame.length < 2) return
      const length = frame[1] & 0x7f
      if (frame.length < 2 + length) return
      socket.destroy()
      resolve({status, opcode: frame[0] & 0x0f, payload: JSON.parse(frame.subarray(2, 2 + length).toString())})
    })
  })
}

describe('Server.init() with ODAC_PROXY_SOCKET', () => {
  const forwarded = {'x-odac-connection-remoteaddress': '203.0.113.7', 'x-odac-connection-ssl': 'true'}
  let originalArgv
  let originalEnv
  let processListeners
  let created
  let exited
  let dir
  let target

  function added(event) {
    return process.listeners(event).find(l => !processListeners[event].includes(l))
  }

  function describeRequest(req) {
    const request = new OdacRequest('id', req, null, {})
    return {ip: request.ip, ssl: request.ssl, fromTrustedProxy: request.fromTrustedProxy}
  }

  beforeEach(() => {
    originalArgv = process.argv
    originalEnv = process.env.ODAC_PROXY_SOCKET
    process.argv = ['node', 'index.js', '0']
    processListeners = Object.fromEntries(
      ['message', 'unhandledRejection', 'uncaughtException'].map(event => [event, process.listeners(event)])
    )
    dir = tempDir()
    target = path.join(dir, 'http.sock')
    created = []
    jest.spyOn(http, 'createServer').mockImplementation((...args) => {
      const server = realCreateServer(...args)
      created.push(server)
      return server
    })
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(console, 'log').mockImplementation(() => {})
    exited = new Promise(resolve => jest.spyOn(process, 'exit').mockImplementation(code => resolve(code)))

    const wsServer = new WebSocketServer()
    wsServer.route('/ws', (client, Odac) => {
      client.resume()
      client.send(JSON.stringify({ip: Odac.Request.ip, ssl: Odac.Request.ssl, fromTrustedProxy: Odac.Request.fromTrustedProxy}))
    })
    global.Odac = {
      // An empty list trusts no address, so only the socket rule can make a request trusted.
      Config: {debug: true, request: {timeout: 5000, trustedProxies: []}},
      Route: {
        routes: {www: {}},
        request: (req, res) => res.end(JSON.stringify(describeRequest(req))),
        handleWebSocketUpgrade: (req, socket, head, param) => wsServer.handleUpgrade(req, socket, head, param),
        wsServer
      },
      instance: (id, req) => ({Request: new OdacRequest(id, req, null, {})}),
      Ipc: {close: jest.fn(async () => {})},
      Database: {close: jest.fn(async () => {})},
      Storage: {close: jest.fn(async () => {})}
    }
  })

  afterEach(async () => {
    // Upgraded sockets are outside the HTTP server's connection list but still hold close().
    for (const client of [...global.Odac.Route.wsServer.clients.values()]) client.terminate()
    for (const server of created) {
      server.closeAllConnections()
      if (server.listening) await new Promise(resolve => server.close(resolve))
    }
    process.argv = originalArgv
    if (originalEnv === undefined) delete process.env.ODAC_PROXY_SOCKET
    else process.env.ODAC_PROXY_SOCKET = originalEnv
    for (const [event, listeners] of Object.entries(processListeners)) {
      for (const listener of process.listeners(event)) if (!listeners.includes(listener)) process.removeListener(event, listener)
    }
    jest.restoreAllMocks()
    delete global.Odac
    fs.rmSync(dir, {recursive: true, force: true})
  })

  async function start() {
    Server.init()
    await Promise.all(created.map(server => new Promise(resolve => (server.listening ? resolve() : server.once('listening', resolve)))))
    return {tcp: created[0], port: created[0].address().port}
  }

  it('serves the app on both the TCP port and the socket', async () => {
    process.env.ODAC_PROXY_SOCKET = target
    const {port} = await start()

    expect(created).toHaveLength(2)
    expect(fs.lstatSync(target).isSocket()).toBe(true)
    expect(await request({host: '127.0.0.1', port})).toEqual(expect.objectContaining({fromTrustedProxy: false}))
    expect(await request({socketPath: target})).toEqual(expect.objectContaining({fromTrustedProxy: true}))
  })

  it('honours the proxy headers over the socket but not from an untrusted TCP peer', async () => {
    process.env.ODAC_PROXY_SOCKET = target
    const {port} = await start()

    expect(await request({socketPath: target, headers: forwarded})).toEqual({ip: '203.0.113.7', ssl: true, fromTrustedProxy: true})
    expect(await request({host: '127.0.0.1', port, headers: forwarded})).toEqual({ip: '127.0.0.1', ssl: false, fromTrustedProxy: false})
  })

  it('runs WebSocket upgrades over the socket with the proxy trusted', async () => {
    process.env.ODAC_PROXY_SOCKET = target
    await start()

    const message = await firstWebSocketMessage(target, {
      'X-Odac-Connection-RemoteAddress': '203.0.113.7',
      'X-Odac-Connection-Ssl': 'true'
    })

    expect(message.status).toBe('HTTP/1.1 101 Switching Protocols')
    expect(message.opcode).toBe(1)
    expect(message.payload).toEqual({ip: '203.0.113.7', ssl: true, fromTrustedProxy: true})
  })

  it('keeps serving TCP when the socket cannot be created', async () => {
    process.env.ODAC_PROXY_SOCKET = path.join(dir, 'missing', 'http.sock')
    Server.init()
    await new Promise(resolve => created[0].once('listening', resolve))
    await new Promise(resolve => setImmediate(resolve))

    expect(created[1].listening).toBe(false)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('serving on TCP only'))
    expect(await request({host: '127.0.0.1', port: created[0].address().port})).toEqual(expect.objectContaining({ip: '127.0.0.1'}))
    expect(process.exit).not.toHaveBeenCalled()

    added('message')('shutdown')
    expect(await exited).toBe(0)
  })

  it('closes both listeners on shutdown and leaves no socket file behind', async () => {
    process.env.ODAC_PROXY_SOCKET = target
    await start()
    await request({socketPath: target})

    added('message')('shutdown')

    expect(await exited).toBe(0)
    expect(created.every(server => !server.listening)).toBe(true)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('serves TCP only and creates no socket when the variable is absent', async () => {
    delete process.env.ODAC_PROXY_SOCKET
    const {port} = await start()

    expect(created).toHaveLength(1)
    expect(fs.readdirSync(dir)).toEqual([])
    expect(await request({host: '127.0.0.1', port, headers: forwarded})).toEqual({ip: '127.0.0.1', ssl: false, fromTrustedProxy: false})
  })
})
