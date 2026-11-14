const Internal = require('../../../src/Route/Internal')
const Form = require('../../../src/View/Form')
const Lang = require('../../../src/Lang')

// tr.json translates a few framework messages; every other file is empty.
const TR = {
  'Invalid credentials': 'Geçersiz bilgiler',
  'Login successful': 'Giriş başarılı',
  'Form session expired. Please refresh the page.': 'Form süresi doldu. Lütfen sayfayı yenileyin.',
  'Service temporarily unavailable. Please try again later.': 'Hizmet geçici olarak kullanılamıyor.',
  'This %s is already registered': '%s zaten kayıtlı',
  'Sign-in link': 'Giriş bağlantısı',
  'Go to the home page': 'Ana sayfaya dön',
  'This sign-in link has expired. Please request a new one.': 'Bu giriş bağlantısının süresi doldu.'
}
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(async file => (String(file).endsWith('/tr.json') ? JSON.stringify(TR) : '{}')),
    stat: jest.fn(async () => ({mtimeMs: 1}))
  }
}))

// A form posts to a URL that does not carry the page's language (/_odac/form, /_odac/login,
// or an action route such as /contact), so the submission is answered in the language the
// form was rendered in, stored with the form in the session.

const TOKEN = 'tok123'
const HEADERS = {'user-agent': 'jest-agent', 'ACCEPT-LANGUAGE': 'en-US,en;q=0.9'}

function makeOdac({formLang = 'tr', type = 'custom', ip = '127.0.0.1', config = {}} = {}) {
  const session = {
    _client: 'client-1',
    [`_${type}_form_${TOKEN}`]: {
      expires: Date.now() + 60000,
      sessionId: 'client-1',
      userAgent: 'jest-agent',
      ip,
      config: {fields: [], sets: [], ...config},
      ...(formLang !== null && {lang: formLang})
    }
  }
  const values = {_odac_form_token: TOKEN, _odac_login_token: TOKEN, _odac_register_token: TOKEN, _odac_magic_login_token: TOKEN}

  const Odac = {
    session,
    Config: {lang: {default: 'en', supported: ['en', 'tr']}},
    fn: {},
    request: jest.fn(async key => values[key]),
    return: jest.fn(data => data),
    validator: () => ({error: async () => false, result: () => ({})}),
    Request: {
      ip: '127.0.0.1',
      header: jest.fn(name => HEADERS[name]),
      session: jest.fn((key, value) => {
        if (value === undefined) return session[key]
        session[key] = value
      })
    }
  }
  Odac.Lang = new Lang(Odac)
  return Odac
}

describe('Internal.bindLanguage()', () => {
  beforeEach(async () => {
    global.__dir = '/mock'
    Lang.store.reset()
    await Lang.store.init({lang: {default: 'en', supported: ['en', 'tr']}})
  })

  describe('custom forms (processForm)', () => {
    it('serves the submission in the language the form was rendered in, not Accept-Language', async () => {
      const Odac = makeOdac()
      expect(Odac.Lang.current()).toBe('en')

      await Internal.processForm(Odac)

      expect(Odac.Lang.current()).toBe('tr')
      // Chosen from the session, not the header: the response does not vary by Accept-Language.
      expect(Odac.Lang.served().varies).toBe(false)
    })

    it('binds the language before set-callbacks run, so Odac.fn sees it', async () => {
      const Odac = makeOdac({config: {sets: [{name: 'locale', value: null, callback: 'locale'}]}})
      Odac.fn.locale = async o => o.Lang.current()

      await Internal.processForm(Odac)

      expect(Odac.formData.locale).toBe('tr')
    })

    it('keeps the language when the token is rotated after a successful action', async () => {
      const Odac = makeOdac({config: {action: 'Ctrl.save'}})
      await Internal.processForm(Odac)
      Odac.Route = {class: {Ctrl: {module: {save: async (_odac, form) => form.success('Saved.')}}}}

      const out = await Internal.customForm(Odac)

      expect(Odac.session[`_custom_form_${out.result._token}`].lang).toBe('tr')
    })

    it('binds the language before the session checks, so their errors are in it too', async () => {
      const Odac = makeOdac({ip: '10.0.0.1'})

      await Internal.processForm(Odac)

      expect(Odac.formData).toBeUndefined()
      expect(Odac.Lang.current()).toBe('tr')
    })

    it('answers an expired form in its language', async () => {
      const Odac = makeOdac()
      Odac.session[`_custom_form_${TOKEN}`].expires = Date.now() - 1

      const out = await Internal.customForm(Odac)

      expect(out.errors._odac_form).toBe('Form süresi doldu. Lütfen sayfayı yenileyin.')
    })

    it('leaves the language alone for a form stored without one (rendered before an upgrade)', async () => {
      const Odac = makeOdac({formLang: null})
      const set = jest.spyOn(Odac.Lang, 'set')

      await Internal.processForm(Odac)

      expect(set).not.toHaveBeenCalled()
      expect(Odac.Lang.current()).toBe('en')
    })

    it('falls back as set() does when the stored language is no longer supported', async () => {
      const Odac = makeOdac({formLang: 'de'})

      await Internal.processForm(Odac)

      expect(Odac.Lang.current()).toBe('en')
    })
  })

  describe('built-in auth forms', () => {
    it('answers invalid credentials in the form language', async () => {
      const Odac = makeOdac({type: 'login'})
      Odac.Auth = {loginThrottled: async () => false, login: async () => false}

      const out = await Internal.login(Odac)

      expect(out.errors._odac_form).toBe('Geçersiz bilgiler')
    })

    it('answers a successful login in the form language', async () => {
      const Odac = makeOdac({type: 'login'})
      Odac.Auth = {loginThrottled: async () => false, login: async () => true}

      const out = await Internal.login(Odac)

      expect(out.result.message).toBe('Giriş başarılı')
    })

    it('recognises an unavailable database by code, not by its translated text', async () => {
      const Odac = makeOdac({type: 'register'})
      Odac.Auth = {register: async () => ({success: false, code: 'unavailable', error: 'Veritabanı bağlantısı yok'})}

      const out = await Internal.register(Odac)

      expect(out.errors._odac_form).toBe('Hizmet geçici olarak kullanılamıyor.')
    })

    it('fills placeholders of a translated message', async () => {
      const Odac = makeOdac({config: {table: 'users'}})
      await Internal.processForm(Odac)
      Odac.formUniqueFields = [{name: 'email'}]
      Odac.formData = {email: 'a@example.com'}
      Odac.DB = {users: {where: () => ({first: async () => ({id: 1})})}}

      const out = await Internal.customForm(Odac)

      expect(out.errors.email).toBe('email zaten kayıtlı')
    })

    it('binds the language of a login form', async () => {
      const Odac = makeOdac({type: 'login'})
      Odac.Auth = {loginThrottled: async () => false, login: async () => true}

      await Internal.login(Odac)

      expect(Odac.Lang.current()).toBe('tr')
    })

    it('binds the language of a register form', async () => {
      const Odac = makeOdac({type: 'register'})
      Odac.Auth = {register: async () => ({success: true})}

      await Internal.register(Odac)

      expect(Odac.Lang.current()).toBe('tr')
    })

    it('binds the language of a magic-login form before Auth.magic() runs', async () => {
      const Odac = makeOdac({type: 'magic_login', config: {fields: [{name: 'email', validations: []}]}})
      Odac.request = jest.fn(async key => (key === '_odac_magic_login_token' ? TOKEN : 'a@example.com'))
      let magicIn = null
      Odac.Auth = {
        magic: async () => {
          magicIn = Odac.Lang.current()
          return {success: true}
        }
      }

      await Internal.magicLogin(Odac)

      expect(magicIn).toBe('tr')
    })
  })
})

