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
const ProxySocket = require('../../src/Server/ProxySocket.js')

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
  // Invoke the listener Server.init() added directly: emitting on the real
  // process would also reach Jest's own handlers.
  function added(event) {
    return process.listeners(event).find(l => !processListeners[event].includes(l))
  }

  let originalArgv
  let processListeners

  beforeEach(() => {
    originalArgv = process.argv
    process.argv = ['node', 'index.js', '0']
    processListeners = {
      message: process.listeners('message'),
      SIGTERM: process.listeners('SIGTERM'),
      SIGINT: process.listeners('SIGINT'),
      unhandledRejection: process.listeners('unhandledRejection'),
      uncaughtException: process.listeners('uncaughtException')
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

    it('logs an unhandled rejection without shutting down', async () => {
      added('unhandledRejection')(new Error('stray promise'))
      await new Promise(resolve => setImmediate(resolve))

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('stray promise'))
      expect(order).toEqual([])
      expect(process.exit).not.toHaveBeenCalled()
    })

    it('flushes and exits 1 after an uncaught exception', async () => {
      added('uncaughtException')(new Error('primary bug'))
      await new Promise(resolve => setImmediate(resolve))

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"level":"FATAL"'))
      expect(order).toEqual(['database', 'ipc', 'storage'])
      expect(process.exit).toHaveBeenCalledWith(1)
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
        Database: {close: jest.fn(async () => {})},
        Storage: {close: jest.fn(async () => {})}
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

    it('commits pending session writes before exiting', async () => {
      shutdown()
      await server.close.mock.calls[0][0]()

      expect(global.Odac.Storage.close).toHaveBeenCalled()
      expect(global.Odac.Storage.close.mock.invocationCallOrder[0]).toBeLessThan(process.exit.mock.invocationCallOrder[0])
    })

    it('ignores a repeated shutdown message', () => {
      shutdown()
      shutdown()

      expect(server.close).toHaveBeenCalledTimes(1)
    })

    // Application code outside framework dispatch (timer callbacks, detached
    // promises) used to take the whole worker down with one rejection.
    it('logs an unhandled rejection and keeps serving', () => {
      expect(() => added('unhandledRejection')(new Error('async interval bug'))).not.toThrow()

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('async interval bug'))
      expect(server.close).not.toHaveBeenCalled()
      expect(process.exit).not.toHaveBeenCalled()
    })

    it('logs a non-Error rejection reason', () => {
      added('unhandledRejection')('plain string')

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('plain string'))
    })

    it('drains and exits 1 after an uncaught exception', async () => {
      added('uncaughtException')(new Error('timer bug'))

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"level":"FATAL"'))
      expect(server.close).toHaveBeenCalledTimes(1)
      expect(global.Odac.Route.wsServer.closeAll).toHaveBeenCalledWith(1001, expect.any(String))

      await server.close.mock.calls[0][0]()

      expect(global.Odac.Database.close).toHaveBeenCalled()
      expect(global.Odac.Storage.close).toHaveBeenCalled()
      expect(process.exit).toHaveBeenCalledWith(1)
    })

    it('exits 1 when the crash drain never completes', () => {
      added('uncaughtException')(new Error('timer bug'))
      jest.advanceTimersByTime(14999)
      expect(process.exit).not.toHaveBeenCalled()

      jest.advanceTimersByTime(1)

      expect(process.exit).toHaveBeenCalledWith(1)
    })

    it('does not start a second drain on a repeated exception', () => {
      added('uncaughtException')(new Error('first'))
      added('uncaughtException')(new Error('second'))

      expect(server.close).toHaveBeenCalledTimes(1)
    })
  })

  // A worker that crashes during startup used to be re-forked immediately, in
  // a tight loop. A listen failure (port taken, no permission) can never
  // succeed on retry, so it stops the app instead of looping.
  describe('primary worker supervision', () => {
    let nextId

    beforeEach(() => {
      jest.useFakeTimers()
      cluster.isPrimary = true
      cluster.workers = {}
      nextId = 1
      cluster.fork.mockReset()
      cluster.fork.mockImplementation(() => ({id: nextId++}))
      global.Odac = {
        Config: {debug: true},
        Route: {stopCron: jest.fn()},
        Storage: {startSessionGC: jest.fn(), stopSessionGC: jest.fn(), close: jest.fn()},
        Ipc: {close: jest.fn(async () => {})},
        Database: {close: jest.fn(async () => {})}
      }
      jest.spyOn(process, 'exit').mockImplementation(() => {})
      Server.init()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    const crash = (id, code = 1) => cluster.emit('exit', {id}, code, null)

    it('respawns a long-running worker immediately', () => {
      jest.advanceTimersByTime(60000)
      crash(1)
      jest.advanceTimersByTime(0)

      expect(cluster.fork).toHaveBeenCalledTimes(2)
    })

    it('backs off exponentially while workers keep crashing at startup', () => {
      crash(1)
      jest.advanceTimersByTime(999)
      expect(cluster.fork).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(1)
      expect(cluster.fork).toHaveBeenCalledTimes(2)

      crash(2)
      jest.advanceTimersByTime(1999)
      expect(cluster.fork).toHaveBeenCalledTimes(2)
      jest.advanceTimersByTime(1)
      expect(cluster.fork).toHaveBeenCalledTimes(3)
    })

    it('caps the backoff at 30 seconds', () => {
      for (let i = 1; i <= 10; i++) {
        crash(i)
        jest.advanceTimersByTime(30000)
      }
      const forks = cluster.fork.mock.calls.length
      crash(nextId - 1)
      jest.advanceTimersByTime(30000)

      expect(cluster.fork).toHaveBeenCalledTimes(forks + 1)
    })

    it('resets the backoff once a worker stays up', () => {
      crash(1)
      jest.advanceTimersByTime(1000)
      crash(2)
      jest.advanceTimersByTime(2000)
      jest.advanceTimersByTime(60000)
      crash(3)
      jest.advanceTimersByTime(0)

      expect(cluster.fork).toHaveBeenCalledTimes(4)
    })

    it('stops the app instead of respawning after a fatal listen error', async () => {
      crash(1, 78)
      jest.advanceTimersByTime(60000)
      await jest.runOnlyPendingTimersAsync()

      expect(cluster.fork).toHaveBeenCalledTimes(1)
      expect(process.exit).toHaveBeenCalledWith(1)
    })
  })

  describe('worker server errors', () => {
    let server

    beforeEach(() => {
      cluster.isPrimary = false
      server = makeFakeServer()
      http.createServer.mockReturnValue(server)
      global.Odac = {Config: {debug: true}, Route: {}}
      jest.spyOn(process, 'exit').mockImplementation(() => {})
      Server.init()
    })

    // A cluster worker gets the primary's handle error, reported as 'bind'.
    it.each([
      ['listen', 'listen EADDRINUSE: address already in use :::3000'],
      ['bind', 'bind EADDRINUSE null:3000']
    ])('exits with the fatal code when the port cannot be bound (%s)', (syscall, message) => {
      const err = Object.assign(new Error(message), {code: 'EADDRINUSE', syscall})

      expect(() => server.emit('error', err)).not.toThrow()
      expect(process.exit).toHaveBeenCalledWith(78)
    })

    it('logs other server errors without exiting', () => {
      expect(() => server.emit('error', new Error('boom'))).not.toThrow()
      expect(process.exit).not.toHaveBeenCalled()
      expect(console.error).toHaveBeenCalled()
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

  // ODAC_PROXY_SOCKET: the primary owns the socket's listening handle in a cluster, so it
  // clears a stale file once before forking and tells workers what to serve.
  describe('proxy socket in the primary', () => {
    const target = '/odac-proxy/http.sock'
    let originalEnv

    beforeEach(() => {
      originalEnv = process.env.ODAC_PROXY_SOCKET
      cluster.isPrimary = true
      cluster.workers = {}
      cluster.fork.mockReset()
      cluster.fork.mockImplementation(() => ({id: 1}))
      global.Odac = {
        Config: {debug: true},
        Route: {stopCron: jest.fn()},
        Storage: {startSessionGC: jest.fn(), stopSessionGC: jest.fn(), close: jest.fn()},
        Ipc: {close: jest.fn(async () => {})},
        Database: {close: jest.fn(async () => {})}
      }
      jest.spyOn(process, 'exit').mockImplementation(() => {})
    })

    afterEach(() => {
      if (originalEnv === undefined) delete process.env.ODAC_PROXY_SOCKET
      else process.env.ODAC_PROXY_SOCKET = originalEnv
    })

    const flush = () => new Promise(resolve => setImmediate(resolve))

    it('forks at once and never touches a socket when the variable is absent', () => {
      delete process.env.ODAC_PROXY_SOCKET
      const prepare = jest.spyOn(ProxySocket, 'prepare')

      Server.init()

      expect(prepare).not.toHaveBeenCalled()
      expect(cluster.fork).toHaveBeenCalledWith(undefined)
    })

    it('clears the stale file before forking and hands workers the resolved path', async () => {
      process.env.ODAC_PROXY_SOCKET = target
      let resolvePrepare
      jest.spyOn(ProxySocket, 'prepare').mockReturnValue(new Promise(resolve => (resolvePrepare = resolve)))

      Server.init()
      expect(cluster.fork).not.toHaveBeenCalled()

      resolvePrepare(target)
      await flush()

      expect(cluster.fork).toHaveBeenCalledWith({ODAC_PROXY_SOCKET: target})
    })

    it('keeps workers on TCP only when the path cannot be used', async () => {
      process.env.ODAC_PROXY_SOCKET = target
      jest.spyOn(ProxySocket, 'prepare').mockResolvedValue(null)

      Server.init()
      await flush()

      expect(cluster.fork).toHaveBeenCalledWith({ODAC_PROXY_SOCKET: ''})
    })

    it('respawns workers with the same decision', async () => {
      jest.useFakeTimers()
      try {
        process.env.ODAC_PROXY_SOCKET = target
        jest.spyOn(ProxySocket, 'prepare').mockResolvedValue(target)
        Server.init()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        jest.advanceTimersByTime(60000)
        cluster.emit('exit', {id: 1}, 1, null)
        jest.advanceTimersByTime(0)

        expect(cluster.fork).toHaveBeenCalledTimes(2)
        expect(cluster.fork).toHaveBeenLastCalledWith({ODAC_PROXY_SOCKET: target})
      } finally {
        jest.useRealTimers()
      }
    })

    it('removes the socket it bound once every worker has stopped', async () => {
      process.env.ODAC_PROXY_SOCKET = target
      const identity = {dev: 1n, ino: 2n}
      jest.spyOn(ProxySocket, 'prepare').mockResolvedValue(target)
      const identify = jest.spyOn(ProxySocket, 'identify').mockResolvedValue(identity)
      const release = jest.spyOn(ProxySocket, 'release').mockResolvedValue()
      Server.init()
      await flush()

      cluster.emit('listening', {id: 1}, {addressType: 4, address: null, port: 1071})
      cluster.emit('listening', {id: 1}, {addressType: -1, address: target, port: -1})
      await flush()
      expect(identify).toHaveBeenCalledTimes(1)

      added('SIGTERM')()
      await flush()

      expect(release).toHaveBeenCalledWith(target, identity)
      expect(release.mock.invocationCallOrder[0]).toBeLessThan(global.Odac.Database.close.mock.invocationCallOrder[0])
      expect(process.exit).toHaveBeenCalledWith(0)
    })

    it('does not fork when shutdown starts while the path is being prepared', async () => {
      process.env.ODAC_PROXY_SOCKET = target
      let resolvePrepare
      jest.spyOn(ProxySocket, 'prepare').mockReturnValue(new Promise(resolve => (resolvePrepare = resolve)))
      const release = jest.spyOn(ProxySocket, 'release').mockResolvedValue()
      Server.init()

      added('SIGTERM')()
      resolvePrepare(target)
      await flush()

      expect(cluster.fork).not.toHaveBeenCalled()
      expect(release).not.toHaveBeenCalled()
    })
  })

  describe('proxy socket in a worker', () => {
    const target = '/odac-proxy/http.sock'
    let originalEnv
    let tcp
    let unix

    beforeEach(() => {
      originalEnv = process.env.ODAC_PROXY_SOCKET
      cluster.isPrimary = false
      tcp = makeFakeServer()
      unix = makeFakeServer()
      http.createServer.mockReset()
      http.createServer.mockReturnValueOnce(tcp).mockReturnValueOnce(unix)
      global.Odac = {
        Config: {debug: true},
        instance: jest.fn(() => ({})),
        Route: {request: jest.fn(), handleWebSocketUpgrade: jest.fn(), wsServer: {closeAll: jest.fn()}},
        Ipc: {close: jest.fn(async () => {})},
        Database: {close: jest.fn(async () => {})},
        Storage: {close: jest.fn(async () => {})}
      }
      jest.spyOn(Stream, 'closeAll').mockImplementation(() => {})
      jest.spyOn(process, 'exit').mockImplementation(() => {})
    })

    afterEach(() => {
      if (originalEnv === undefined) delete process.env.ODAC_PROXY_SOCKET
      else process.env.ODAC_PROXY_SOCKET = originalEnv
    })

    function shutdown() {
      return added('message')('shutdown')
    }

    it('creates only the TCP server when the primary passed an empty value', () => {
      process.env.ODAC_PROXY_SOCKET = ''
      Server.init()

      expect(http.createServer).toHaveBeenCalledTimes(1)
      expect(tcp.listen).toHaveBeenCalledWith(0)
    })

    it('serves the same handlers on the socket, opened before the TCP port', () => {
      process.env.ODAC_PROXY_SOCKET = target
      Server.init()

      expect(http.createServer).toHaveBeenCalledTimes(2)
      expect(http.createServer.mock.calls[1][0]).toBe(http.createServer.mock.calls[0][0])
      expect(unix.listen).toHaveBeenCalledWith(target)
      expect(tcp.listen).toHaveBeenCalledWith(0)
      expect(unix.listen.mock.invocationCallOrder[0]).toBeLessThan(tcp.listen.mock.invocationCallOrder[0])
      expect(unix.listeners('upgrade')).toEqual(tcp.listeners('upgrade'))
      expect(unix.keepAliveTimeout).toBe(tcp.keepAliveTimeout)
      expect(unix.requestTimeout).toBe(tcp.requestTimeout)
    })

    it('routes a WebSocket upgrade on the socket like one on TCP', () => {
      process.env.ODAC_PROXY_SOCKET = target
      Server.init()
      const req = {headers: {host: 'example.com'}}
      const socket = makeSocket()

      unix.emit('upgrade', req, socket, Buffer.alloc(0))

      expect(global.Odac.Route.handleWebSocketUpgrade).toHaveBeenCalledWith(req, socket, expect.any(Buffer), expect.anything())
    })

    it('keeps serving TCP when the socket cannot be bound', () => {
      process.env.ODAC_PROXY_SOCKET = target
      Server.init()

      const err = Object.assign(new Error('bind EADDRINUSE ' + target), {code: 'EADDRINUSE', syscall: 'bind'})
      expect(() => unix.emit('error', err)).not.toThrow()

      expect(process.exit).not.toHaveBeenCalled()
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('serving on TCP only'))
    })

    it('closes both listeners and exits only after both have closed', async () => {
      process.env.ODAC_PROXY_SOCKET = target
      Server.init()
      shutdown()

      expect(tcp.close).toHaveBeenCalledTimes(1)
      expect(unix.close).toHaveBeenCalledTimes(1)
      expect(tcp.closeIdleConnections).toHaveBeenCalled()
      expect(unix.closeIdleConnections).toHaveBeenCalled()

      await tcp.close.mock.calls[0][0]()
      expect(global.Odac.Ipc.close).not.toHaveBeenCalled()
      expect(process.exit).not.toHaveBeenCalled()

      await unix.close.mock.calls[0][0]()
      expect(global.Odac.Ipc.close).toHaveBeenCalled()
      expect(process.exit).toHaveBeenCalledWith(0)
    })

    it('force-closes busy connections on both listeners after the grace period', () => {
      jest.useFakeTimers()
      try {
        process.env.ODAC_PROXY_SOCKET = target
        Server.init()
        shutdown()

        jest.advanceTimersByTime(10000)

        expect(tcp.closeAllConnections).toHaveBeenCalled()
        expect(unix.closeAllConnections).toHaveBeenCalled()
      } finally {
        jest.useRealTimers()
      }
    })
  })
})
