const fs = require('fs')
const os = require('os')
const path = require('path')
const {PassThrough} = require('stream')
const OdacRequest = require('../../src/Request')

const BOUNDARY = '----odacmultiparttest'

// Build a raw multipart/form-data body as a Buffer so binary parts (with \r\n
// and null bytes inside) survive intact — the regression case the old
// string-splitting parser corrupted.
function buildBody(parts) {
  const chunks = []
  for (const p of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`))
    if (p.filename !== undefined) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`))
      chunks.push(Buffer.from(`Content-Type: ${p.contentType || 'application/octet-stream'}\r\n\r\n`))
      chunks.push(p.data)
      chunks.push(Buffer.from('\r\n'))
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`))
      chunks.push(Buffer.from(`${p.value}\r\n`))
    }
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(chunks)
}

function makeReq() {
  const req = new PassThrough()
  req.method = 'POST'
  req.url = '/upload'
  req.headers = {
    host: 'www.example.com',
    'content-type': `multipart/form-data; boundary=${BOUNDARY}`
  }
  req.connection = {remoteAddress: '127.0.0.1', destroy: jest.fn()}
  return req
}

function makeRes() {
  return {writeHead: jest.fn(), end: jest.fn(), finished: false, on: jest.fn()}
}

describe('Request multipart parsing', () => {
  let tmpDir, request

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-mp-'))
    global.Odac = {
      Config: {request: {timeout: 5000, maxBodySize: 1e6, maxFileSize: 5 * 1024 * 1024, maxFiles: 10, uploadDir: tmpDir}},
      Route: {routes: {www: {}}},
      Request: {}
    }
    global.__dir = tmpDir
  })

  afterEach(() => {
    if (request) request.clearTimeout()
    request = null
    delete global.Odac
    delete global.__dir
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  function run(body) {
    const req = makeReq()
    const res = makeRes()
    request = new OdacRequest('id', req, res, {setTimeout: (fn, ms) => setTimeout(fn, ms)})
    req.end(body)
    return request
  }

  it('parses text fields into data.post', async () => {
    const r = run(buildBody([{name: 'title', value: 'hello world'}]))
    const val = await r.request('title')
    expect(val).toBe('hello world')
  })

  it('round-trips binary file content byte-for-byte', async () => {
    // Contains a PNG header, an embedded CRLF, and null bytes — exactly what the
    // old toString()-based parser mangled.
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0x0d, 0x0a, 0x42])
    const r = run(buildBody([{name: 'avatar', filename: 'photo.png', contentType: 'image/png', data: binary}]))

    const file = await r.file('avatar')
    expect(file).toBeTruthy()
    expect(file.name).toBe('photo.png')
    expect(file.ext).toBe('png')
    expect(file.mimetype).toBe('image/png')
    expect(file.size).toBe(binary.length)
    expect(file.truncated).toBe(false)

    const written = fs.readFileSync(file.path)
    expect(Buffer.compare(written, binary)).toBe(0)
  })

  it('mixes text fields and a file in one request', async () => {
    const r = run(
      buildBody([
        {name: 'name', value: 'Ada'},
        {name: 'doc', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('content')}
      ])
    )
    expect(await r.request('name')).toBe('Ada')
    const file = await r.file('doc')
    expect(file.name).toBe('a.txt')
  })

  it('returns null for an untouched (empty filename) file input', async () => {
    const r = run(buildBody([{name: 'avatar', filename: '', contentType: 'application/octet-stream', data: Buffer.alloc(0)}]))
    expect(await r.file('avatar')).toBeNull()
  })

  it('returns an array when the same field has multiple files', async () => {
    const r = run(
      buildBody([
        {name: 'docs', filename: '1.txt', contentType: 'text/plain', data: Buffer.from('one')},
        {name: 'docs', filename: '2.txt', contentType: 'text/plain', data: Buffer.from('two')}
      ])
    )
    const files = await r.file('docs')
    expect(Array.isArray(files)).toBe(true)
    expect(files).toHaveLength(2)
    expect(files.map(f => f.name).sort()).toEqual(['1.txt', '2.txt'])
  })

  it('flags an oversize file as truncated with no leftover temp file', async () => {
    global.Odac.Config.request.maxFileSize = 10 // bytes
    const big = Buffer.alloc(1000, 0x41)
    const r = run(buildBody([{name: 'avatar', filename: 'big.bin', contentType: 'application/octet-stream', data: big}]))

    const file = await r.file('avatar')
    expect(file.truncated).toBe(true)
    expect(file.path).toBeNull()
    // No orphaned odac-* temp file remains in the upload dir.
    const leftovers = fs.readdirSync(tmpDir).filter(n => n.startsWith('odac-'))
    expect(leftovers).toHaveLength(0)
  })

  it('cleans up unstored temp files after the response ends', async () => {
    const r = run(buildBody([{name: 'avatar', filename: 'x.bin', contentType: 'application/octet-stream', data: Buffer.from('abc')}]))
    const file = await r.file('avatar')
    expect(fs.existsSync(file.path)).toBe(true)

    r.end('ok')
    // unlink is fire-and-forget; give the event loop a tick to run it.
    await new Promise(resolve => setImmediate(resolve))
    expect(fs.existsSync(file.path)).toBe(false)
  })
})
