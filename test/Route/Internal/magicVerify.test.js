const Internal = require('../../../src/Route/Internal')

// magicVerify redirects the user after a successful magic-link login. It must
// only ever redirect to a same-site absolute path. Protocol-relative ('//evil')
// AND backslash variants ('/\evil', '/\/evil') — which browsers normalize to
// '//evil' — must be neutralized to '/'. See IMPROVEMENT-PLAN 2.4.

// A real tap from a mobile mail app: top-level document navigation from a
// modern browser.
const HUMAN_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate'
}

function makeOdac(redirectUrl, headers = HUMAN_HEADERS) {
  const requestValues = {token: 'tok', email: 'a@b.c', redirect_url: redirectUrl}
  const captured = {redirect: null, body: null}
  return {
    _captured: captured,
    request: jest.fn(async key => requestValues[key]),
    Config: {auth: {}},
    Auth: {verifyMagicLink: jest.fn(async () => ({success: true}))},
    Request: {
      header: jest.fn(name => headers[name.toLowerCase()]),
      redirect: jest.fn(url => (captured.redirect = url)),
      end: jest.fn(body => (captured.body = body))
    }
  }
}

describe('Internal.magicVerify() redirect safety', () => {
  it('allows a legitimate same-site absolute path', async () => {
    const Odac = makeOdac('/dashboard')
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/dashboard')
  })

  it.each([
    ['tab', '/\t/evil.example'],
    ['newline', '/\n/evil.example'],
    ['carriage return', '/\r/evil.example'],
    ['tab between backslashes', '/\t\\evil.example']
  ])('blocks a %s that the URL parser strips into //evil', async (_, target) => {
    const Odac = makeOdac(target)
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/')
  })

  it('keeps the query string and hash of a same-site path', async () => {
    const Odac = makeOdac('/dashboard?tab=1#top')
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/dashboard?tab=1#top')
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

// Mail clients and chat apps fetch link targets to build previews or scan for
// malware before the user ever taps. Such a fetch used to consume the one-shot
// token, leaving the human with "Link expired or invalid" — the reason
// magic-link login failed on mobile. Machine fetches must not consume it.
describe('Internal.magicVerify() prefetch protection', () => {
  const machineFetches = {
    'Chrome prefetch (Sec-Purpose)': {
      'user-agent': HUMAN_HEADERS['user-agent'],
      'sec-purpose': 'prefetch;prerender',
      'sec-fetch-dest': 'document'
    },
    'legacy prefetch (Purpose)': {'user-agent': HUMAN_HEADERS['user-agent'], purpose: 'prefetch', 'sec-fetch-dest': 'document'},
    'Safari preview (X-Purpose)': {'user-agent': HUMAN_HEADERS['user-agent'], 'x-purpose': 'preview', 'sec-fetch-dest': 'document'},
    'Firefox prefetch (X-Moz)': {'user-agent': HUMAN_HEADERS['user-agent'], 'x-moz': 'prefetch'},
    'sub-resource fetch, not a navigation': {
      'user-agent': HUMAN_HEADERS['user-agent'],
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'no-cors'
    },
    'mail security scanner': {'user-agent': 'Mozilla/5.0 (compatible; Barracuda Link Protection)'},
    'plain HTTP client': {'user-agent': 'curl/8.7.1'},
    'no user agent at all': {}
  }

  // HEAD resolves GET routes, and link scanners probe with HEAD. Browsers never
  // navigate with HEAD, so even browser-like headers mark a machine fetch.
  it('does not consume the token for a HEAD request with browser headers', async () => {
    const Odac = makeOdac('/dashboard')
    Odac.Request.method = 'head'
    await Internal.magicVerify(Odac)
    expect(Odac.Auth.verifyMagicLink).not.toHaveBeenCalled()
    expect(Odac._captured.redirect).toBeNull()
  })

  for (const [label, headers] of Object.entries(machineFetches)) {
    it(`does not consume the token for a ${label}`, async () => {
      const Odac = makeOdac('/dashboard', headers)
      await Internal.magicVerify(Odac)
      expect(Odac.Auth.verifyMagicLink).not.toHaveBeenCalled()
      expect(Odac._captured.redirect).toBeNull()
      expect(typeof Odac._captured.body).toBe('string')
    })
  }

  it('consumes the token for a real tap from a mail app', async () => {
    const Odac = makeOdac('/dashboard')
    await Internal.magicVerify(Odac)
    expect(Odac.Auth.verifyMagicLink).toHaveBeenCalledWith('tok', 'a@b.c')
    expect(Odac._captured.redirect).toBe('/dashboard')
  })

  // Browsers predating fetch metadata (and in-app webviews that strip it) must
  // keep working: absent Sec-Fetch headers fall back to the user-agent check
  // rather than being treated as machines.
  it('consumes the token for a browser that sends no fetch metadata', async () => {
    const Odac = makeOdac('/dashboard', {'user-agent': HUMAN_HEADERS['user-agent']})
    await Internal.magicVerify(Odac)
    expect(Odac.Auth.verifyMagicLink).toHaveBeenCalled()
    expect(Odac._captured.redirect).toBe('/dashboard')
  })
})

// A link that does not sign the person in sends them back to the page it was requested from
// (error_url), or to auth.magicLinkErrorRedirect, with the failure in the session for
// Odac.Auth.magicError(). Without either, a standalone page explains it.
describe('Internal.magicVerify() failures', () => {
  function makeFailing({result = {success: false, code: 'expired'}, values = {}, config = {}, signedIn = null} = {}) {
    const requestValues = {token: 'tok', email: 'a@b.c', ...values}
    const captured = {redirect: null, body: null, status: null, session: {}}
    return {
      _captured: captured,
      request: jest.fn(async key => requestValues[key]),
      Config: {auth: config},
      Auth: {
        verifyMagicLink: jest.fn(async () => result),
        check: jest.fn(async () => !!signedIn),
        user: jest.fn(col => (signedIn ? signedIn[col] : false))
      },
      Request: {
        header: jest.fn(name => HUMAN_HEADERS[name.toLowerCase()]),
        redirect: jest.fn(url => (captured.redirect = url)),
        end: jest.fn(body => (captured.body = body)),
        status: jest.fn(code => (captured.status = code)),
        session: jest.fn((key, value) => (captured.session[key] = value))
      }
    }
  }

  it('returns to the page in the link with the failure in the session', async () => {
    const Odac = makeFailing({values: {error_url: '/login'}})
    await Internal.magicVerify(Odac)

    expect(Odac._captured.redirect).toBe('/login')
    expect(Odac._captured.session._odac_magic_error).toEqual({code: 'expired', message: expect.stringContaining('expired')})
  })

  it('prefers the page in the link over auth.magicLinkErrorRedirect', async () => {
    const Odac = makeFailing({values: {error_url: '/signin'}, config: {magicLinkErrorRedirect: '/auth/link-error'}})
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/signin')
  })

  it('falls back to auth.magicLinkErrorRedirect', async () => {
    const Odac = makeFailing({config: {magicLinkErrorRedirect: '/auth/link-error'}})
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/auth/link-error')
  })

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example/login'])('never leaves the site for error_url %p', async target => {
    const Odac = makeFailing({values: {error_url: target}})
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/')
  })

  it('shows a standalone page when there is nowhere to return to', async () => {
    const Odac = makeFailing({result: {success: false, code: 'invalid'}})
    await Internal.magicVerify(Odac)

    expect(Odac._captured.redirect).toBeNull()
    expect(Odac._captured.status).toBe(400)
    expect(Odac._captured.body).toMatch(/^<!doctype html>/)
    expect(Odac._captured.body).toContain('already been used')
    expect(Odac._captured.session).toEqual({})
  })

  it('treats a link without token or email as invalid without verifying it', async () => {
    const Odac = makeFailing({values: {token: undefined, error_url: '/login'}})
    await Internal.magicVerify(Odac)

    expect(Odac.Auth.verifyMagicLink).not.toHaveBeenCalled()
    expect(Odac._captured.session._odac_magic_error.code).toBe('invalid')
    expect(Odac._captured.redirect).toBe('/login')
  })

  it.each([
    ['denied', 'not allowed'],
    ['failed', 'could not be completed'],
    ['something-new', 'could not be completed']
  ])('explains a %p failure', async (code, text) => {
    const Odac = makeFailing({result: {success: false, code}, values: {error_url: '/login'}})
    await Internal.magicVerify(Odac)

    expect(Odac._captured.session._odac_magic_error.code).toBe(code === 'something-new' ? 'failed' : code)
    expect(Odac._captured.session._odac_magic_error.message).toContain(text)
  })

  it('sends a person already signed in with that address to the success page on a second tap', async () => {
    const Odac = makeFailing({
      result: {success: false, code: 'invalid'},
      values: {redirect_url: '/dashboard', error_url: '/login'},
      signedIn: {email: 'a@b.c'}
    })
    await Internal.magicVerify(Odac)

    expect(Odac._captured.redirect).toBe('/dashboard')
    expect(Odac._captured.session).toEqual({})
  })

  it('still reports the failure to someone signed in with another address', async () => {
    const Odac = makeFailing({values: {error_url: '/login'}, signedIn: {email: 'other@b.c'}})
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/login')
  })

  it('does not treat a refused sign-in as a second tap', async () => {
    const Odac = makeFailing({result: {success: false, code: 'denied'}, values: {error_url: '/login'}, signedIn: {email: 'a@b.c'}})
    await Internal.magicVerify(Odac)
    expect(Odac._captured.redirect).toBe('/login')
  })
})
