const {EventEmitter} = require('events')

// Server.init() wires the worker HTTP server and the primary shutdown path.
// http and cluster are mocked so the listeners can be driven directly without
// binding a port or forking.

jest.mock('http', () => ({createServer: jest.fn()}))
jest.mock('node:cluster', () => {
  const {EventEmitter} = require('events')
  const cluster = new EventEmitter()
  cluster.isPrimary = false
  cluster.workers = {}
  cluster.fork = jest.fn()
  return cluster
})

const http = require('http')
const cluster = require('node:cluster')
const Server = require('../../src/Server.js')
const Stream = require('../../src/Stream.js')

function makeFakeServer() {
  const server = new EventEmitter()
  server.listen = jest.fn()
  server.close = jest.fn()
  server.closeIdleConnections = jest.fn()
  server.closeAllConnections = jest.fn()
  return server
}

function makeSocket() {
  const socket = new EventEmitter()
  socket.write = jest.fn()
  socket.destroy = jest.fn()
  return socket
}

describe('Server.init()', () => {
  let originalArgv
  let processListeners

  beforeEach(() => {
    originalArgv = process.argv
    process.argv = ['node', 'index.js', '0']
    processListeners = {
      message: process.listeners('message'),
      SIGTERM: process.listeners('SIGTERM'),
      SIGINT: process.listeners('SIGINT')
    }
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    process.argv = originalArgv
    for (const [event, listeners] of Object.entries(processListeners)) {
      for (const listener of process.listeners(event)) {
        if (!listeners.includes(listener)) process.removeListener(event, listener)
      }
    }
    cluster.removeAllListeners()
    cluster.workers = {}
    jest.restoreAllMocks()
    delete global.Odac
  })

  // Buffered writes live in the IPC store until WriteBuffer flushes them, so
  // the database (whose close runs the final flush) must close before IPC.
  describe('primary graceful shutdown', () => {
    let order

    beforeEach(() => {
      cluster.isPrimary = true
      cluster.workers = {}
      order = []
      const track = name => jest.fn(async () => order.push(name))
      global.Odac = {
        Config: {debug: true},
        Route: {stopCron: jest.fn()},
        Storage: {startSessionGC: jest.fn(), stopSessionGC: jest.fn(), close: jest.fn(() => order.push('storage'))},
        Ipc: {close: track('ipc')},
        Database: {close: track('database')}
      }
      jest.spyOn(process, 'exit').mockImplementation(() => {})
      Server.init()
    })

    async function shutdown() {
      const listener = process.listeners('SIGTERM').find(l => !processListeners.SIGTERM.includes(l))
      listener()
      await new Promise(resolve => setImmediate(resolve))
    }

    it('closes the database before IPC so the final flush still sees buffered writes', async () => {
      await shutdown()

      expect(order).toEqual(['database', 'ipc', 'storage'])
      expect(process.exit).toHaveBeenCalledWith(0)
    })

    it('still closes IPC and storage when the database close fails', async () => {
      global.Odac.Database.close.mockImplementation(async () => {
        order.push('database')
        throw new Error('pool gone')
      })

      await shutdown()

      expect(order).toEqual(['database', 'ipc', 'storage'])
    })
  })

  // Open WebSocket and SSE connections keep server.close() from calling back.
  // The primary then kills the worker at its 30s hard timeout, and its final
  // flush never runs. The worker must end long-lived connections itself.
  describe('worker graceful shutdown', () => {
    let server

    beforeEach(() => {
      jest.useFakeTimers()
      cluster.isPrimary = false
      server = makeFakeServer()
      http.createServer.mockReturnValue(server)
      global.Odac = {
        Config: {debug: true},
        Route: {wsServer: {closeAll: jest.fn()}},
        Ipc: {close: jest.fn(async () => {})},
        Database: {close: jest.fn(async () => {})}
      }
      jest.spyOn(Stream, 'closeAll').mockImplementation(() => {})
      jest.spyOn(process, 'exit').mockImplementation(() => {})
      Server.init()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    function shutdown() {
      const listener = process.listeners('message').find(l => !processListeners.message.includes(l))
      return listener('shutdown')
    }

    it('stops accepting connections and drops idle keep-alive sockets', () => {
      shutdown()

      expect(server.close).toHaveBeenCalledTimes(1)
      expect(server.closeIdleConnections).toHaveBeenCalled()
    })

    it('closes WebSocket clients with 1001 and ends SSE streams', () => {
      shutdown()

      expect(global.Odac.Route.wsServer.closeAll).toHaveBeenCalledWith(1001, expect.any(String))
      expect(Stream.closeAll).toHaveBeenCalled()
    })

    it('force-closes connections still busy after the grace period', () => {
      shutdown()
      expect(server.closeAllConnections).not.toHaveBeenCalled()

      jest.advanceTimersByTime(10000)

      expect(server.closeAllConnections).toHaveBeenCalled()
    })

    it('releases resources and exits once the server has closed', async () => {
      shutdown()
      await server.close.mock.calls[0][0]()

      expect(global.Odac.Database.close).toHaveBeenCalled()
      expect(global.Odac.Ipc.close).toHaveBeenCalled()
      expect(process.exit).toHaveBeenCalledWith(0)
    })

    it('ignores a repeated shutdown message', () => {
      shutdown()
      shutdown()

      expect(server.close).toHaveBeenCalledTimes(1)
    })
  })

  describe('worker upgrade listener', () => {
    let server

    beforeEach(() => {
      cluster.isPrimary = false
      server = makeFakeServer()
      http.createServer.mockReturnValue(server)
      global.Odac = {
        Config: {debug: true},
        instance: jest.fn(() => ({})),
        Route: {handleWebSocketUpgrade: jest.fn()}
      }
      Server.init()
    })

    it('destroys the socket instead of throwing when request setup fails', () => {
      global.Odac.instance.mockImplementation(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'split')")
      })
      const socket = makeSocket()

      expect(() => server.emit('upgrade', {headers: {}}, socket, Buffer.alloc(0))).not.toThrow()
      expect(socket.destroy).toHaveBeenCalled()
      expect(global.Odac.Route.handleWebSocketUpgrade).not.toHaveBeenCalled()
    })

    it('destroys the socket instead of throwing when the upgrade handler fails', () => {
      global.Odac.Route.handleWebSocketUpgrade.mockImplementation(() => {
        throw new Error('boom')
      })
      const socket = makeSocket()

      expect(() => server.emit('upgrade', {headers: {host: 'example.com'}}, socket, Buffer.alloc(0))).not.toThrow()
      expect(socket.destroy).toHaveBeenCalled()
    })

    it('keeps an error listener on the raw socket so a reset cannot crash the worker', () => {
      const socket = makeSocket()
      server.emit('upgrade', {headers: {host: 'example.com'}}, socket, Buffer.alloc(0))

      expect(socket.listenerCount('error')).toBeGreaterThan(0)
      expect(() => socket.emit('error', Object.assign(new Error('read ECONNRESET'), {code: 'ECONNRESET'}))).not.toThrow()
    })

    it('hands a valid upgrade to the route layer', () => {
      const param = {Request: {}}
      global.Odac.instance.mockReturnValue(param)
      const req = {headers: {host: 'example.com'}}
      const socket = makeSocket()
      const head = Buffer.alloc(0)

      server.emit('upgrade', req, socket, head)

      expect(global.Odac.instance).toHaveBeenCalledWith(expect.any(String), req, null)
      expect(global.Odac.Route.handleWebSocketUpgrade).toHaveBeenCalledWith(req, socket, head, param)
      expect(socket.destroy).not.toHaveBeenCalled()
    })
  })
})