describe('Form.storeConfig() language', () => {
  const makeRenderOdac = Lang => {
    const session = {}
    return {
      session,
      Lang,
      Request: {
        ip: '127.0.0.1',
        header: () => 'jest-agent',
        session: jest.fn((key, value) => {
          if (value === undefined) return key === '_client' ? 'client' : session[key]
          session[key] = value
        })
      }
    }
  }

  it('stores the language the form is rendered in', () => {
    const Odac = makeRenderOdac({current: () => 'pt-BR'})
    Form.storeConfig('t1', {}, Odac, 'form')
    expect(Odac.session._custom_form_t1.lang).toBe('pt-BR')
  })

  it('stores null when there is no Lang instance', () => {
    const Odac = makeRenderOdac(undefined)
    Form.storeConfig('t1', {}, Odac, 'login')
    expect(Odac.session._login_form_t1.lang).toBeNull()
  })
})

describe('Internal.magicVerify() language', () => {
  const makeVerifyOdac = ({errorUrl} = {}) => {
    const session = {}
    const Odac = {
      session,
      Config: {lang: {default: 'en', supported: ['en', 'tr']}, auth: {}},
      request: jest.fn(async key => ({token: 't', email: 'a@example.com', error_url: errorUrl})[key]),
      Auth: {verifyMagicLink: async () => ({success: false, code: 'expired'}), check: async () => false},
      Request: {
        method: 'get',
        header: jest.fn(name => ({'sec-fetch-dest': 'document', 'ACCEPT-LANGUAGE': 'tr-TR,tr;q=0.9'})[name]),
        session: jest.fn((key, value) => {
          if (value === undefined) return session[key]
          session[key] = value
        }),
        status: jest.fn(),
        redirect: jest.fn(),
        end: jest.fn(body => body)
      }
    }
    Odac.Lang = new Lang(Odac)
    return Odac
  }

  beforeEach(async () => {
    global.__dir = '/mock'
    Lang.store.reset()
    await Lang.store.init({lang: {default: 'en', supported: ['en', 'tr']}})
  })

  it('renders the standalone error page in the request language', async () => {
    const Odac = makeVerifyOdac()

    const html = await Internal.magicVerify(Odac)

    expect(html).toContain('<html lang="tr" dir="ltr">')
    expect(html).toContain('<title>Giriş bağlantısı</title>')
    expect(html).toContain('Bu giriş bağlantısının süresi doldu.')
    expect(html).toContain('Ana sayfaya dön')
  })

  it('stores the untranslated message, for the landing page to translate in its own language', async () => {
    const Odac = makeVerifyOdac({errorUrl: '/login'})

    await Internal.magicVerify(Odac)

    expect(Odac.session._odac_magic_error).toEqual({code: 'expired', message: 'This sign-in link has expired. Please request a new one.'})
  })
})
