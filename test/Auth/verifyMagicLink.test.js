describe('Auth.verifyMagicLink()', () => {
  let Auth
  let reqMock
  let authInstance

  /**
   * Why: Builds a chainable DB mock simulating Knex's query builder pattern.
   * Tracks all insert/update/delete calls for assertion.
   * Supports orWhere, columnInfo, and schema — required by check(), register(), and migration helpers.
   *
   * @param {Array} rows - The rows the query should resolve to.
   * @returns {object} Mock with chainable query builder and call tracker.
   */
  const createDbMock = (rows = []) => {
    const tracker = {
      deleteCalls: [],
      firstResult: rows[0] || null,
      insertCalls: [],
      updateCalls: []
    }

    const chainable = () => ({
      delete: jest.fn((...args) => {
        tracker.deleteCalls.push(args)
        return Promise.resolve(true)
      }),
      first: jest.fn(() => Promise.resolve(tracker.firstResult)),
      insert: jest.fn(payload => {
        tracker.insertCalls.push(payload)
        return Promise.resolve(true)
      }),
      orWhere: jest.fn(() => chainable()),
      then: cb => cb(rows),
      update: jest.fn(payload => {
        tracker.updateCalls.push(payload)
        return Promise.resolve(true)
      }),
      where: jest.fn(() => chainable())
    })

    return {
      // columnInfo: used by register() to detect PK column type
      columnInfo: jest.fn(() => Promise.resolve({type: 'string'})),
      insert: jest.fn(payload => {
        tracker.insertCalls.push(payload)
        return Promise.resolve(true)
      }),
      // orWhere: entry point used by check(where) before chaining
      orWhere: jest.fn(() => chainable()),
      // schema: used by migration helpers (#ensureUserTableV2, #ensureTokenTableV2)
      schema: jest.fn(() => Promise.resolve()),
      tracker,
      where: jest.fn(() => chainable())
    }
  }

  /**
   * Why: Builds a minimal magic link record for DB mock responses.
   *
   * @param {object} overrides - Fields to override on the default record.
   * @returns {object} Magic link record.
   */
  const createMagicRecord = (overrides = {}) => ({
    browser: 'TestBrowser',
    email: 'test@example.com',
    expires_at: new Date(Date.now() + 15 * 60 * 1000),
    id: 1,
    ip: '127.0.0.1',
    token_hash: 'hashed_token',
    ...overrides
  })

  beforeEach(() => {
    // Isolate module per test to reset the static #migrationCache Set on Auth class
    jest.isolateModules(() => {
      Auth = require('../../src/Auth.js')
    })

    reqMock = {
      cookie: jest.fn((name, value) => {
        if (value !== undefined) return
        return null
      }),
      header: jest.fn(() => 'TestBrowser'),
      host: 'example.com',
      ip: '127.0.0.1',
      res: {},
      session: jest.fn(() => null),
      ssl: false
    }

    authInstance = new Auth(reqMock)

    global.Odac = {
      Config: {
        auth: {
          key: 'id',
          magicTable: 'odac_magic',
          table: 'users',
          token: 'odac_auth'
        }
      },
      DB: {
        fn: {now: () => new Date()},
        nanoid: () => 'nano_' + Date.now()
      },
      Var: jest.fn(() => ({
        hash: jest.fn(() => 'hashed_value'),
        hashCheck: jest.fn(() => true),
        is: jest.fn(() => false),
        md5: jest.fn(() => 'md5_value')
      }))
    }
  })

  afterEach(() => {
    delete global.Odac
  })

  // ─── EXISTING USER SCENARIOS ──────────────────────────────────────────────

  it('should log in an existing user and return success', async () => {
    const existingUser = {email: 'test@example.com', id: 'user_1', name: 'Test'}
    const magicDbMock = createDbMock([createMagicRecord()])
    // rows array is consumed by check(where) candidate query via .then()
    const usersDbMock = createDbMock([existingUser])
    usersDbMock.tracker.firstResult = existingUser
    const authDbMock = createDbMock()

    global.Odac.DB.odac_magic = magicDbMock
    global.Odac.DB.users = usersDbMock
    global.Odac.DB.odac_auth = authDbMock

    const result = await authInstance.verifyMagicLink('raw_token', 'test@example.com')

    expect(result.success).toBe(true)
    expect(result.user).toEqual(existingUser)
    // Exactly one login token must be inserted — no duplicate
    expect(authDbMock.tracker.insertCalls.length).toBe(1)
  })

  it('should consume (delete) all magic tokens for the email after successful verification', async () => {
    const existingUser = {email: 'test@example.com', id: 'user_1'}
    const magicDbMock = createDbMock([createMagicRecord()])
    const usersDbMock = createDbMock([existingUser])
    usersDbMock.tracker.firstResult = existingUser

    global.Odac.DB.odac_magic = magicDbMock
    global.Odac.DB.users = usersDbMock
    global.Odac.DB.odac_auth = createDbMock()

    await authInstance.verifyMagicLink('raw_token', 'test@example.com')

    // All magic tokens for this email must be deleted to prevent reuse
    expect(magicDbMock.tracker.deleteCalls.length).toBe(1)
  })

  // ─── NEW USER (AUTO-REGISTER) SCENARIOS ───────────────────────────────────

  it('should NOT create duplicate odac_auth tokens when auto-registering a new user', async () => {
    // Regression test: verifyMagicLink must not call login() a second time
    // when register() already performed auto-login internally.
    const newUser = {email: 'new@example.com', id: 'nano_new'}
    const magicDbMock = createDbMock([createMagicRecord({email: 'new@example.com'})])

    // Query path breakdown:
    //   first() calls → (1) verifyMagicLink existence check: null
    //                   (2) register unique field check: null
    //                   (3) register post-insert retrieval: newUser
    //   then() calls  → check(where) candidate query (used by login): always [newUser]
    let usersFirstCallCount = 0
    const usersDbMock = createDbMock()
    const usersChainable = () => ({
      delete: jest.fn(() => Promise.resolve(true)),
      first: jest.fn(() => {
        usersFirstCallCount++
        return Promise.resolve(usersFirstCallCount < 3 ? null : newUser)
      }),
      orWhere: jest.fn(() => usersChainable()),
      then: cb => cb([newUser]),
      update: jest.fn(() => Promise.resolve(true)),
      where: jest.fn(() => usersChainable())
    })
    usersDbMock.where = jest.fn(() => usersChainable())
    usersDbMock.orWhere = jest.fn(() => usersChainable())

    const authDbMock = createDbMock()

    global.Odac.DB.odac_magic = magicDbMock
    global.Odac.DB.users = usersDbMock
    global.Odac.DB.odac_auth = authDbMock

    const result = await authInstance.verifyMagicLink('raw_token', 'new@example.com')

    expect(result.success).toBe(true)
    // THE CRITICAL ASSERTION: register() auto-login + verifyMagicLink must produce exactly 1 token
    expect(authDbMock.tracker.insertCalls.length).toBe(1)
  })

  it('should return the newly registered user on success', async () => {
    const newUser = {email: 'new@example.com', id: 'nano_new'}
    const magicDbMock = createDbMock([createMagicRecord({email: 'new@example.com'})])

    let usersFirstCallCount = 0
    const usersDbMock = createDbMock()
    const usersChainable = () => ({
      delete: jest.fn(() => Promise.resolve(true)),
      first: jest.fn(() => {
        usersFirstCallCount++
        return Promise.resolve(usersFirstCallCount < 3 ? null : newUser)
      }),
      orWhere: jest.fn(() => usersChainable()),
      then: cb => cb([newUser]),
      update: jest.fn(() => Promise.resolve(true)),
      where: jest.fn(() => usersChainable())
    })
    usersDbMock.where = jest.fn(() => usersChainable())
    usersDbMock.orWhere = jest.fn(() => usersChainable())

    global.Odac.DB.odac_magic = magicDbMock
    global.Odac.DB.users = usersDbMock
    global.Odac.DB.odac_auth = createDbMock()

    const result = await authInstance.verifyMagicLink('raw_token', 'new@example.com')

    expect(result.success).toBe(true)
    expect(result.user).toBeDefined()
    expect(result.user.email).toBe('new@example.com')
  })

  // ─── FAILURE SCENARIOS ────────────────────────────────────────────────────

  it('should return error when tokenRaw is missing', async () => {
    const result = await authInstance.verifyMagicLink(null, 'test@example.com')
    expect(result.success).toBe(false)
    expect(result.error).toBe('Invalid link')
  })

  it('should return error when email is missing', async () => {
    const result = await authInstance.verifyMagicLink('raw_token', null)
    expect(result.success).toBe(false)
    expect(result.error).toBe('Invalid link')
  })

  it('should return error when no valid (non-expired) magic records exist', async () => {
    global.Odac.DB.odac_magic = createDbMock([])

    const result = await authInstance.verifyMagicLink('raw_token', 'test@example.com')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Link expired or invalid')
  })

  it('should return error when token hash does not match', async () => {
    global.Odac.Var = jest.fn(() => ({
      hash: jest.fn(() => 'hashed_value'),
      hashCheck: jest.fn(() => false),
      is: jest.fn(() => false)
    }))
    global.Odac.DB.odac_magic = createDbMock([createMagicRecord()])

    const result = await authInstance.verifyMagicLink('wrong_token', 'test@example.com')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Invalid token')
  })

  it('should NOT delete magic tokens when token hash does not match', async () => {
    global.Odac.Var = jest.fn(() => ({
      hash: jest.fn(() => 'hashed_value'),
      hashCheck: jest.fn(() => false),
      is: jest.fn(() => false)
    }))
    const magicDbMock = createDbMock([createMagicRecord()])
    global.Odac.DB.odac_magic = magicDbMock

    await authInstance.verifyMagicLink('wrong_token', 'test@example.com')

    expect(magicDbMock.tracker.deleteCalls.length).toBe(0)
  })
})
