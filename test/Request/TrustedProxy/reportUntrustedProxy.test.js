// A reverse proxy the app does not trust gives every visitor its address, so IP-keyed limits
// count all visitors as one. That is reported once per process.

let reportUntrustedProxy
let errors

beforeEach(() => {
  jest.resetModules()
  ;({reportUntrustedProxy} = require('../../../src/Request/TrustedProxy'))
  errors = []
  jest.spyOn(console, 'error').mockImplementation(message => errors.push(message))
})

afterEach(() => {
  jest.restoreAllMocks()
})

const req = headers => ({headers})

describe('reportUntrustedProxy()', () => {
  it('warns once when a private peer forwards a client address', () => {
    expect(reportUntrustedProxy(req({'x-forwarded-for': '203.0.113.7'}), '10.0.0.5')).toBe(true)
    expect(reportUntrustedProxy(req({'x-real-ip': '203.0.113.8'}), '127.0.0.1')).toBe(false)

    expect(errors).toHaveLength(1)
    const entry = JSON.parse(errors[0])
    expect(entry.level).toBe('WARN')
    expect(entry.peer).toBe('10.0.0.5')
    expect(entry.message).toContain('request.trustedProxies')
  })

  it.each(['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-odac-connection-remoteaddress'])('recognises %s', header => {
    expect(reportUntrustedProxy(req({[header]: 'x'}), '::1')).toBe(true)
  })

  it('ignores public peers, whose headers are client supplied', () => {
    expect(reportUntrustedProxy(req({'x-forwarded-for': '1.2.3.4'}), '203.0.113.9')).toBe(false)
    expect(errors).toHaveLength(0)
  })

  it('ignores requests without forwarding headers and missing peers', () => {
    expect(reportUntrustedProxy(req({}), '10.0.0.5')).toBe(false)
    expect(reportUntrustedProxy(req({'x-forwarded-for': '1.2.3.4'}), undefined)).toBe(false)
    expect(errors).toHaveLength(0)
  })
})
