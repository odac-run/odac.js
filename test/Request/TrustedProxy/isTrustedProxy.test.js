const {isTrustedProxy} = require('../../../src/Request/TrustedProxy')

describe('isTrustedProxy()', () => {
  it('trusts loopback and private networks by default', () => {
    for (const address of [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '10.0.0.5',
      '172.17.0.1',
      '192.168.1.10',
      'fd12::1',
      '::ffff:172.18.0.2'
    ]) {
      expect(isTrustedProxy(address)).toBe(true)
    }
  })

  it('does not trust public addresses by default', () => {
    for (const address of ['8.8.8.8', '203.0.113.9', '172.32.0.1', '2001:db8::1', '::ffff:1.2.3.4']) {
      expect(isTrustedProxy(address)).toBe(false)
    }
  })

  it('trusts nobody with an empty list', () => {
    expect(isTrustedProxy('127.0.0.1', [])).toBe(false)
  })

  it('accepts explicit addresses and CIDR ranges', () => {
    const configured = ['loopback', '203.0.113.0/24', '2001:db8::7']
    expect(isTrustedProxy('203.0.113.200', configured)).toBe(true)
    expect(isTrustedProxy('2001:db8::7', configured)).toBe(true)
    expect(isTrustedProxy('10.0.0.1', configured)).toBe(false)
  })

  it('accepts a single string entry', () => {
    expect(isTrustedProxy('127.0.0.1', 'loopback')).toBe(true)
    expect(isTrustedProxy('10.0.0.1', 'loopback')).toBe(false)
  })

  it('ignores invalid entries without trusting everything', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})
    expect(isTrustedProxy('8.8.8.8', ['not-an-ip', '1.2.3.4/99', '0.0.0.0/x'])).toBe(false)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('does not trust a missing or malformed peer address', () => {
    expect(isTrustedProxy(undefined)).toBe(false)
    expect(isTrustedProxy('')).toBe(false)
    expect(isTrustedProxy('localhost')).toBe(false)
  })
})
