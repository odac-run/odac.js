const ProxySocket = require('../../../src/Server/ProxySocket')

describe('ProxySocket.socketPath()', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}))
  afterEach(() => jest.restoreAllMocks())

  it('is null when ODAC_PROXY_SOCKET is absent or empty, keeping TCP only', () => {
    expect(ProxySocket.socketPath({})).toBeNull()
    expect(ProxySocket.socketPath({ODAC_PROXY_SOCKET: ''})).toBeNull()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('returns the configured absolute path', () => {
    expect(ProxySocket.socketPath({ODAC_PROXY_SOCKET: '/odac-proxy/http.sock'})).toBe('/odac-proxy/http.sock')
  })

  it('normalizes the path so primary and workers compare the same string', () => {
    expect(ProxySocket.socketPath({ODAC_PROXY_SOCKET: '/odac-proxy/./x/../http.sock'})).toBe('/odac-proxy/http.sock')
  })

  it.each(['http.sock', './odac-proxy/http.sock', '\0abstract', '/odac-proxy/\0http.sock'])('rejects %j with a warning', value => {
    expect(ProxySocket.socketPath({ODAC_PROXY_SOCKET: value})).toBeNull()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"level":"WARN"'))
  })

  it('reads process.env by default', () => {
    const original = process.env.ODAC_PROXY_SOCKET
    process.env.ODAC_PROXY_SOCKET = '/odac-proxy/http.sock'
    try {
      expect(ProxySocket.socketPath()).toBe('/odac-proxy/http.sock')
    } finally {
      if (original === undefined) delete process.env.ODAC_PROXY_SOCKET
      else process.env.ODAC_PROXY_SOCKET = original
    }
  })
})
