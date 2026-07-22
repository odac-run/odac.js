const {WebSocketServer} = require('../../../src/WebSocket.js')

// In a clustered deploy every worker holds its own #clients/#rooms maps, so a
// broadcast/toRoom on worker A never reached clients on worker B. The server now
// bridges these fan-out calls across workers over Ipc pub/sub: each call is
// delivered locally AND published on a relay channel; every worker subscribes
// and re-delivers relayed messages to its own local clients (skipping its own
// echo to avoid double delivery). See IMPROVEMENT-PLAN 4.1.

const RELAY_CHANNEL = 'odac:ws:relay'

function makeIpc() {
  const subscribers = []
  return {
    publish: jest.fn(async () => {}),
    subscribe: jest.fn(async (channel, cb) => {
      subscribers.push({channel, cb})
      return {unsubscribe: () => {}}
    }),
    // Simulate a message arriving from another worker.
    deliver(channel, msg) {
      for (const s of subscribers) if (s.channel === channel) s.cb(msg)
    }
  }
}

describe('WebSocketServer cross-worker relay', () => {
  let server
  let ipc

  beforeEach(() => {
    server = new WebSocketServer()
    ipc = makeIpc()
    global.Odac = {Ipc: ipc}
  })

  afterEach(() => {
    delete global.Odac
  })

  it('broadcast delivers locally AND publishes a relay message', () => {
    const c1 = {id: 'c1', send: jest.fn()}
    server.clients.set('c1', c1)

    server.broadcast('hello')

    expect(c1.send).toHaveBeenCalledWith('hello') // local delivery preserved
    expect(ipc.publish).toHaveBeenCalledTimes(1)
    const [channel, msg] = ipc.publish.mock.calls[0]
    expect(channel).toBe(RELAY_CHANNEL)
    expect(msg.op).toBe('broadcast')
    expect(msg.origin).toBeDefined()
    expect(msg.payload).toEqual({binary: false, data: 'hello'})
  })

  it('re-delivers a broadcast relayed from another worker to local clients', () => {
    server.broadcast('warmup') // establishes the subscription
    ipc.publish.mockClear()

    const c2 = {id: 'c2', send: jest.fn()}
    server.clients.set('c2', c2)

    ipc.deliver(RELAY_CHANNEL, {op: 'broadcast', origin: 'other-worker', payload: {binary: false, data: 'remote-hi'}})

    expect(c2.send).toHaveBeenCalledWith('remote-hi') // delivered on this worker
    expect(ipc.publish).not.toHaveBeenCalled() // must not re-publish (no loop)
  })

  it('ignores its own echoed relay message (no double delivery)', () => {
    server.broadcast('x')
    const selfOrigin = ipc.publish.mock.calls[0][1].origin

    const c3 = {id: 'c3', send: jest.fn()}
    server.clients.set('c3', c3)

    ipc.deliver(RELAY_CHANNEL, {op: 'broadcast', origin: selfOrigin, payload: {binary: false, data: 'echo'}})

    expect(c3.send).not.toHaveBeenCalled()
  })

  it('relays toRoom and re-delivers to local room members on another worker', () => {
    server.broadcast('warmup') // subscribe
    const c = {id: 'c1', send: jest.fn()}
    server.clients.set('c1', c)
    server.joinRoom('c1', 'lobby')

    ipc.deliver(RELAY_CHANNEL, {op: 'room', origin: 'other-worker', room: 'lobby', payload: {binary: false, data: 'room-msg'}})

    expect(c.send).toHaveBeenCalledWith('room-msg')
  })

  it('relays binary room messages as base64 and reconstructs a Buffer on delivery', () => {
    server.broadcast('warmup') // subscribe
    const c = {id: 'c1', send: jest.fn(), sendBinary: jest.fn()}
    server.clients.set('c1', c)
    server.joinRoom('c1', 'r')

    const buf = Buffer.from([1, 2, 3, 250])
    ipc.deliver(RELAY_CHANNEL, {
      op: 'roomBinary',
      origin: 'other-worker',
      room: 'r',
      payload: {binary: true, data: buf.toString('base64')}
    })

    expect(c.sendBinary).toHaveBeenCalledTimes(1)
    const got = c.sendBinary.mock.calls[0][0]
    expect(Buffer.isBuffer(got)).toBe(true)
    expect(got.equals(buf)).toBe(true)
  })

  it('falls back to local-only delivery when Ipc is unavailable', () => {
    delete global.Odac
    const c1 = {id: 'c1', send: jest.fn()}
    server.clients.set('c1', c1)

    expect(() => server.broadcast('solo')).not.toThrow()
    expect(c1.send).toHaveBeenCalledWith('solo')
  })
})
