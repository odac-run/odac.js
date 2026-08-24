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
