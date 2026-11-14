const {isFromOdacProxy, markProxySocket} = require('../../../src/Request/TrustedProxy')

const VECTOR = 't=1700000000,v1=d9a16b4e0be33e772aac465b062640fb9fa3163a9e7bf997c7b1323579b979c8'
const NOW = 1700000000 * 1000

function makeReq(signature = VECTOR) {
  return {
    method: 'GET',
    url: '/a?b=1',
    headers: {
      host: 'example.com',
      'x-odac-connection-remoteaddress': '203.0.113.7',
      'x-odac-connection-ssl': 'true',
      'x-odac-connection-signature': signature
    }
  }
}

describe('isFromOdacProxy()', () => {
  const withKey = {underOdac: true, key: 'k', now: NOW}
  const withoutKey = {underOdac: true, key: '', now: NOW}

  describe('under ODAC with a key', () => {
    it('trusts a signed request from any peer', () => {
      for (const remoteAddress of ['172.17.0.1', '198.51.100.7']) {
        expect(isFromOdacProxy(makeReq(), {remoteAddress}, undefined, withKey)).toBe(true)
      }
    })

    it('does not trust an unsigned request from a private peer', () => {
      expect(isFromOdacProxy(makeReq(null), {remoteAddress: '172.17.0.1'}, undefined, withKey)).toBe(false)
      expect(isFromOdacProxy(makeReq(null), {remoteAddress: '127.0.0.1'}, undefined, withKey)).toBe(false)
    })

    it('does not trust a forged signature', () => {
      const forged = VECTOR.replace(/.$/, '0')
      expect(isFromOdacProxy(makeReq(forged), {remoteAddress: '172.17.0.1'}, undefined, withKey)).toBe(false)
    })

    it('still trusts a peer the operator listed', () => {
      expect(isFromOdacProxy(makeReq(null), {remoteAddress: '10.1.2.3'}, ['10.1.2.3'], withKey)).toBe(true)
    })

    it('trusts a signed request even with an empty trustedProxies list', () => {
      expect(isFromOdacProxy(makeReq(), {remoteAddress: '172.17.0.1'}, [], withKey)).toBe(true)
    })

    it('trusts the proxy socket without a signature', () => {
      const socket = {remoteAddress: undefined}
      markProxySocket(socket)
      expect(isFromOdacProxy(makeReq(null), socket, [], withKey)).toBe(true)
    })
  })

  describe('under ODAC without a key', () => {
    it('falls back to trusting private peers', () => {
      expect(isFromOdacProxy(makeReq(null), {remoteAddress: '172.17.0.1'}, undefined, withoutKey)).toBe(true)
      expect(isFromOdacProxy(makeReq(null), {remoteAddress: '198.51.100.7'}, undefined, withoutKey)).toBe(false)
    })
  })

  describe('not under ODAC', () => {
    it('trusts nobody by default', () => {
      expect(isFromOdacProxy(makeReq(null), {remoteAddress: '127.0.0.1'}, undefined, {underOdac: false, key: '', now: NOW})).toBe(false)
    })
  })

  it('copes with a request that has no socket', () => {
    expect(isFromOdacProxy(makeReq(null), undefined, undefined, withKey)).toBe(false)
  })
})
