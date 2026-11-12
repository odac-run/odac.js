const fs = require('fs')
const os = require('os')
const path = require('path')
const Route = require('../../src/Route')

// Public files and config-route files share Route.#asset(): content type, validators,
// conditional requests, byte ranges and the cache policy. Real files on disk, so the
// descriptor-based size/ETag path is exercised end to end.

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString()))
    stream.on('error', reject)
  })
}

describe('Route static files', () => {
  let route
  let tmpDir

  const createOdac = (url, {method = 'get', headers = {}, debug = true} = {}) => {
    const response = {headers: {}, status: 200, ended: false}
    const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      response,
      Auth: {check: jest.fn().mockResolvedValue(true)},
      Config: {debug},
      Request: {
        url,
        method,
        route: 'www',
        header: jest.fn((key, value) => {
          if (value === undefined) return lowerHeaders[key.toLowerCase()]
          response.headers[key] = value
        }),
        status: jest.fn(code => (response.status = code)),
        end: jest.fn(() => {
          response.ended = true
        }),
        cookie: jest.fn(() => null),
        abort: jest.fn(),
        setSession: jest.fn(),
        data: {url: {}}
      },
      request: jest.fn().mockResolvedValue(null)
    }
  }

  const writePublic = (name, content) => {
    const file = path.join(tmpDir, 'public', name)
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, content)
    return file
  }

  beforeEach(() => {
    route = new Route()
    route.routes = {www: {}}
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-static-'))
    global.__dir = tmpDir
    global.Odac = {Route: {}, Config: {}}
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
    delete global.__dir
    delete global.Odac
  })

  describe('content type', () => {
    it('serves unknown extensions as application/octet-stream, never text/html', async () => {
      writePublic('upload.xyz', '<script>alert(1)</script>')
      const odac = createOdac('/upload.xyz')
      const stream = await route.check(odac)
      await readAll(stream)
      expect(odac.response.headers['Content-Type']).toBe('application/octet-stream')
    })

    it.each([
      ['photo.jpg', 'image/jpeg'],
      ['style.css', 'text/css; charset=utf-8'],
      ['app.mjs', 'text/javascript; charset=utf-8'],
      ['module.wasm', 'application/wasm'],
      ['image.avif', 'image/avif'],
      ['site.webmanifest', 'application/manifest+json; charset=utf-8'],
      ['app.js.map', 'application/json; charset=utf-8'],
      ['PHOTO.JPG', 'image/jpeg']
    ])('serves %s as %s', async (name, type) => {
      writePublic(name, 'x')
      const odac = createOdac('/' + name)
      await readAll(await route.check(odac))
      expect(odac.response.headers['Content-Type']).toBe(type)
    })

    it('falls back to application/octet-stream for a config-route file with an unknown extension', async () => {
      const file = path.join(tmpDir, 'data.unknown')
      fs.writeFileSync(file, 'x')
      const odac = createOdac('/data')
      odac.Config.route = {'/data': file}
      await route.check(odac)
      expect(odac.response.headers['Content-Type']).toBe('application/octet-stream')
    })
  })

  describe('hidden files', () => {
    it.each(['/.env', '/.git/config', '/assets/.secret.json'])('does not serve %s', async url => {
      writePublic(url.slice(1), 'SECRET=1')
      const odac = createOdac(url)
      const result = await route.check(odac)
      expect(result).toBeUndefined()
      expect(odac.Request.abort).toHaveBeenCalledWith(404)
    })

    it('still serves /.well-known', async () => {
      writePublic('.well-known/security.txt', 'Contact: x')
      const odac = createOdac('/.well-known/security.txt')
      expect(await readAll(await route.check(odac))).toBe('Contact: x')
    })
  })

  describe('cache policy', () => {
    it('revalidates unversioned URLs', async () => {
      writePublic('assets/css/app.css', 'body{}')
      const odac = createOdac('/assets/css/app.css')
      await readAll(await route.check(odac))
      expect(odac.response.headers['Cache-Control']).toBe('public, max-age=0, must-revalidate')
      expect(odac.response.headers.ETag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/)
      expect(odac.response.headers['Last-Modified']).toBe(fs.statSync(path.join(tmpDir, 'public/assets/css/app.css')).mtime.toUTCString())
    })

    it('caches versioned URLs as immutable', async () => {
      writePublic('assets/css/app.css', 'body{}')
      const odac = createOdac('/assets/css/app.css?v=1a2b')
      await readAll(await route.check(odac))
      expect(odac.response.headers['Cache-Control']).toBe('public, max-age=31536000, immutable')
    })

    it('applies the same policy to config-route files', async () => {
      const file = path.join(tmpDir, 'odac.js')
      fs.writeFileSync(file, 'ok()')
      const odac = createOdac('/assets/js/odac.js')
      odac.Config.route = {'/assets/js/odac.js': file}
      const body = await route.check(odac)
      expect(body.toString()).toBe('ok()')
      expect(odac.response.headers['Cache-Control']).toBe('public, max-age=0, must-revalidate')
      expect(odac.response.headers.ETag).toBeDefined()
    })
  })

  describe('conditional requests', () => {
    it('answers a matching If-None-Match with 304 and no body', async () => {
      writePublic('app.js', 'run()')
      const first = createOdac('/app.js')
      await readAll(await route.check(first))

      const second = createOdac('/app.js', {headers: {'If-None-Match': first.response.headers.ETag}})
      const result = await route.check(second)
      expect(result).toBeUndefined()
      expect(second.response.status).toBe(304)
      expect(second.Request.end).toHaveBeenCalledWith()
      expect(second.response.headers['Content-Length']).toBeUndefined()
    })

    it('answers a current If-Modified-Since with 304', async () => {
      const file = writePublic('app.js', 'run()')
      const odac = createOdac('/app.js', {headers: {'If-Modified-Since': fs.statSync(file).mtime.toUTCString()}})
      await route.check(odac)
      expect(odac.response.status).toBe(304)
    })

    it('serves the file again once it changed', async () => {
      const file = writePublic('app.js', 'run()')
      const first = createOdac('/app.js')
      await readAll(await route.check(first))

      fs.writeFileSync(file, 'run(2)')
      fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))
      const second = createOdac('/app.js', {headers: {'If-None-Match': first.response.headers.ETag}})
      expect(await readAll(await route.check(second))).toBe('run(2)')
      expect(second.response.status).toBe(200)
    })

    it('answers config-route revalidation from the prod cache with 304', async () => {
      const file = path.join(tmpDir, 'odac.js')
      fs.writeFileSync(file, 'ok()')
      const first = createOdac('/assets/js/odac.js', {debug: false})
      first.Config.route = {'/assets/js/odac.js': file}
      await route.check(first)

      const second = createOdac('/assets/js/odac.js', {debug: false, headers: {'If-None-Match': first.response.headers.ETag}})
      second.Config.route = first.Config.route
      await route.check(second)
      expect(second.response.status).toBe(304)
    })
  })

  describe('byte ranges', () => {
    it('serves a single range with 206', async () => {
      writePublic('clip.mp4', '0123456789')
      const odac = createOdac('/clip.mp4', {headers: {Range: 'bytes=2-5'}})
      expect(await readAll(await route.check(odac))).toBe('2345')
      expect(odac.response.status).toBe(206)
      expect(odac.response.headers['Content-Range']).toBe('bytes 2-5/10')
      expect(odac.response.headers['Content-Length']).toBe(4)
      expect(odac.response.headers['Accept-Ranges']).toBe('bytes')
    })

    it('serves open-ended and suffix ranges', async () => {
      writePublic('clip.mp4', '0123456789')
      const open = createOdac('/clip.mp4', {headers: {Range: 'bytes=7-'}})
      expect(await readAll(await route.check(open))).toBe('789')
      const suffix = createOdac('/clip.mp4', {headers: {Range: 'bytes=-3'}})
      expect(await readAll(await route.check(suffix))).toBe('789')
      expect(suffix.response.headers['Content-Range']).toBe('bytes 7-9/10')
    })

    it('answers an unsatisfiable range with 416', async () => {
      writePublic('clip.mp4', '0123456789')
      const odac = createOdac('/clip.mp4', {headers: {Range: 'bytes=20-30'}})
      expect(await route.check(odac)).toBeUndefined()
      expect(odac.response.status).toBe(416)
      expect(odac.response.headers['Content-Range']).toBe('bytes */10')
    })

    it('serves the full body for multiple ranges or a stale If-Range', async () => {
      writePublic('clip.mp4', '0123456789')
      const multi = createOdac('/clip.mp4', {headers: {Range: 'bytes=0-1,4-5'}})
      expect(await readAll(await route.check(multi))).toBe('0123456789')
      expect(multi.response.status).toBe(200)

      const stale = createOdac('/clip.mp4', {headers: {Range: 'bytes=0-1', 'If-Range': 'Thu, 01 Jan 1970 00:00:00 GMT'}})
      expect(await readAll(await route.check(stale))).toBe('0123456789')
    })

    it('slices config-route content for a range', async () => {
      const file = path.join(tmpDir, 'odac.js')
      fs.writeFileSync(file, 'abcdef')
      const odac = createOdac('/assets/js/odac.js', {headers: {Range: 'bytes=1-2'}})
      odac.Config.route = {'/assets/js/odac.js': file}
      expect((await route.check(odac)).toString()).toBe('bc')
      expect(odac.response.status).toBe(206)
    })
  })

  describe('HEAD and file changes', () => {
    it('answers HEAD with headers only and releases the descriptor', async () => {
      writePublic('style.css', 'body{}')
      const open = jest.spyOn(fs.promises, 'open')
      const odac = createOdac('/style.css', {method: 'head'})
      expect(await route.check(odac)).toBeUndefined()
      expect(odac.response.headers['Content-Length']).toBe(6)
      expect(odac.Request.end).toHaveBeenCalledWith()
      const handle = await open.mock.results[0].value
      // A closed FileHandle has fd -1.
      expect(handle.fd).toBe(-1)
      open.mockRestore()
    })

    it('reports the current size after a file is replaced in production', async () => {
      const file = writePublic('data.txt', 'short')
      const first = createOdac('/data.txt', {debug: false})
      await readAll(await route.check(first))

      fs.writeFileSync(file, 'a much longer body')
      const second = createOdac('/data.txt', {debug: false})
      expect(await readAll(await route.check(second))).toBe('a much longer body')
      expect(second.response.headers['Content-Length']).toBe(18)
    })

    it('404s once a file is deleted in production', async () => {
      const file = writePublic('gone.css', 'body{}')
      await readAll(await route.check(createOdac('/gone.css', {debug: false})))
      fs.unlinkSync(file)
      const odac = createOdac('/gone.css', {debug: false})
      expect(await route.check(odac)).toBeUndefined()
      expect(odac.Request.abort).toHaveBeenCalledWith(404)
    })
  })
})
