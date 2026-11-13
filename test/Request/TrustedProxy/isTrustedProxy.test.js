const {isTrustedProxy} = require('../../../src/Request/TrustedProxy')

describe('isTrustedProxy()', () => {
  describe('under ODAC (ODAC_APP=true)', () => {
    const check = (address, configured) => isTrustedProxy(address, configured, true)

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
        expect(check(address)).toBe(true)
      }
    })

    it('does not trust public addresses by default', () => {
      for (const address of ['8.8.8.8', '203.0.113.9', '172.32.0.1', '2001:db8::1', '::ffff:1.2.3.4']) {
        expect(check(address)).toBe(false)
      }
    })

    it('trusts nobody with an empty list', () => {
      expect(check('127.0.0.1', [])).toBe(false)
      expect(check('172.17.0.1', [])).toBe(false)
    })

    it('treats null like an unset list', () => {
      expect(check('172.17.0.1', null)).toBe(true)
    })
  })

  // Only the ODAC proxy writes X-Odac-Connection-*. A standalone app, one behind its own nginx,
  // or one reached through a Docker published port (peer: the private bridge gateway) would
  // otherwise let any client choose its IP and fake HTTPS.
  describe('not under ODAC', () => {
    const check = (address, configured) => isTrustedProxy(address, configured, false)

    it('trusts nobody by default, private and loopback peers included', () => {
      for (const address of ['127.0.0.1', '::1', '10.0.0.5', '172.17.0.1', '192.168.1.10', 'fd12::1', '8.8.8.8']) {
        expect(check(address)).toBe(false)
      }
      expect(check('172.17.0.1', null)).toBe(false)
    })

    it('honours an explicit list', () => {
      expect(check('127.0.0.1', ['loopback'])).toBe(true)
      expect(check('10.0.0.5', ['loopback'])).toBe(false)
      expect(check('127.0.0.1', [])).toBe(false)
    })
  })

  it('accepts explicit addresses and CIDR ranges', () => {
    const configured = ['loopback', '203.0.113.0/24', '2001:db8::7']
    for (const underOdac of [true, false]) {
      expect(isTrustedProxy('203.0.113.200', configured, underOdac)).toBe(true)
      expect(isTrustedProxy('2001:db8::7', configured, underOdac)).toBe(true)
      expect(isTrustedProxy('10.0.0.1', configured, underOdac)).toBe(false)
    }
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
    for (const underOdac of [true, false]) {
      expect(isTrustedProxy(undefined, undefined, underOdac)).toBe(false)
      expect(isTrustedProxy('', undefined, underOdac)).toBe(false)
      expect(isTrustedProxy('localhost', undefined, underOdac)).toBe(false)
    }
  })

  describe('ODAC detection', () => {
    const original = process.env.ODAC_APP

    afterEach(() => {
      if (original === undefined) delete process.env.ODAC_APP
      else process.env.ODAC_APP = original
    })

    function load(value) {
      if (value === undefined) delete process.env.ODAC_APP
      else process.env.ODAC_APP = value
      let mod
      jest.isolateModules(() => (mod = require('../../../src/Request/TrustedProxy')))
      return mod
    }

    it('defaults to the ODAC rule when ODAC_APP=true', () => {
      expect(load('true').isTrustedProxy('172.17.0.1')).toBe(true)
    })

    it.each([undefined, '', 'false', '1', 'TRUE'])('trusts nobody by default when ODAC_APP is %j', value => {
      expect(load(value).isTrustedProxy('172.17.0.1')).toBe(false)
    })

    it('reads ODAC_APP once at load, not per call', () => {
      const mod = load('true')
      delete process.env.ODAC_APP
      expect(mod.isTrustedProxy('172.17.0.1')).toBe(true)
    })
  })
})
