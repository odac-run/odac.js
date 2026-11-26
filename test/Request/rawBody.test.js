const crypto = require('crypto')
const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')

function makeReq(overrides = {}) {
  const req = new PassThrough()
  req.method = overrides.method || 'POST'
  req.url = overrides.url || '/webhook'
  req.headers = Object.assign({host: 'www.example.com'}, overrides.headers)
  req.connection = {remoteAddress: '127.0.0.1', destroy: jest.fn()}
  return req
}

function makeRes() {
  const listeners = {}
  return {
    writeHead: jest.fn(),
    end: jest.fn(),
    finished: false,
    on: jest.fn((event, fn) => {
      listeners[event] = fn
    }),
    emit: event => listeners[event]?.()
  }
}

let openRequests = []

function build(overrides) {
  const req = makeReq(overrides)
  const res = makeRes()
  const request = new OdacRequest('id', req, res, {setTimeout: (fn, ms) => setTimeout(fn, ms)})
  openRequests.push(request)
  return {req, res, request}
}

describe('Request.rawBody()', () => {
  beforeEach(() => {
    openRequests = []
    global.Odac = {
      Config: {request: {timeout: 5000, maxBodySize: 1e6}},
      Route: {routes: {www: {}}},
      Request: {}
    }
  })

  afterEach(() => {
    for (const r of openRequests) r.clearTimeout()
    openRequests = []
    delete global.Odac
  })

  it('returns the exact wire bytes as a Buffer for JSON bodies while preserving parsed post data', async () => {
    const payload = '{\n  "b": 1,\n  "a": "hello"\n}'
    const {req, request} = build({headers: {'content-type': 'application/json'}})
    const pending = request.rawBody()
    req.end(payload)

    const raw = await pending
    expect(Buffer.isBuffer(raw)).toBe(true)
    expect(raw.equals(Buffer.from(payload))).toBe(true)
    // Parsed object stays available alongside rawBody().
    expect(await request.request()).toEqual({b: 1, a: 'hello'})
  })

  it('produces an exact HMAC-SHA256 match over chunked multi-byte payloads', async () => {
    const secret = 'whsec_test_secret'
    const payload = '{"event":"invoice.paid","city":"İstanbul","amount":1999}'
    const expectedHmac = crypto.createHmac('sha256', secret).update(payload).digest('hex')

    const {req, request} = build({headers: {'content-type': 'application/json'}})
    const bytes = Buffer.from(payload, 'utf8')
    // Split in the middle of the multi-byte 'İ' character.
    const splitAt = bytes.indexOf(0xc4) + 1
    req.write(bytes.subarray(0, splitAt))
    req.end(bytes.subarray(splitAt))

    const raw = await request.rawBody()
    const computedHmac = crypto.createHmac('sha256', secret).update(raw).digest('hex')
    expect(computedHmac).toBe(expectedHmac)
  })

  it('preserves arbitrary binary bytes without UTF-8 corruption', async () => {
    const binary = Buffer.from([0x80, 0xff, 0x00, 0xfe, 0x01, 0xc3])
    const {req, request} = build({headers: {'content-type': 'application/octet-stream'}})
    req.end(binary)

    const raw = await request.rawBody()
    expect(Buffer.isBuffer(raw)).toBe(true)
    expect(raw.equals(binary)).toBe(true)
  })

  it('decodes the raw body when a valid Buffer encoding is provided', async () => {
    const payload = 'raw=1&order=preserved'
    const {req, request} = build({headers: {'content-type': 'application/x-www-form-urlencoded'}})
    req.end(payload)

    expect(await request.rawBody('utf8')).toBe(payload)
    expect(await request.rawBody('base64')).toBe(Buffer.from(payload).toString('base64'))
    expect(await request.rawBody('hex')).toBe(Buffer.from(payload).toString('hex'))
  })

  it('resolves immediately when called after the body has already finished', async () => {
    const {req, request} = build({headers: {'content-type': 'application/json'}})
    req.end('{"done":true}')
    await request.request('_odac_form_token')

    const raw = await request.rawBody('utf8')
    expect(raw).toBe('{"done":true}')
  })

  it('returns an empty Buffer (or empty string with encoding) for an empty body', async () => {
    const {req, request} = build({headers: {'content-type': 'application/json'}})
    const pending = request.rawBody()
    req.end()

    const raw = await pending
    expect(Buffer.isBuffer(raw)).toBe(true)
    expect(raw.length).toBe(0)
    expect(await request.rawBody('utf8')).toBe('')
  })

  it('returns null immediately for multipart/form-data without buffering or hanging', async () => {
    const {request} = build({headers: {'content-type': 'multipart/form-data; boundary=----odac'}})
    await expect(request.rawBody()).resolves.toBeNull()
    await expect(request.rawBody('utf8')).resolves.toBeNull()
  })

  it('returns null and releases pending waiters when the body exceeds maxBodySize (413)', async () => {
    global.Odac.Config.request.maxBodySize = 4
    const {req, res, request} = build({headers: {'content-type': 'application/json'}})
    const pending = request.rawBody()
    req.write('{"too":"large"}')

    await expect(pending).resolves.toBeNull()
    expect(res.writeHead).toHaveBeenCalledWith(413, expect.anything())
  })

  it('releases the buffered raw body when the response ends or closes', async () => {
    const {req, request} = build({headers: {'content-type': 'application/json'}})
    req.end('{"secret":"value"}')
    expect(await request.rawBody('utf8')).toBe('{"secret":"value"}')

    request.end('ok')
    expect(await request.rawBody()).toBeNull()

    const closed = build({headers: {'content-type': 'application/json'}})
    closed.res.emit('close')
    closed.req.end('{"late":"bytes"}')
    expect(await closed.request.rawBody()).toBeNull()
  })

  it.each(['not-an-encoding', '', null, 123])('rejects with TypeError for invalid encoding %p', async badEncoding => {
    const {req, request} = build({headers: {'content-type': 'application/json'}})
    req.end('{}')
    await expect(request.rawBody(badEncoding)).rejects.toThrow(TypeError)
  })
})
