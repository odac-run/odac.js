const Auth = require('../../src/Auth.js')
const Var = require('../../src/Var.js')

// Password logins are throttled in Auth.login() so the built-in form and custom controllers
// share one limit: per account + client IP, and per IP across all accounts.

describe('Auth.login() throttling', () => {
  let store
  let lookups
  const stored = new Var('s3cret').hash()

  const makeAuth = (ip = '203.0.113.9') =>
    new Auth({cookie: jest.fn(), header: name => (name === 'user-agent' ? 'TestBrowser' : null), ip, regenerateSession: jest.fn()})

  const usersTable = () => {
    const query = {
      where: () => query,
      then: (resolve, reject) => {
        lookups++
        return Promise.resolve([{id: 1, email: 'a@example.com', password: stored}]).then(resolve, reject)
      }
    }
    return query
  }

  let tokenInserts
  const tokensTable = () => {
    const query = {
      delete: () => Promise.resolve(0),
      insert: row => {
        tokenInserts.push(row)
        return Promise.resolve([1])
      },
      where: () => query
    }
    return query
  }

  beforeEach(() => {
    store = new Map()
    lookups = 0
    tokenInserts = []
    global.Odac = {
      Config: {auth: {table: 'users', token: 'user_tokens'}},
      DB: {
        fn: {now: () => new Date()},
        nanoid: () => 'nano',
        schema: {hasColumn: async () => true, hasTable: async () => true, alterTable: async () => {}},
        get users() {
          return usersTable()
        },
        get user_tokens() {
          return tokensTable()
        }
      },
      Ipc: {
        get: async key => store.get(key) ?? null,
        incrBy: async (key, delta, ttl) => {
          store.set(key, (store.get(key) ?? 0) + delta)
          store.set(`${key}#ttl`, ttl)
          return store.get(key)
        },
        del: async key => store.delete(key)
      },
      Var: value => new Var(value)
    }
  })

  afterEach(() => {
    delete global.Odac
  })

  const fail = (auth = makeAuth(), email = 'a@example.com') => auth.login({email, password: 'wrong'})

  it('blocks the account for that IP after five failures, even with the right password', async () => {
    for (let i = 0; i < 5; i++) await expect(fail()).resolves.toBe(false)

    const before = lookups
    await expect(makeAuth().login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(false)
    expect(lookups).toBe(before)
    await expect(makeAuth().loginThrottled({email: 'a@example.com', password: 'x'})).resolves.toBe(true)
  })

  it('does not lock the account out for other IPs', async () => {
    for (let i = 0; i < 5; i++) await fail()

    await expect(makeAuth('198.51.100.1').login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(true)
  })

  it('blocks an IP that fails across many accounts', async () => {
    for (let i = 0; i < 50; i++) await fail(makeAuth(), `user${i}@example.com`)

    await expect(makeAuth().loginThrottled({email: 'fresh@example.com', password: 'x'})).resolves.toBe(true)
  })

  it('counts failures in an expiring window', async () => {
    global.Odac.Config.auth.loginWindow = 10 * 60 * 1000
    await fail()

    const ttls = [...store.entries()].filter(([key]) => key.endsWith('#ttl')).map(([, ttl]) => ttl)
    expect(ttls).toEqual([600, 600])
  })

  it('clears the account counter after a successful login', async () => {
    for (let i = 0; i < 4; i++) await fail()
    await expect(makeAuth().login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(true)

    for (let i = 0; i < 4; i++) await fail()
    await expect(makeAuth().loginThrottled({email: 'a@example.com', password: 'x'})).resolves.toBe(false)
  })

  it('moves the visitor to a new session id and writes explicit token timestamps', async () => {
    const auth = makeAuth()
    const request = {cookie: jest.fn(), header: () => 'TestBrowser', ip: '203.0.113.9', regenerateSession: jest.fn()}
    await expect(new Auth(request).login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(true)

    expect(request.regenerateSession).toHaveBeenCalledTimes(1)
    expect(tokenInserts[0].date).toBeInstanceOf(Date)
    expect(tokenInserts[0].active).toBeInstanceOf(Date)
    await expect(auth.login({email: 'a@example.com', password: 'wrong'})).resolves.toBe(false)
  })

  it('verifies the password without the synchronous scrypt', async () => {
    const sync = jest.spyOn(Var.prototype, 'hashCheck')
    await expect(makeAuth().login({email: 'a@example.com', password: 's3cret'})).resolves.toBe(true)
    expect(sync).not.toHaveBeenCalled()
    sync.mockRestore()
  })

  it('does not throttle logins without a password (auto-login, magic link)', async () => {
    const auth = makeAuth()
    await expect(auth.loginThrottled({id: 1})).resolves.toBe(false)
    expect(store.size).toBe(0)
  })
})
