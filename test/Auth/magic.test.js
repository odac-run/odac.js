const Auth = require('../../src/Auth.js')

// magic() mails a link that carries a login token. Its address must not come from a
// client-controlled Host header, or the token is delivered to whoever chose that host.

describe('Auth.magic()', () => {
  let sent
  let inserted

  const makeRequest = overrides => ({
    fromTrustedProxy: true,
    header: () => 'TestBrowser',
    host: 'app.example.com',
    ip: '203.0.113.9',
    session: () => null,
    ssl: true,
    ...overrides
  })

  const table = () => {
    const query = {
      delete: () => Promise.resolve(0),
      first: () => Promise.resolve(null),
      insert: row => {
        inserted.push(row)
        return Promise.resolve([1])
      },
      schema: () => Promise.resolve(),
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
      where: () => query
    }
    return query
  }

  const linkFor = async (request, options) => {
    const result = await new Auth(request).magic('victim@example.com', options)
    return {result, link: sent[0]?.link}
  }

  beforeEach(() => {
    sent = []
    inserted = []
    const mail = {
      from: () => mail,
      send: data => {
        sent.push(data)
        return Promise.resolve(true)
      },
      subject: () => mail,
      to: () => mail
    }
    global.Odac = {
      Config: {auth: {}},
      DB: new Proxy({fn: {now: () => new Date()}}, {get: (target, prop) => (prop in target ? target[prop] : table())}),
      Mail: () => mail,
      Var: () => ({hash: () => '$scrypt$salt$hash'})
    }
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete global.Odac
  })

  it('uses the configured url instead of the Host header', async () => {
    global.Odac.Config.url = 'https://www.example.com/'
    const {result, link} = await linkFor(makeRequest({host: 'evil.example'}))

    expect(result.success).toBe(true)
    expect(link.startsWith('https://www.example.com/_odac/magic-verify?token=')).toBe(true)
    expect(sent[0].network).toBe('www.example.com')
  })

  it('prefers auth.magicLinkUrl and keeps a path prefix', async () => {
    global.Odac.Config.url = 'https://www.example.com'
    global.Odac.Config.auth.magicLinkUrl = 'https://login.example.com/app/'
    const {link} = await linkFor(makeRequest())

    expect(link.startsWith('https://login.example.com/app/_odac/magic-verify?')).toBe(true)
  })

  it('falls back to the Host header when the request came through a trusted proxy', async () => {
    const {link} = await linkFor(makeRequest())

    expect(link.startsWith('https://app.example.com/_odac/magic-verify?')).toBe(true)
  })

  it('refuses to build a link from the Host of a direct, untrusted connection', async () => {
    const {result} = await linkFor(makeRequest({fromTrustedProxy: false, host: 'evil.example'}))

    expect(result.success).toBe(false)
    expect(sent).toHaveLength(0)
    expect(inserted).toHaveLength(0)
  })

  it.each(['app.example.com:@evil.example', 'evil.example/app.example.com', 'app.example.com evil', ''])(
    'refuses the unsafe Host %p',
    async host => {
      const {result} = await linkFor(makeRequest({host}))

      expect(result.success).toBe(false)
      expect(sent).toHaveLength(0)
    }
  )

  it('rejects a configured url that is not http(s)', async () => {
    global.Odac.Config.url = 'javascript:alert(1)'
    const {result} = await linkFor(makeRequest())

    expect(result.success).toBe(false)
    expect(sent).toHaveLength(0)
  })
})
