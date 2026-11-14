const nodeCrypto = require('crypto')
const {hasProxySignature} = require('../../../src/Request/TrustedProxy')

// The same vector is pinned in the ODAC server (internal/proxysig), so both ends agree on the contract.
const VECTOR = 't=1700000000,v1=d9a16b4e0be33e772aac465b062640fb9fa3163a9e7bf997c7b1323579b979c8'
const NOW = 1700000000 * 1000

function makeReq(overrides = {}) {
  return {
    method: 'GET',
    url: '/a?b=1',
    headers: {
      host: 'example.com',
      'x-odac-connection-remoteaddress': '203.0.113.7',
      'x-odac-connection-ssl': 'true',
      'x-odac-connection-signature': VECTOR,
      ...overrides.headers
    },
    ...(overrides.method && {method: overrides.method}),
    ...(overrides.url && {url: overrides.url})
  }
}

function sign(key, t, fields) {
  const mac = nodeCrypto.createHmac('sha256', key)
  mac.update(['odac-connection-v1', String(t), ...fields].join('\n'))
  return `t=${t},v1=${mac.digest('hex')}`
}

describe('hasProxySignature()', () => {
  it('accepts the published vector', () => {
    expect(hasProxySignature(makeReq(), 'k', NOW)).toBe(true)
  })

  it('accepts a signature within 60 seconds either way', () => {
    expect(hasProxySignature(makeReq(), 'k', NOW + 60000)).toBe(true)
    expect(hasProxySignature(makeReq(), 'k', NOW - 60000)).toBe(true)
  })

  it('rejects a stale or future timestamp', () => {
    expect(hasProxySignature(makeReq(), 'k', NOW + 61000)).toBe(false)
    expect(hasProxySignature(makeReq(), 'k', NOW - 61000)).toBe(false)
  })

  it('rejects without a key', () => {
    expect(hasProxySignature(makeReq(), '', NOW)).toBe(false)
  })

  it('rejects another key', () => {
    expect(hasProxySignature(makeReq(), 'other', NOW)).toBe(false)
  })

  it.each([
    ['method', {method: 'POST'}],
    ['url', {url: '/a?b=2'}],
    ['host', {headers: {host: 'evil.example'}}],
    ['address', {headers: {'x-odac-connection-remoteaddress': '198.51.100.1'}}],
    ['TLS state', {headers: {'x-odac-connection-ssl': undefined}}]
  ])('rejects a request whose %s differs from what was signed', (_, overrides) => {
    expect(hasProxySignature(makeReq(overrides), 'k', NOW)).toBe(false)
  })

  it('verifies a plain HTTP request signed with an empty TLS field', () => {
    const headers = {'x-odac-connection-ssl': undefined}
    headers['x-odac-connection-signature'] = sign('k', 1700000000, ['GET', 'example.com', '/a?b=1', '203.0.113.7', ''])
    expect(hasProxySignature(makeReq({headers}), 'k', NOW)).toBe(true)
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['without a timestamp', 'v1=d9a16b4e0be33e772aac465b062640fb9fa3163a9e7bf997c7b1323579b979c8'],
    ['with a short digest', 't=1700000000,v1=d9a16b4e'],
    ['with uppercase hex', VECTOR.toUpperCase().replace('T=', 't=').replace('V1=', 'v1=')],
    ['with trailing data', VECTOR + ',v2=00']
  ])('rejects a signature header that is %s', (_, value) => {
    expect(hasProxySignature(makeReq({headers: {'x-odac-connection-signature': value}}), 'k', NOW)).toBe(false)
  })
})
