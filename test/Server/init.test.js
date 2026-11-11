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

function makeFakeServer() {
  const server = new EventEmitter()
  server.listen = jest.fn()
  server.close = jest.fn()
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
