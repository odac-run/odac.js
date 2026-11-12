const nodeCrypto = require('crypto')

const Auth = require('../../src/Auth.js')
const Var = require('../../src/Var.js')

// A magic link that does not sign the person in reports a stable code ('invalid', 'expired',
// 'denied', 'failed') so the page they return to can tell them what to do next, and
// magicError() hands that page the failure stored by the verify route, once.

describe('Auth.verifyMagicLink() failure codes', () => {
  let users
  let tokens
  let magic

  // In-memory table: equality where() filters, range filters are ignored.
  const table = rows => {
    const make = filters => {
      const match = () => rows.filter(row => filters.every(([key, value]) => String(row[key]) === String(value)))
      const query = {
        columnInfo: async () => ({type: 'varchar'}),
        delete: async () => {
          const removed = match()
          for (const row of removed) rows.splice(rows.indexOf(row), 1)
          return removed.length
        },
        first: async () => match()[0] ?? null,
        insert: async row => {
          rows.push(row)
          return [1]
        },
        schema: async () => {},
        then: (resolve, reject) => Promise.resolve(match()).then(resolve, reject),
        update: async () => 1,
        where: (key, op, value) => make(value === undefined ? [...filters, [key, op]] : filters)
      }
      return query
    }
    return make([])
  }

  const makeRequest = () => ({
    cookie: jest.fn(),
    header: name => (name === 'user-agent' ? 'TestBrowser' : null),
    ip: '203.0.113.9',
    regenerateSession: jest.fn(),
    session: () => null
  })

  const hash = raw => '$sha256$' + nodeCrypto.createHash('sha256').update(raw).digest('hex')
  const addLink = (email, expires_at, raw = 'raw_token') => magic.push({email, token_hash: hash(raw), expires_at})
  const verify = (raw = 'raw_token', email = 'a@example.com') => new Auth(makeRequest()).verifyMagicLink(raw, email)

  beforeEach(() => {
    users = [{id: 'u1', email: 'a@example.com', password: new Var('pw').hash()}]
    tokens = []
    magic = []
    global.Odac = {
      Config: {auth: {table: 'users', token: 'user_tokens', magicTable: 'odac_magic'}},
      DB: {
        fn: {now: () => new Date()},
        nanoid: () => 'u_new',
        schema: {hasColumn: async () => true, hasTable: async () => true, alterTable: async () => {}},
        get users() {
          return table(users)
        },
        get user_tokens() {
          return table(tokens)
        },
        get odac_magic() {
          return table(magic)
        }
      },
      Var: value => new Var(value)
    }
  })

  afterEach(() => {
    delete global.Odac
  })

  it.each([
    [null, 'a@example.com'],
    ['raw_token', null]
  ])('reports a link missing its token or email as invalid (%p, %p)', async (raw, email) => {
    await expect(new Auth(makeRequest()).verifyMagicLink(raw, email)).resolves.toEqual({
      success: false,
      code: 'invalid',
      error: 'Invalid link'
    })
  })

  it('reports an address without links as invalid', async () => {
    await expect(verify()).resolves.toEqual({success: false, code: 'invalid', error: 'Link expired or invalid'})
  })

  it('reports a wrong token as invalid, even next to an expired one', async () => {
    addLink('a@example.com', new Date(Date.now() - 1000), 'old_token')
    await expect(verify()).resolves.toEqual({success: false, code: 'invalid', error: 'Invalid token'})
  })

  it('reports a correct token past its expiry as expired and keeps the row', async () => {
    addLink('a@example.com', new Date(Date.now() - 1000))

    await expect(verify()).resolves.toEqual({success: false, code: 'expired', error: 'Link expired or invalid'})
    expect(magic).toHaveLength(1)
    expect(tokens).toHaveLength(0)
  })

  it('reads a zoneless SQLite expiry as UTC', async () => {
    const utc = date => date.toISOString().replace('T', ' ').slice(0, 19)
    addLink('a@example.com', utc(new Date(Date.now() + 10 * 60 * 1000)))
    await expect(verify()).resolves.toMatchObject({success: true})

    addLink('a@example.com', utc(new Date(Date.now() - 10 * 60 * 1000)))
    await expect(verify()).resolves.toMatchObject({success: false, code: 'expired'})
  })

  it('treats a row without an expiry as expired', async () => {
    addLink('a@example.com', null)
    await expect(verify()).resolves.toMatchObject({success: false, code: 'expired'})
  })

  it('accepts a valid link and consumes every link of the address', async () => {
    addLink('a@example.com', new Date(Date.now() + 60000))
    addLink('a@example.com', new Date(Date.now() + 60000), 'second_token')

    await expect(verify()).resolves.toMatchObject({success: true, user: {id: 'u1'}})
    expect(magic).toHaveLength(0)
    expect(tokens).toHaveLength(1)
  })

  it('reports a failed registration as failed', async () => {
    addLink('new@example.com', new Date(Date.now() + 60000))
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const db = global.Odac.DB
    global.Odac.DB = new Proxy(db, {
      get: (target, prop) => (prop === 'users' ? {...table(users), insert: () => Promise.reject(new Error('disk full'))} : target[prop])
    })

    await expect(verify('raw_token', 'new@example.com')).resolves.toEqual({success: false, code: 'failed', error: 'Registration failed'})
    errorSpy.mockRestore()
  })

  it('reports a sign-in that could not store its token as failed', async () => {
    addLink('a@example.com', new Date(Date.now() + 60000))
    const db = global.Odac.DB
    global.Odac.DB = new Proxy(db, {
      get: (target, prop) => (prop === 'user_tokens' ? {...table(tokens), insert: async () => 0} : target[prop])
    })

    await expect(verify()).resolves.toEqual({success: false, code: 'failed', error: 'Login failed'})
  })

  it('signs a new user in once, without the register auto-login', async () => {
    addLink('new@example.com', new Date(Date.now() + 60000))

    await expect(verify('raw_token', 'new@example.com')).resolves.toMatchObject({success: true, user: {email: 'new@example.com'}})
    expect(tokens).toHaveLength(1)
  })
})

describe('Auth.magicError()', () => {
  const makeRequest = initial => {
    const store = {_odac_magic_error: initial}
    return {
      store,
      session: jest.fn((key, value) => {
        if (value === undefined) return store[key] ?? null
        if (value === null) delete store[key]
        else store[key] = value
      })
    }
  }

  it('returns the stored failure once and removes it from the session', () => {
    const request = makeRequest({code: 'expired', message: 'This sign-in link has expired.'})
    const auth = new Auth(request)

    expect(auth.magicError()).toEqual({code: 'expired', message: 'This sign-in link has expired.'})
    expect(request.store._odac_magic_error).toBeUndefined()
    expect(new Auth(request).magicError()).toBeNull()
  })

  it('keeps the failure for the rest of the request', () => {
    const request = makeRequest({code: 'invalid', message: 'Invalid.'})
    const auth = new Auth(request)

    auth.magicError()
    expect(auth.magicError()).toEqual({code: 'invalid', message: 'Invalid.'})
    expect(request.session).toHaveBeenCalledTimes(2)
  })

  it('returns null when there is none', () => {
    expect(new Auth(makeRequest(undefined)).magicError()).toBeNull()
  })

  it('ignores a malformed session value', () => {
    expect(new Auth(makeRequest('expired')).magicError()).toBeNull()
  })
})
