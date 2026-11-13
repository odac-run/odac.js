const {EventEmitter} = require('events')
const fs = require('fs')
const http = require('http')
const path = require('path')
const ProxySocket = require('../../../src/Server/ProxySocket')
const {isProxySocket} = require('../../../src/Request/TrustedProxy')
const {close, tempDir} = require('./helpers')

function get(socketPath) {
  return new Promise((resolve, reject) => {
    http
      .get({socketPath, path: '/', agent: false}, res => {
        let body = ''
        res.on('data', chunk => (body += chunk))
        res.on('end', () => resolve(body))
      })
      .on('error', reject)
  })
}

describe('ProxySocket.listen()', () => {
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

  it('serves the server on the socket and marks its connections as the proxy', async () => {
    const server = http.createServer((req, res) => res.end(String(isProxySocket(req.socket))))
    ProxySocket.listen(server, target)
    await new Promise(resolve => server.once('listening', resolve))

    expect(fs.lstatSync(target).isSocket()).toBe(true)
    expect(await get(target)).toBe('true')
    await close(server)
  })

  it('logs a listen failure instead of throwing, leaving TCP to serve', async () => {
    const server = http.createServer()
    const missing = path.join(dir, 'missing', 'http.sock')

    expect(() => ProxySocket.listen(server, missing)).not.toThrow()
    await new Promise(resolve => setImmediate(resolve))

    expect(server.listening).toBe(false)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('serving on TCP only'))
  })

  it('logs a synchronous listen error instead of throwing', () => {
    const server = new EventEmitter()
    server.listen = () => {
      throw Object.assign(new TypeError('bad path'), {code: 'ERR_INVALID_ARG_VALUE'})
    }

    expect(() => ProxySocket.listen(server, target)).not.toThrow()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ERR_INVALID_ARG_VALUE'))
  })

  it('logs runtime errors on a listening socket without exiting', () => {
    const server = new EventEmitter()
    server.listen = jest.fn()
    server.listening = true
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {})
    ProxySocket.listen(server, target)

    server.emit('error', Object.assign(new Error('accept'), {code: 'EMFILE'}))

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Proxy socket server error'))
    expect(exit).not.toHaveBeenCalled()
  })
})
