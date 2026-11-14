const {EventEmitter} = require('events')
const {isProxySocket, markProxySocket} = require('../../../src/Request/TrustedProxy')

// A unix socket peer has no address, so trust is decided by the listener that accepted the
// connection, never by an empty remoteAddress (a reset TCP socket reports one too).
describe('isProxySocket()', () => {
  it('recognises a connection accepted on the proxy socket', () => {
    const socket = new EventEmitter()
    markProxySocket(socket)
    expect(isProxySocket(socket)).toBe(true)
  })

  it('does not trust an unmarked socket without a remote address', () => {
    expect(isProxySocket(new EventEmitter())).toBe(false)
    expect(isProxySocket({remoteAddress: undefined})).toBe(false)
    expect(isProxySocket({remoteAddress: ''})).toBe(false)
  })

  it('handles a missing socket', () => {
    expect(isProxySocket(undefined)).toBe(false)
    expect(isProxySocket(null)).toBe(false)
  })

  it('ignores values that cannot be marked', () => {
    expect(() => markProxySocket(undefined)).not.toThrow()
    expect(() => markProxySocket('socket')).not.toThrow()
    expect(isProxySocket('socket')).toBe(false)
  })
})
