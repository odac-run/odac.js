const fs = require('fs')
const net = require('net')
const path = require('path')
const ProxySocket = require('../../../src/Server/ProxySocket')
const {close, listenOn, staleSocket, tempDir} = require('./helpers')

// Shutdown removes the socket file only if it is still the one this app bound.
describe('ProxySocket.release()', () => {
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

  it('removes the socket it identified', async () => {
    await staleSocket(target)
    const identity = await ProxySocket.identify(target)

    await ProxySocket.release(target, identity)

    expect(fs.existsSync(target)).toBe(false)
  })

  it('leaves a socket with a different identity', async () => {
    await staleSocket(target)
    const identity = await ProxySocket.identify(target)

    await ProxySocket.release(target, {dev: identity.dev, ino: identity.ino + 1n})

    expect(fs.lstatSync(target).isSocket()).toBe(true)
  })

  // Linux reuses the freed inode number, so the new socket can carry the old identity.
  it('leaves a socket another process bound and serves after it was identified', async () => {
    await staleSocket(target)
    const identity = await ProxySocket.identify(target)
    fs.unlinkSync(target)
    const server = await listenOn(net.createServer(), target)

    try {
      await ProxySocket.release(target, {dev: identity.dev, ino: identity.ino})
      expect(fs.lstatSync(target).isSocket()).toBe(true)
    } finally {
      await close(server)
    }
  })

  it('leaves its own socket while something still serves it', async () => {
    const server = await listenOn(net.createServer(), target)
    const identity = await ProxySocket.identify(target)

    try {
      await ProxySocket.release(target, identity)
      expect(fs.lstatSync(target).isSocket()).toBe(true)
    } finally {
      await close(server)
    }
  })

  it('leaves a non-socket at the path', async () => {
    await staleSocket(target)
    const identity = await ProxySocket.identify(target)
    fs.unlinkSync(target)
    fs.writeFileSync(target, 'data')

    await ProxySocket.release(target, identity)

    expect(fs.readFileSync(target, 'utf8')).toBe('data')
  })

  it('does nothing without an identity', async () => {
    await staleSocket(target)

    await ProxySocket.release(target, null)

    expect(fs.lstatSync(target).isSocket()).toBe(true)
  })

  it('is quiet when the file is already gone', async () => {
    await ProxySocket.release(target, {dev: 1n, ino: 1n})
    expect(console.error).not.toHaveBeenCalled()
  })

  it('logs a removal failure without throwing', async () => {
    await staleSocket(target)
    const identity = await ProxySocket.identify(target)
    jest.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(Object.assign(new Error('busy'), {code: 'EBUSY'}))

    await expect(ProxySocket.release(target, identity)).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('EBUSY'))
  })
})
