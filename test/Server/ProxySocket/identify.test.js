const fs = require('fs')
const net = require('net')
const path = require('path')
const ProxySocket = require('../../../src/Server/ProxySocket')
const {close, listenOn, tempDir} = require('./helpers')

describe('ProxySocket.identify()', () => {
  let dir

  beforeEach(() => (dir = tempDir()))
  afterEach(() => fs.rmSync(dir, {recursive: true, force: true}))

  it('returns the device and inode of a socket', async () => {
    const target = path.join(dir, 'http.sock')
    const server = await listenOn(net.createServer(), target)
    const stat = fs.lstatSync(target, {bigint: true})

    expect(await ProxySocket.identify(target)).toEqual({dev: stat.dev, ino: stat.ino})
    await close(server)
  })

  it('returns null for anything that is not a socket', async () => {
    const file = path.join(dir, 'file')
    fs.writeFileSync(file, '')

    expect(await ProxySocket.identify(file)).toBeNull()
    expect(await ProxySocket.identify(path.join(dir, 'missing'))).toBeNull()
  })
})
