const Auth = require('../../src/Auth.js')
const Lang = require('../../src/Lang.js')

// Messages Auth returns to the visitor are translated into the request's language, and the
// magic-link mail is sent in that language unless the caller names another one.

const TR = {
  'Please wait %s seconds before requesting another link.': 'Yeni bağlantı için %s saniye bekleyin.',
  'Login to our site': 'Sitemize giriş yapın',
  'This sign-in link has expired. Please request a new one.': 'Bu giriş bağlantısının süresi doldu.'
}
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(async file => (String(file).endsWith('/tr.json') ? JSON.stringify(TR) : '{}')),
    stat: jest.fn(async () => ({mtimeMs: 1}))
  }
}))

const config = {lang: {default: 'en', supported: ['en', 'tr']}, auth: {}}

describe('Auth messages and the magic-link mail language', () => {
  let mails
  let session

  const makeRequest = () => ({
    fromTrustedProxy: true,
    header: () => 'TestBrowser',
    host: 'app.example.com',
    ip: '203.0.113.9',
    ssl: true,
    session: jest.fn((key, value) => {
      if (value === undefined) return session[key] ?? null
      session[key] = value
    })
  })

  // An Odac request instance whose visitor reads Turkish.
  const makeOdac = request => {
    const odac = {Config: config, Request: {header: name => (name === 'ACCEPT-LANGUAGE' ? 'tr' : undefined)}}
    odac.Lang = new Lang(odac)
    return {request, odac}
  }

  const table = () => {
    const query = {
      delete: () => Promise.resolve(0),
      first: () => Promise.resolve(null),
      insert: () => Promise.resolve([1]),
      schema: () => Promise.resolve(),
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
      where: () => query
    }
    return query
  }

  beforeEach(async () => {
    global.__dir = '/mock'
    Lang.store.reset()
    await Lang.store.init(config)
    mails = []
    session = {}
    global.Odac = {
      Config: config,
      DB: new Proxy({fn: {now: () => new Date()}}, {get: (target, prop) => (prop in target ? target[prop] : table())}),
      Mail: () => {
        const mail = {}
        mails.push(mail)
        for (const method of ['from', 'to']) mail[method] = () => mail
        mail.lang = code => Object.assign(mail, {language: code})
        // Like Mail#subject: a function is given the mail's translator.
        mail.subject = subject =>
          Object.assign(mail, {
            sent: typeof subject === 'function' ? subject(Lang.translator({Lang: Lang.for(mail.language, config)})) : subject
          })
        mail.send = () => Promise.resolve(true)
        return mail
      },
      Var: () => ({hash: () => '$scrypt$salt$hash'})
    }
    config.url = 'https://www.example.com'
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    Lang.store.reset()
  })

  it('translates a returned error with its placeholder filled', async () => {
    const {request, odac} = makeOdac(makeRequest())
    session.magic_last_request = Date.now()

    const result = await new Auth(request, odac).magic('a@example.com')

    expect(result.error).toMatch(/^Yeni bağlantı için \d+ saniye bekleyin\.$/)
  })

  it('returns the English source text when there is no request language', async () => {
    session.magic_last_request = Date.now()

    const result = await new Auth(makeRequest()).magic('a@example.com')

    expect(result.error).toMatch(/^Please wait \d+ seconds before requesting another link\.$/)
  })

  it('sends the magic-link mail in the request language, with a translated default subject', async () => {
    const {request, odac} = makeOdac(makeRequest())

    const result = await new Auth(request, odac).magic('a@example.com')

    expect(result.success).toBe(true)
    expect(mails[0].language).toBe('tr')
    expect(mails[0].sent).toBe('Sitemize giriş yapın')
  })

  it('sends the mail in options.lang when given', async () => {
    const {request, odac} = makeOdac(makeRequest())

    await new Auth(request, odac).magic('a@example.com', {lang: 'en'})

    expect(mails[0].language).toBe('en')
    expect(mails[0].sent).toBe('Login to our site')
  })

  it('translates a magic-link failure in the language of the page that reads it', () => {
    const {request, odac} = makeOdac(makeRequest())
    session._odac_magic_error = {code: 'expired', message: 'This sign-in link has expired. Please request a new one.'}
    const auth = new Auth(request, odac)

    expect(auth.magicError()).toEqual({code: 'expired', message: 'Bu giriş bağlantısının süresi doldu.'})
    // Read once, then kept for the request; a later Lang.set() applies to the next call.
    odac.Lang.set('en')
    expect(auth.magicError()).toEqual({code: 'expired', message: 'This sign-in link has expired. Please request a new one.'})
    expect(session._odac_magic_error).toBeNull()
  })
})
