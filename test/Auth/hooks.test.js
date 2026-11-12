const nodeCrypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const Auth = require('../../src/Auth.js')
const Hook = require('../../src/Hook.js')
const Var = require('../../src/Var.js')

// hook/auth.js: beforeLogin can veto a sign-in, login runs after the token is stored, and
// loginFailed reports invalid, throttled and denied attempts. Every sign-in path (password,
// direct, register, magic link) goes through them.

describe('Auth hooks (hook/auth.js)', () => {
  const stored = new Var('s3cret').hash()
  let hookDir
  let users
  let tokens
  let magic
  let ipc
  let calls
  let behavior

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

  const event = name => calls.filter(([n]) => n === name).map(([, ctx, payload]) => ({ctx, payload}))

  beforeAll(async () => {
    hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-auth-hook-'))
    const handler = name =>
      `${name}: async (Odac, payload) => { global.__authHookCalls.push(['${name}', Odac, payload]); const fn = global.__authHookBehavior.${name}; return fn ? fn(payload) : undefined }`
    fs.writeFileSync(
      path.join(hookDir, 'auth.js'),
      `module.exports = {${['beforeLogin', 'login', 'loginFailed'].map(handler).join(',\n')}}`
    )
    await Hook.load(hookDir)
  })

  afterAll(async () => {
    await Hook.load(path.join(os.tmpdir(), 'odac-auth-hook-missing'))
    fs.rmSync(hookDir, {recursive: true, force: true})
    delete global.__authHookCalls
    delete global.__authHookBehavior
  })

  beforeEach(() => {
    users = [{id: 'u1', email: 'a@example.com', password: stored, name: 'Ada'}]
    tokens = []
    magic = []
    ipc = new Map()
    calls = []
    behavior = {}
    global.__authHookCalls = calls
    global.__authHookBehavior = behavior
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
      Ipc: {
        get: async key => ipc.get(key) ?? null,
        incrBy: async (key, delta) => {
          ipc.set(key, (ipc.get(key) ?? 0) + delta)
          return ipc.get(key)
        },
        del: async key => ipc.delete(key)
      },
      Var: value => new Var(value)
    }
  })

  afterEach(() => {
    delete global.Odac
  })

  describe('login', () => {
    it('runs after the token is stored, with the request Odac and the user without its hash', async () => {
      const odac = {tag: 'request-odac'}
      let tokensAtHook = null
      behavior.login = () => {
        tokensAtHook = tokens.length
      }

      await expect(new Auth(makeRequest(), odac).login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(true)

      const [{ctx, payload}] = event('login')
      expect(ctx).toBe(odac)
      expect(payload).toEqual({user: {id: 'u1', email: 'a@example.com', name: 'Ada'}, method: 'password'})
      expect(tokensAtHook).toBe(1)
      // The stored row keeps its hash; only the hook's copy is stripped.
      expect(users[0].password).toBe(stored)
    })

    it('falls back to the global Odac when no instance was given', async () => {
      await new Auth(makeRequest()).login({email: 'a@example.com', password: 's3cret'})
      expect(event('login')[0].ctx).toBe(global.Odac)
    })

    it('reports a login by identity alone as "direct"', async () => {
      await expect(new Auth(makeRequest()).login({id: 'u1'})).resolves.toBe(true)
      expect(event('login')[0].payload.method).toBe('direct')
    })

    it('does not fail the sign-in when the hook throws', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      behavior.login = () => {
        throw new Error('audit table missing')
      }

      await expect(new Auth(makeRequest()).login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(true)
      expect(tokens).toHaveLength(1)
      errorSpy.mockRestore()
    })
  })

  describe('beforeLogin', () => {
    it('receives the verified user before anything is issued', async () => {
      const request = makeRequest()
      behavior.beforeLogin = () => {
        expect(tokens).toHaveLength(0)
        expect(request.cookie).not.toHaveBeenCalled()
      }

      await expect(new Auth(request).login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(true)
      expect(event('beforeLogin')[0].payload).toEqual({user: {id: 'u1', email: 'a@example.com', name: 'Ada'}, method: 'password'})
    })

    it('denies the sign-in when it returns false', async () => {
      const request = makeRequest()
      behavior.beforeLogin = ({user}) => user.name !== 'Ada'

      await expect(new Auth(request).login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(false)

      expect(tokens).toHaveLength(0)
      expect(request.cookie).not.toHaveBeenCalled()
      expect(request.regenerateSession).not.toHaveBeenCalled()
      expect(event('login')).toHaveLength(0)
      expect(event('loginFailed')[0].payload).toEqual({identity: {email: 'a@example.com'}, method: 'password', reason: 'denied'})
    })

    it('denies the sign-in when it throws (fails closed)', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      behavior.beforeLogin = () => {
        throw new Error('ban list unreachable')
      }

      await expect(new Auth(makeRequest()).login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(false)
      expect(tokens).toHaveLength(0)
      expect(event('loginFailed')[0].payload.reason).toBe('denied')
      errorSpy.mockRestore()
    })

    it.each([undefined, null, 0, '', 'ok', true])('allows the sign-in when it returns %p', async value => {
      behavior.beforeLogin = () => value
      await expect(new Auth(makeRequest()).login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(true)
    })

    it('does not count a denial as a wrong password', async () => {
      behavior.beforeLogin = () => false
      for (let i = 0; i < 6; i++) await new Auth(makeRequest()).login({email: 'a@example.com', password: 's3cret'})

      behavior.beforeLogin = () => true
      await expect(new Auth(makeRequest()).login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(true)
    })
  })

  describe('loginFailed', () => {
    it('reports wrong credentials without the password', async () => {
      await expect(new Auth(makeRequest()).login({email: 'a@example.com', password: 'wrong'})).resolves.toBe(false)

      expect(event('loginFailed').map(e => e.payload)).toEqual([
        {identity: {email: 'a@example.com'}, method: 'password', reason: 'invalid'}
      ])
      expect(event('beforeLogin')).toHaveLength(0)
      expect(event('login')).toHaveLength(0)
    })

    it('reports an unknown identity as invalid', async () => {
      await new Auth(makeRequest()).login({email: 'nobody@example.com', password: 'x'})
      expect(event('loginFailed')[0].payload).toEqual({identity: {email: 'nobody@example.com'}, method: 'password', reason: 'invalid'})
    })

    it('reports throttled attempts', async () => {
      for (let i = 0; i < 5; i++) await new Auth(makeRequest()).login({email: 'a@example.com', password: 'wrong'})
      calls.length = 0

      await expect(new Auth(makeRequest()).login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(false)
      expect(event('loginFailed').map(e => e.payload)).toEqual([
        {identity: {email: 'a@example.com'}, method: 'password', reason: 'throttled'}
      ])
    })

    it('keeps every configured secret field out of the identity', async () => {
      global.Odac.Config.auth.passwordField = ['password', 'pin']
      await new Auth(makeRequest()).login({email: 'a@example.com', password: 'wrong', pin: '1234'})
      expect(event('loginFailed')[0].payload.identity).toEqual({email: 'a@example.com'})
    })
  })

  describe('register', () => {
    it('reports the auto-login as "register"', async () => {
      const result = await new Auth(makeRequest()).register({email: 'new@example.com', password: 'pw'})

      expect(result.success).toBe(true)
      const [{payload}] = event('login')
      expect(payload.method).toBe('register')
      expect(payload.user.email).toBe('new@example.com')
      expect(payload.user.password).toBeUndefined()
    })

    it('keeps the account but skips the session when beforeLogin denies', async () => {
      behavior.beforeLogin = () => false
      const result = await new Auth(makeRequest()).register({email: 'new@example.com', password: 'pw'})

      expect(result).toMatchObject({success: true, autoLogin: false})
      expect(users.some(u => u.email === 'new@example.com')).toBe(true)
      expect(tokens).toHaveLength(0)
      expect(event('loginFailed')[0].payload).toMatchObject({method: 'register', reason: 'denied'})
    })
  })

  describe('magic link', () => {
    const addLink = (email, raw = 'raw_token', expiresIn = 60000) =>
      magic.push({
        email,
        token_hash: '$sha256$' + nodeCrypto.createHash('sha256').update(raw).digest('hex'),
        expires_at: new Date(Date.now() + expiresIn)
      })

    it('reports an existing user signing in as "magic"', async () => {
      addLink('a@example.com')
      const result = await new Auth(makeRequest()).verifyMagicLink('raw_token', 'a@example.com')

      expect(result.success).toBe(true)
      expect(event('login').map(e => e.payload.method)).toEqual(['magic'])
    })

    it('reports a sign-up through a magic link as "magic", once', async () => {
      addLink('new@example.com')
      const result = await new Auth(makeRequest()).verifyMagicLink('raw_token', 'new@example.com')

      expect(result.success).toBe(true)
      expect(event('login').map(e => e.payload.method)).toEqual(['magic'])
      expect(tokens).toHaveLength(1)
    })

    it('fails the verification when beforeLogin denies, and asks only once', async () => {
      behavior.beforeLogin = () => false

      addLink('a@example.com')
      await expect(new Auth(makeRequest()).verifyMagicLink('raw_token', 'a@example.com')).resolves.toEqual({
        success: false,
        code: 'denied',
        error: 'Login failed'
      })

      addLink('new@example.com')
      await expect(new Auth(makeRequest()).verifyMagicLink('raw_token', 'new@example.com')).resolves.toEqual({
        success: false,
        code: 'denied',
        error: 'Login failed'
      })

      expect(event('beforeLogin')).toHaveLength(2)
      expect(tokens).toHaveLength(0)
    })

    it('reports an invalid or expired link', async () => {
      addLink('a@example.com', 'other_token')
      await new Auth(makeRequest()).verifyMagicLink('raw_token', 'a@example.com')
      await new Auth(makeRequest()).verifyMagicLink('raw_token', 'b@example.com')

      expect(event('loginFailed').map(e => e.payload)).toEqual([
        {identity: {email: 'a@example.com'}, method: 'magic', reason: 'invalid'},
        {identity: {email: 'b@example.com'}, method: 'magic', reason: 'invalid'}
      ])
    })

    it('reports an expired link as expired', async () => {
      addLink('a@example.com', 'raw_token', -1000)
      await new Auth(makeRequest()).verifyMagicLink('raw_token', 'a@example.com')
      expect(event('loginFailed')[0].payload).toEqual({identity: {email: 'a@example.com'}, method: 'magic', reason: 'expired'})
    })
  })
})
