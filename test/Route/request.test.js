const Route = require('../../src/Route')

// Route.request() dispatches an incoming req/res. When the resolved route
// (virtual host) is not configured, it must respond 404 — not an empty 200.
// See IMPROVEMENT-PLAN 4.6.

describe('Route.request()', () => {
  let route
  let param

  beforeEach(() => {
    route = new Route()
    param = {
      Request: {
        route: 'unknown',
        abort: jest.fn(),
        end: jest.fn(),
        print: jest.fn(),
        refreshTimeout: jest.fn(),
        clearTimeout: jest.fn(),
        res: {finished: false, writableEnded: false}
      },
      View: {print: jest.fn()},
      cleanup: jest.fn()
    }
    global.Odac = {
      instance: jest.fn(() => param)
    }
    global.__dir = process.cwd()
  })

  afterEach(() => {
    delete global.Odac
    delete global.__dir
  })

  it('responds 404 for an unconfigured route instead of an empty 200', async () => {
    route.routes = {} // 'unknown' host is not configured
    await route.request({}, {statusCode: 200, end: jest.fn(), destroy: jest.fn()})

    expect(param.Request.abort).toHaveBeenCalledWith(404)
  })

  describe('controller errors', () => {
    beforeEach(() => {
      route.routes = {unknown: {}}
      jest.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => console.error.mockRestore())

    it('waits for abort(500) so a custom 500 page is not cut off by an empty end()', async () => {
      route.check = jest.fn().mockRejectedValue(new Error('boom'))
      let finishAbort
      param.Request.abort = jest.fn(
        () =>
          new Promise(resolve => {
            finishAbort = () => {
              param.Request.res.writableEnded = true
              resolve()
            }
          })
      )

      const done = route.request({}, {})
      await new Promise(resolve => setImmediate(resolve))
      expect(param.Request.end).not.toHaveBeenCalled()
      finishAbort()
      await done

      expect(param.Request.abort).toHaveBeenCalledWith(500)
      expect(param.Request.end).not.toHaveBeenCalled()
      expect(param.cleanup).toHaveBeenCalled()
    })

    it('contains a failing abort(500) instead of rejecting', async () => {
      route.check = jest.fn().mockRejectedValue(new Error('boom'))
      param.Request.abort = jest.fn().mockRejectedValue(new Error('headers already sent'))
      param.Request.res.destroy = jest.fn()

      await expect(route.request({}, {})).resolves.toBeUndefined()
      expect(param.Request.res.destroy).toHaveBeenCalled()
      expect(param.cleanup).toHaveBeenCalled()
    })
  })

  // A HEAD response carries no body. Piping a stream result (image route, user
  // controllers) would read the whole source only for Node to discard it.
  describe('stream results', () => {
    const createStream = () => ({pipe: jest.fn(), destroy: jest.fn()})

    beforeEach(() => {
      route.routes = {unknown: {}}
    })

    it('releases the stream instead of piping it on HEAD', async () => {
      const stream = createStream()
      route.check = jest.fn().mockResolvedValue(stream)
      param.Request.method = 'head'

      await route.request({}, {})

      expect(stream.pipe).not.toHaveBeenCalled()
      expect(stream.destroy).toHaveBeenCalled()
      expect(param.Request.end).toHaveBeenCalledWith()
      expect(param.cleanup).toHaveBeenCalled()
    })

    it('pipes the stream into the response on GET', async () => {
      const {Readable, PassThrough} = require('stream')
      const source = Readable.from([Buffer.from('hello '), Buffer.from('world')])
      const res = new PassThrough()
      param.Request.res = res
      route.check = jest.fn().mockResolvedValue(source)
      param.Request.method = 'get'

      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      await route.request({}, res)
      await new Promise(resolve => res.on('finish', resolve))

      expect(param.Request.print).toHaveBeenCalled()
      expect(Buffer.concat(chunks).toString()).toBe('hello world')
      await new Promise(resolve => setImmediate(resolve))
      expect(param.cleanup).toHaveBeenCalled()
    })
  })

  // pipe() neither destroys the source when the client goes away nor handles
  // source errors. An aborted download leaked the file descriptor, and a
  // read error (e.g. a prod-cached public file deleted since) crashed the worker.
  describe('stream lifecycle', () => {
    const fs = require('fs')
    const os = require('os')
    const path = require('path')
    const {PassThrough} = require('stream')

    let tmpDir

    beforeEach(() => {
      route.routes = {unknown: {}}
      param.Request.method = 'get'
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-route-request-'))
      jest.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      fs.rmSync(tmpDir, {recursive: true, force: true})
      jest.restoreAllMocks()
    })

    it('closes the file when the client disconnects mid-download', async () => {
      const file = path.join(tmpDir, 'big.bin')
      fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024))
      const source = fs.createReadStream(file, {highWaterMark: 1024})
      // Never consumed: mimics a client that stops reading, then hangs up.
      const res = new PassThrough({highWaterMark: 1024})
      param.Request.res = res
      route.check = jest.fn().mockResolvedValue(source)

      await route.request({}, res)
      await new Promise(resolve => source.once('data', resolve))
      res.destroy()
      await new Promise(resolve => source.once('close', resolve))

      expect(source.destroyed).toBe(true)
      expect(param.cleanup).toHaveBeenCalled()
    })

    // The request timeout is an idle deadline. A download longer than the
    // timeout used to be cut mid-file with "Request Timeout" appended.
    it('re-arms the idle timeout for every chunk streamed', async () => {
      const {Readable} = require('stream')
      const source = Readable.from([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')])
      const res = new PassThrough()
      res.resume()
      param.Request.res = res
      route.check = jest.fn().mockResolvedValue(source)

      await route.request({}, res)
      await new Promise(resolve => res.on('finish', resolve))

      expect(param.Request.refreshTimeout).toHaveBeenCalledTimes(3)
    })

    it('clears the timeout once the stream completes', async () => {
      const {Readable} = require('stream')
      const source = Readable.from([Buffer.from('done')])
      const res = new PassThrough()
      res.resume()
      param.Request.res = res
      route.check = jest.fn().mockResolvedValue(source)

      await route.request({}, res)
      await new Promise(resolve => res.on('finish', resolve))
      await new Promise(resolve => setImmediate(resolve))

      expect(param.Request.clearTimeout).toHaveBeenCalled()
    })

    it('contains a read error instead of crashing the worker', async () => {
      const source = fs.createReadStream(path.join(tmpDir, 'deleted.css'))
      const res = new PassThrough()
      param.Request.res = res
      route.check = jest.fn().mockResolvedValue(source)

      await route.request({}, res)
      await new Promise(resolve => res.once('close', resolve))

      expect(res.destroyed).toBe(true)
      expect(param.cleanup).toHaveBeenCalled()
    })
  })
})
