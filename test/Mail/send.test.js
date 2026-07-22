// Mail.send() opens a Unix-socket connection to the Odac Core and resolves with
// the parsed response. It must never hang: if the socket closes without sending
// a response, or if no response arrives within a bounded time, send() must
// resolve(false) and tear the socket down. See IMPROVEMENT-PLAN 4.4.

jest.mock('net', () => {
  const {EventEmitter} = require('events')
  return {
    Socket: jest.fn(function () {
      const s = new EventEmitter()
      s.connect = jest.fn((path, cb) => {
        s._connectCb = cb
      })
      s.write = jest.fn()
      s.destroy = jest.fn()
      s.setTimeout = jest.fn((ms, cb) => {
        s._timeoutMs = ms
        s._timeoutCb = cb
      })
      global.__lastMailSocket = s
      return s
    })
  }
})

const Mail = require('../../src/Mail')

function makeMail() {
  return Mail().from('sender@example.com', 'Sender').subject('Hi').to('rcpt@example.com').html('<p>hi</p>')
}

// Lets the async executor inside send() run up to the point it creates and
// wires the socket.
const flush = () => new Promise(r => setImmediate(r))

describe('Mail.send()', () => {
  beforeEach(() => {
    delete global.__lastMailSocket
    global.Odac = {
      Config: {debug: false},
      Var: () => ({is: () => true})
    }
    global.__dir = process.cwd()
  })

  afterEach(() => {
    delete global.Odac
    delete global.__dir
    delete global.__lastMailSocket
  })

  it('resolves false when the socket closes without a response', async () => {
    const p = makeMail().send()
    await flush()
    const s = global.__lastMailSocket
    expect(s).toBeDefined()
    s.emit('close') // connection dropped before any data arrived
    await expect(p).resolves.toBe(false)
  })

  it('arms a socket timeout and resolves false (tearing down) if it fires', async () => {
    const p = makeMail().send()
    await flush()
    const s = global.__lastMailSocket
    expect(s.setTimeout).toHaveBeenCalled()
    expect(s._timeoutMs).toBeGreaterThan(0)
    s._timeoutCb() // simulate no response within the timeout window
    await expect(p).resolves.toBe(false)
    expect(s.destroy).toHaveBeenCalled()
  })
})
