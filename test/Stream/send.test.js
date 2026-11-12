const {EventEmitter} = require('events')
const Stream = require('../../src/Stream.js')

// Each payload line needs its own data: field; otherwise a blank line in the payload ends the
// event early and the following lines are parsed as fields of a new, injected event.
// Iterator and stream inputs stop at a full socket buffer until it drains.

function makeRes({full = () => false} = {}) {
  const res = new EventEmitter()
  res.headersSent = false
  res.writableEnded = false
  res.setTimeout = jest.fn()
  res.setHeader = jest.fn()
  res.writes = []
  res.write = jest.fn(chunk => {
    res.writes.push(chunk)
    return !full(res.writes.length)
  })
  res.end = jest.fn(() => {
    res.writableEnded = true
  })
  return res
}

function makeReq() {
  const req = new EventEmitter()
  req.setTimeout = jest.fn()
  return req
}

const tick = () => new Promise(resolve => setImmediate(resolve))

describe('Stream.send()', () => {
  afterEach(() => Stream.closeAll())

  it('prefixes every line so a payload cannot inject an event', () => {
    const res = makeRes()
    const stream = new Stream(makeReq(), res)
    stream.send('hello\n\nevent: admin\ndata: forged')
    expect(res.writes).toEqual(['data: hello\ndata: \ndata: event: admin\ndata: data: forged\n\n'])
  })

  it('handles CR and CRLF line breaks', () => {
    const res = makeRes()
    new Stream(makeReq(), res).send('a\r\nb\rc')
    expect(res.writes).toEqual(['data: a\ndata: b\ndata: c\n\n'])
  })

  it('serializes objects on one line', () => {
    const res = makeRes()
    new Stream(makeReq(), res).send({text: 'a\nb'})
    expect(res.writes).toEqual(['data: {"text":"a\\nb"}\n\n'])
  })

  it('waits for drain before pulling more from an async iterator', async () => {
    const res = makeRes({full: n => n === 1})
    let pulled = 0
    async function* source() {
      for (let i = 0; i < 3; i++) {
        pulled++
        yield i
      }
    }
    new Stream(makeReq(), res, source())
    await tick()
    expect(pulled).toBe(1)

    res.emit('drain')
    await tick()
    expect(pulled).toBe(3)
    expect(res.end).toHaveBeenCalled()
  })

  it('waits for drain before continuing a sync iterator', async () => {
    const res = makeRes({full: n => n === 2})
    function* source() {
      for (let i = 0; i < 5; i++) yield i
    }
    new Stream(makeReq(), res, source())
    await tick()
    expect(res.writes).toHaveLength(2)

    res.emit('drain')
    await tick()
    expect(res.writes).toHaveLength(5)
    expect(res.end).toHaveBeenCalled()
  })

  it('stops reading a readable input while the socket buffer is full', async () => {
    const {PassThrough} = require('stream')
    const res = makeRes({full: n => n === 1})
    const input = new PassThrough()
    new Stream(makeReq(), res, input)
    input.write('one')
    await tick()
    input.write('two')
    await tick()
    expect(res.writes).toEqual(['data: one\n\n'])

    res.emit('drain')
    await tick()
    expect(res.writes).toEqual(['data: one\n\n', 'data: two\n\n'])
  })

  it('pauses a pipe-only source until the socket drains', async () => {
    const res = makeRes({full: n => n === 1})
    const input = new EventEmitter()
    input.pipe = jest.fn()
    input.pause = jest.fn()
    input.resume = jest.fn()
    new Stream(makeReq(), res, input)

    input.emit('data', Buffer.from('one'))
    expect(input.pause).toHaveBeenCalled()
    expect(input.resume).not.toHaveBeenCalled()

    res.emit('drain')
    await tick()
    expect(input.resume).toHaveBeenCalled()
  })
})
