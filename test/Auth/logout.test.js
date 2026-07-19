const nodeCrypto = require('crypto')
const Auth = require('../../src/Auth.js')

// token_y is stored as a SHA-256 hash ($sha256$<hex>) of the odac_y cookie ('old_y').
const HASHED_OLD_Y = '$sha256$' + nodeCrypto.createHash('sha256').update('old_y').digest('hex')

// logout() must delete tokens from the SAME default table that check()/login()
// use ('odac_auth'), not a divergent 'user_tokens' fallback — see IMPROVEMENT-PLAN 2.3.

describe('Auth.logout()', () => {
  let reqMock

  const createDbMock = rows => {
    const tracker = {deleteCalls: [], firstCalls: 0, insertCalls: [], updateCalls: []}

    const chainable = () => ({
      delete: jest.fn((...args) => {
        tracker.deleteCalls.push(args)
        return Promise.resolve(true)
      }),
      first: jest.fn(() => {
        tracker.firstCalls++
        return Promise.resolve(rows[0] ? {id: rows[0].user, name: 'TestUser'} : null)
      }),
      update: jest.fn(payload => {
        tracker.updateCalls.push(payload)
        return Promise.resolve(true)
      }),
      then: cb => cb(rows),
      where: jest.fn(() => chainable())
    })

    return {
      chainable,
      insert: jest.fn(payload => {
        tracker.insertCalls.push(payload)
        return Promise.resolve(true)
      }),
      tracker,
      where: jest.fn(() => chainable())
    }
  }

  const validRecord = () => ({
    active: new Date(),
    browser: 'TestBrowser',
    date: new Date(), // "now" -> no rotation, keeps check() simple
    id: 'tok_1',
    ip: '127.0.0.1',
    token_x: 'old_x',
    token_y: HASHED_OLD_Y,
    user: 'user_10'
  })

  beforeEach(() => {
    const cookieStore = {odac_x: 'old_x', odac_y: 'old_y'}
    reqMock = {
      cookie: jest.fn((name, value) => {
        if (value !== undefined) {
          cookieStore[name] = value
          return
        }
        return cookieStore[name] || null
      }),
      header: jest.fn(name => (name === 'user-agent' ? 'TestBrowser' : null)),
      ip: '127.0.0.1',
      res: {}
    }

    global.Odac = {
      Config: {auth: {key: 'id', rotationAge: 15 * 60 * 1000, table: 'users'}}, // NOTE: no `token` -> exercises the fallback
      DB: {
        fn: {now: () => new Date()},
        nanoid: () => 'nano_' + Date.now(),
        schema: {
          alterTable: jest.fn(() => Promise.resolve()),
          createTable: jest.fn(() => Promise.resolve()),
          hasColumn: jest.fn(() => Promise.resolve(true)),
          hasTable: jest.fn(() => Promise.resolve(true))
        }
      },
      Var: jest.fn(() => ({hash: jest.fn(() => 'hashed_value'), hashCheck: jest.fn(() => true)}))
    }
  })

  afterEach(() => {
    delete global.Odac
  })

  it('deletes from the default odac_auth table when config.auth.token is unset', async () => {
    const odacAuthDb = createDbMock([validRecord()])
    const userTokensDb = createDbMock([])
    global.Odac.DB.odac_auth = odacAuthDb
    global.Odac.DB.user_tokens = userTokensDb
    global.Odac.DB.users = odacAuthDb

    const auth = new Auth(reqMock)
    expect(await auth.check()).toBe(true) // logs the user in so logout has a #user

    const result = await auth.logout()

    expect(result).toBe(true)
    // The token must be deleted from odac_auth, NOT from the stray user_tokens table.
    expect(odacAuthDb.tracker.deleteCalls.length).toBeGreaterThan(0)
    expect(userTokensDb.tracker.deleteCalls.length).toBe(0)
  })

  it('honors a custom configured token table on logout', async () => {
    global.Odac.Config.auth.token = 'sessions'
    const sessionsDb = createDbMock([validRecord()])
    global.Odac.DB.sessions = sessionsDb
    global.Odac.DB.users = sessionsDb

    const auth = new Auth(reqMock)
    expect(await auth.check()).toBe(true)

    expect(await auth.logout()).toBe(true)
    expect(sessionsDb.tracker.deleteCalls.length).toBeGreaterThan(0)
  })

  it('returns false without touching the DB when no user is logged in', async () => {
    const odacAuthDb = createDbMock([])
    global.Odac.DB.odac_auth = odacAuthDb
    global.Odac.DB.users = odacAuthDb

    const auth = new Auth(reqMock)
    expect(await auth.logout()).toBe(false)
    expect(odacAuthDb.tracker.deleteCalls.length).toBe(0)
  })
})
