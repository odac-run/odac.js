const Internal = require('../../../src/Route/Internal')

// magicVerify redirects the user after a successful magic-link login. It must
// only ever redirect to a same-site absolute path. Protocol-relative ('//evil')
// AND backslash variants ('/\evil', '/\/evil') — which browsers normalize to
// '//evil' — must be neutralized to '/'. See IMPROVEMENT-PLAN 2.4.

function makeOdac(redirectUrl) {
  const requestValues = {token: 'tok', email: 'a@b.c', redirect_url: redirectUrl}
  const captured = {redirect: null}
  return {
    _captured: captured,
    request: jest.fn(async key => requestValues[key]),
    Config: {auth: {}},
    Auth: {verifyMagicLink: jest.fn(async () => ({success: true}))},
    Request: {
      redirect: jest.fn(url => (captured.redirect = url)),
      end: jest.fn()
    }
  }
}

describe('Internal.magicVerify() redirect safety', () => {
  it('allows a legitimate same-site absolute path', async () => {
    const Odac = makeOdac('/dashboard')
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/dashboard')
  })

  it('blocks protocol-relative redirect (//evil.com)', async () => {
    const Odac = makeOdac('//evil.com')
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/')
  })

  it('blocks backslash bypass (/\\evil.com)', async () => {
    const Odac = makeOdac('/\\evil.com')
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/')
  })

  it('blocks mixed slash/backslash bypass (/\\/evil.com)', async () => {
    const Odac = makeOdac('/\\/evil.com')
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/')
  })

  it('blocks an absolute external URL (http://evil.com)', async () => {
    const Odac = makeOdac('http://evil.com')
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/')
  })
})
