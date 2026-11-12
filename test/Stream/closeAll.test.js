const {EventEmitter} = require('events')
const Stream = require('../../src/Stream.js')

// An open SSE response keeps its socket alive, so server.close() never calls
// back and the worker sits until the primary's hard timeout kills it, skipping
// the final flush. Stream.closeAll() lets shutdown end every open stream.

function makePair() {
  const req = new EventEmitter()
  req.setTimeout = jest.fn()
  const res = new EventEmitter()
  res.headersSent = false
  res.writableEnded = false
  res.setTimeout = jest.fn()
  res.setHeader = jest.fn()
  res.write = jest.fn()
  res.end = jest.fn(() => {
    res.writableEnded = true
  })
  return {req, res}
}

describe('Stream.closeAll()', () => {
  afterEach(() => Stream.closeAll())

  it('ends every open stream', () => {
    const a = makePair()
    const b = makePair()
    new Stream(a.req, a.res, () => {})
    new Stream(b.req, b.res, () => {})

    Stream.closeAll()

    expect(a.res.end).toHaveBeenCalled()
    expect(b.res.end).toHaveBeenCalled()
  })

  it('forgets streams that already closed on their own', () => {
    const a = makePair()
    const stream = new Stream(a.req, a.res, () => {})
    stream.close()
    a.res.end.mockClear()

    Stream.closeAll()

    expect(a.res.end).not.toHaveBeenCalled()
  })

  it('runs cleanup for each closed stream', () => {
    const a = makePair()
    const odac = {cleanup: jest.fn()}
    new Stream(a.req, a.res, () => {}, odac)

    Stream.closeAll()

    expect(odac.cleanup).toHaveBeenCalledTimes(1)
  })
})
