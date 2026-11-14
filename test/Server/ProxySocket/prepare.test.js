const fs = require('fs')
const net = require('net')
const path = require('path')
const ProxySocket = require('../../../src/Server/ProxySocket')
const {close, listenOn, staleSocket, tempDir} = require('./helpers')

// prepare() runs once in the cluster primary before any worker listens: a container restart
// keeps the old socket file, and binding over it fails.
describe('ProxySocket.prepare()', () => {
  let dir
  let target

  beforeEach(() => {
    dir = tempDir()
    target = path.join(dir, 'http.sock')
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    fs.rmSync(dir, {recursive: true, force: true})
  })

  const env = () => ({ODAC_PROXY_SOCKET: target})

  it('returns null without touching anything when the variable is absent', async () => {
    expect(await ProxySocket.prepare({})).toBeNull()
  })

  it('returns the path when nothing is there yet', async () => {
    expect(await ProxySocket.prepare(env())).toBe(target)
  })

  it('removes a stale socket left by a previous run', async () => {
    await staleSocket(target)
    expect(fs.lstatSync(target).isSocket()).toBe(true)

    expect(await ProxySocket.prepare(env())).toBe(target)
    expect(fs.existsSync(target)).toBe(false)

    const server = await listenOn(net.createServer(), target)
    await close(server)
  })

  it('removes a symlink at the path without following it', async () => {
    const victim = path.join(dir, 'victim')
    fs.writeFileSync(victim, 'keep me')
    fs.symlinkSync(victim, target)

    expect(await ProxySocket.prepare(env())).toBe(target)

    expect(() => fs.lstatSync(target)).toThrow(expect.objectContaining({code: 'ENOENT'}))
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me')
  })

  it('removes a symlink to a live socket without probing or touching that socket', async () => {
    const other = path.join(dir, 'other.sock')
    const live = await listenOn(net.createServer(), other)
    const accepted = jest.fn()
    live.on('connection', accepted)
    fs.symlinkSync(other, target)

    expect(await ProxySocket.prepare(env())).toBe(target)

    expect(fs.existsSync(target)).toBe(false)
    expect(fs.lstatSync(other).isSocket()).toBe(true)
    expect(accepted).not.toHaveBeenCalled()
    await close(live)
  })

  it('leaves a socket another process still serves and falls back to TCP', async () => {
    const live = await listenOn(net.createServer(), target)

    expect(await ProxySocket.prepare(env())).toBeNull()

    expect(fs.lstatSync(target).isSocket()).toBe(true)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Another process is listening'))
    await close(live)
  })

  it('refuses to delete a regular file at the path', async () => {
    fs.writeFileSync(target, 'data')

    expect(await ProxySocket.prepare(env())).toBeNull()

    expect(fs.readFileSync(target, 'utf8')).toBe('data')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not a socket'))
  })

  it('refuses a directory at the path', async () => {
    fs.mkdirSync(target)

    expect(await ProxySocket.prepare(env())).toBeNull()
    expect(fs.statSync(target).isDirectory()).toBe(true)
  })

  it('falls back to TCP when the path cannot be inspected', async () => {
    const blocker = path.join(dir, 'file')
    fs.writeFileSync(blocker, '')

    expect(await ProxySocket.prepare({ODAC_PROXY_SOCKET: path.join(blocker, 'http.sock')})).toBeNull()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ENOTDIR'))
  })

  it('falls back to TCP when the stale file cannot be removed', async () => {
    await staleSocket(target)
    jest.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(Object.assign(new Error('read-only'), {code: 'EROFS'}))

    expect(await ProxySocket.prepare(env())).toBeNull()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('EROFS'))
  })

  it('treats a file that vanished during removal as cleared', async () => {
    await staleSocket(target)
    jest.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(Object.assign(new Error('gone'), {code: 'ENOENT'}))

    expect(await ProxySocket.prepare(env())).toBe(target)
  })
})
