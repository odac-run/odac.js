const fs = require('fs')
const os = require('os')
const path = require('path')
const {EventEmitter} = require('events')

// The disposable-domain list is module state. Each test loads a fresh copy of the module
// with https mocked, rooted in its own storage directory.

describe('Validator.isDisposable()', () => {
  let tmpDir
  let https
  let Validator

  // Serves `body` after `delay` ms; returns the request emitter so tests can inspect it.
  const respond = (body, {status = 200, delay = 0} = {}) =>
    https.get.mockImplementationOnce((url, options, callback) => {
      const req = new EventEmitter()
      req.destroy = err => req.emit('error', err)
      setTimeout(() => {
        const res = new EventEmitter()
        res.statusCode = status
        res.resume = () => {}
        callback(res)
        res.emit('data', Buffer.from(body))
        res.emit('end')
      }, delay)
      return req
    })

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-disposable-'))
    global.__dir = tmpDir
    jest.resetModules()
    jest.doMock('https', () => ({get: jest.fn()}))
    https = require('https')
    Validator = require('../../src/Validator')
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    jest.dontMock('https')
    delete global.__dir
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('makes concurrent first checks wait for the list instead of passing them', async () => {
    respond('mailinator.com\n', {delay: 20})
    const results = await Promise.all([
      Validator.isDisposable('a@mailinator.com'),
      Validator.isDisposable('b@mailinator.com'),
      Validator.isDisposable('c@example.com')
    ])
    expect(results).toEqual([true, true, false])
    expect(https.get).toHaveBeenCalledTimes(1)
  })

  it('sets a timeout on the download', async () => {
    respond('x.com\n')
    await Validator.isDisposable('a@x.com')
    expect(https.get.mock.calls[0][1]).toEqual(expect.objectContaining({timeout: expect.any(Number)}))
  })

  it('refreshes the list once it is a day old and keeps serving the old one meanwhile', async () => {
    respond('old.com\n')
    expect(await Validator.isDisposable('a@old.com')).toBe(true)

    const realNow = Date.now
    jest.spyOn(Date, 'now').mockReturnValue(realNow() + 25 * 60 * 60 * 1000)
    // The cache file is now stale as well, so the refresh downloads again.
    respond('new.com\n', {delay: 20})
    expect(await Validator.isDisposable('a@old.com')).toBe(true) // stale list, refresh started
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await Validator.isDisposable('a@new.com')).toBe(true)
    expect(await Validator.isDisposable('a@old.com')).toBe(false)
    expect(https.get).toHaveBeenCalledTimes(2)
  })

  it('falls back to an empty list when nothing can be loaded, and retries later', async () => {
    respond('', {status: 503})
    expect(await Validator.isDisposable('a@mailinator.com')).toBe(false)
    expect(await Validator.isDisposable('a@mailinator.com')).toBe(false)
    expect(https.get).toHaveBeenCalledTimes(1)
  })

  it('uses a fresh cache file without downloading', async () => {
    const cache = path.join(tmpDir, 'storage', '.cache', 'odac_disposable_domains.conf')
    fs.mkdirSync(path.dirname(cache), {recursive: true})
    fs.writeFileSync(cache, 'cached.com\n')
    expect(await Validator.isDisposable('a@cached.com')).toBe(true)
    expect(https.get).not.toHaveBeenCalled()
  })
})
