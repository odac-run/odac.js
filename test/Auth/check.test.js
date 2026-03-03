const Auth = require('../../src/Auth.js')

describe('Auth.check()', () => {
  let reqMock
  let authInstance

  /**
   * Why: Builds a chainable DB mock that resolves query results via .then() (thenable).
   * This simulates Knex's chainable query builder pattern.
   *
   * @param {Array} rows - The rows the query should resolve to.
   * @returns {object} Mock object with insert, update, delete, first, where tracking.
   */
  const createDbMock = rows => {
    const tracker = {
      deleteCalls: [],
      firstCalls: 0,
      insertCalls: [],
      updateCalls: []
    }

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

  beforeEach(() => {
    // Cookie storage to separate get/set behavior
    const cookieStore = {
      odac_x: 'old_x',
      odac_y: 'old_y'
    }

    reqMock = {
      cookie: jest.fn((name, value, options) => {
        // Setter mode: 2+ arguments
        if (value !== undefined) {
          cookieStore[name] = value
          return
        }
        // Getter mode: 1 argument
        return cookieStore[name] || null
      }),
      header: jest.fn(() => 'TestBrowser'),
      ip: '127.0.0.1',
      res: {} // HTTP context (non-null res indicates Set-Cookie can be delivered)
    }

    authInstance = new Auth(reqMock)

    global.Odac = {
      Config: {
        auth: {
          key: 'id',
          rotationAge: 15 * 60 * 1000,
          table: 'users',
          token: 'user_tokens'
        }
      },
      DB: {
        fn: {now: () => new Date()},
        nanoid: () => 'nano_' + Date.now()
      },
      Var: jest.fn(() => ({
        hash: jest.fn(() => 'hashed_value'),
        hashCheck: jest.fn(() => true)
      }))
    }
  })

  afterEach(() => {
    delete global.Odac
  })

  it('should rotate token when tokenAge exceeds rotationAge and set Epoch Date marker', async () => {
    const createdAt = Date.now() - 20 * 60 * 1000 // 20 mins ago -> exceeds 15 min rotationAge

    const mockRecord = {
      active: new Date(),
      browser: 'TestBrowser',
      date: new Date(createdAt),
      id: 'token_1',
      ip: '127.0.0.1',
      token_x: 'old_x',
      token_y: 'hashed_old_y',
      user: 'user_10'
    }

    const dbMock = createDbMock([mockRecord])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await authInstance.check()

    expect(result).toBe(true)

    // Verify new token was inserted
    expect(dbMock.insert).toHaveBeenCalledTimes(1)
    const inserted = dbMock.tracker.insertCalls[0]
    expect(inserted.user).toBe('user_10')
    expect(inserted.token_x).toBeDefined()
    expect(inserted.token_y).toBe('hashed_value')

    // Verify old token was marked with Epoch Date
    expect(dbMock.tracker.updateCalls.length).toBe(1)
    const updatePayload = dbMock.tracker.updateCalls[0]
    expect(updatePayload.date.getTime()).toBe(0) // Epoch

    // Verify new cookies were issued (setter calls)
    const setCalls = reqMock.cookie.mock.calls.filter(c => c.length >= 2)
    const xSet = setCalls.find(c => c[0] === 'odac_x' && c[2]?.httpOnly === true)
    const ySet = setCalls.find(c => c[0] === 'odac_y' && c[2]?.httpOnly === true)
    expect(xSet).toBeDefined()
    expect(ySet).toBeDefined()
    // New cookie values must differ from old ones
    expect(xSet[1]).not.toBe('old_x')
    expect(ySet[1]).not.toBe('old_y')
    // Cookie max-age must use proper HTTP attribute name (hyphenated, not camelCase)
    expect(xSet[2]['max-age']).toBeDefined()
    expect(xSet[2].maxAge).toBeUndefined()
  })

  it('should NOT rotate a recently-rotated token still within 5s threshold', async () => {
    // Simulate a rotated token where active was set to give ~60s grace period
    // and the rotation JUST happened (< 5 seconds ago)
    const maxAge = 30 * 24 * 60 * 60 * 1000
    const rotatedActiveDate = new Date(Date.now() - maxAge + 60000) // Grace period: ~60s left

    const mockRecord = {
      active: rotatedActiveDate,
      browser: 'TestBrowser',
      date: new Date(0), // Epoch marker = already rotated
      id: 'token_2',
      ip: '127.0.0.1',
      token_x: 'old_x',
      token_y: 'hashed_old_y',
      user: 'user_10'
    }

    const dbMock = createDbMock([mockRecord])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await authInstance.check()

    expect(result).toBe(true)
    // No rotation should occur (timeSinceRotation < 5000)
    expect(dbMock.insert).not.toHaveBeenCalled()
    expect(dbMock.tracker.updateCalls.length).toBe(0)
  })

  it('should recovery-rotate and DELETE old token when client lost cookies (rotated token > 5s)', async () => {
    // Simulate a rotated token where 10 seconds have passed since original rotation
    // Client still has old cookies -> recovery rotation should trigger
    const maxAge = 30 * 24 * 60 * 60 * 1000
    const timeSinceRotation = 10000 // 10 seconds since original rotation
    // active was set to: rotationTime - maxAge + 60000
    // So: inactiveAge = now - active = now - (rotationTime - maxAge + 60000) = timeSinceRotation + maxAge - 60000
    const rotatedActiveDate = new Date(Date.now() - maxAge + 60000 - timeSinceRotation)

    const mockRecord = {
      active: rotatedActiveDate,
      browser: 'TestBrowser',
      date: new Date(0), // Epoch marker = rotated
      id: 'token_recovery',
      ip: '127.0.0.1',
      token_x: 'old_x',
      token_y: 'hashed_old_y',
      user: 'user_10'
    }

    const dbMock = createDbMock([mockRecord])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await authInstance.check()

    expect(result).toBe(true)

    // Should insert a new token (recovery rotation)
    expect(dbMock.insert).toHaveBeenCalledTimes(1)
    const inserted = dbMock.tracker.insertCalls[0]
    expect(inserted.user).toBe('user_10')
    expect(inserted.token_x).toBeDefined()

    // Old token should be DELETED, not updated (prevents token multiplication)
    expect(dbMock.tracker.deleteCalls.length).toBe(1)
    expect(dbMock.tracker.updateCalls.length).toBe(0)

    // New cookies should be issued
    const setCalls = reqMock.cookie.mock.calls.filter(c => c.length >= 2)
    const xSet = setCalls.find(c => c[0] === 'odac_x' && c[2]?.httpOnly === true)
    const ySet = setCalls.find(c => c[0] === 'odac_y' && c[2]?.httpOnly === true)
    expect(xSet).toBeDefined()
    expect(ySet).toBeDefined()
    expect(xSet[1]).not.toBe('old_x')
    expect(ySet[1]).not.toBe('old_y')

    // Cookie max-age attribute should use proper HTTP naming (hyphenated)
    expect(xSet[2]['max-age']).toBeDefined()
    expect(xSet[2].maxAge).toBeUndefined()
  })

  it('should NOT rotate when tokenAge is within rotationAge threshold', async () => {
    const recentDate = Date.now() - 5 * 60 * 1000 // 5 mins ago -> within 15 min rotationAge

    const mockRecord = {
      active: new Date(),
      browser: 'TestBrowser',
      date: new Date(recentDate),
      id: 'token_3',
      ip: '127.0.0.1',
      token_x: 'old_x',
      token_y: 'hashed_old_y',
      user: 'user_10'
    }

    const dbMock = createDbMock([mockRecord])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await authInstance.check()

    expect(result).toBe(true)
    expect(dbMock.insert).not.toHaveBeenCalled()
    expect(dbMock.tracker.updateCalls.length).toBe(0)
  })

  it('should delete token and return false when inactiveAge exceeds maxAge', async () => {
    const staleActive = Date.now() - 31 * 24 * 60 * 60 * 1000 // 31 days ago -> exceeds 30 day maxAge

    const mockRecord = {
      active: new Date(staleActive),
      browser: 'TestBrowser',
      date: new Date(),
      id: 'token_4',
      ip: '127.0.0.1',
      token_x: 'old_x',
      token_y: 'hashed_old_y',
      user: 'user_10'
    }

    const dbMock = createDbMock([mockRecord])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await authInstance.check()

    expect(result).toBe(false)
    // Token should be deleted
    expect(dbMock.tracker.deleteCalls.length).toBe(1)
    // No rotation should occur
    expect(dbMock.insert).not.toHaveBeenCalled()
  })

  it('should skip rotation for WebSocket connections (res === null) and update active instead', async () => {
    const createdAt = Date.now() - 20 * 60 * 1000 // 20 mins ago -> exceeds 15 min rotationAge

    const wsReqMock = {
      cookie: jest.fn((name, value) => {
        if (value !== undefined) return
        return {odac_x: 'old_x', odac_y: 'old_y'}[name] || null
      }),
      header: jest.fn(() => 'TestBrowser'),
      ip: '127.0.0.1',
      res: null // WebSocket context: no HTTP response available
    }

    const wsAuth = new Auth(wsReqMock)

    const mockRecord = {
      active: new Date(),
      browser: 'TestBrowser',
      date: new Date(createdAt),
      id: 'token_ws',
      ip: '127.0.0.1',
      token_x: 'old_x',
      token_y: 'hashed_old_y',
      user: 'user_10'
    }

    const dbMock = createDbMock([mockRecord])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await wsAuth.check()

    expect(result).toBe(true)
    // No rotation: no new token inserted
    expect(dbMock.insert).not.toHaveBeenCalled()
    // Active timestamp should be refreshed instead
    expect(dbMock.tracker.updateCalls.length).toBe(1)
    expect(dbMock.tracker.updateCalls[0].active).toBeInstanceOf(Date)
    // No new cookies set (nothing to deliver over WS)
    const setCalls = wsReqMock.cookie.mock.calls.filter(c => c.length >= 2)
    expect(setCalls.length).toBe(0)
  })

  it('should skip recovery rotation for WebSocket connections (res === null)', async () => {
    const maxAge = 30 * 24 * 60 * 60 * 1000
    const timeSinceRotation = 10000 // 10 seconds since original rotation
    const rotatedActiveDate = new Date(Date.now() - maxAge + 60000 - timeSinceRotation)

    const wsReqMock = {
      cookie: jest.fn((name, value) => {
        if (value !== undefined) return
        return {odac_x: 'old_x', odac_y: 'old_y'}[name] || null
      }),
      header: jest.fn(() => 'TestBrowser'),
      ip: '127.0.0.1',
      res: null // WebSocket context
    }

    const wsAuth = new Auth(wsReqMock)

    const mockRecord = {
      active: rotatedActiveDate,
      browser: 'TestBrowser',
      date: new Date(0), // Epoch marker = rotated
      id: 'token_ws_recovery',
      ip: '127.0.0.1',
      token_x: 'old_x',
      token_y: 'hashed_old_y',
      user: 'user_10'
    }

    const dbMock = createDbMock([mockRecord])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await wsAuth.check()

    expect(result).toBe(true)
    // No recovery rotation: no insert, no delete
    expect(dbMock.insert).not.toHaveBeenCalled()
    expect(dbMock.tracker.deleteCalls.length).toBe(0)
    // No cookies set
    const setCalls = wsReqMock.cookie.mock.calls.filter(c => c.length >= 2)
    expect(setCalls.length).toBe(0)
  })

  it('should update active timestamp when inactiveAge exceeds updateAge but tokenAge is within rotationAge', async () => {
    const staleActive = Date.now() - 25 * 60 * 60 * 1000 // 25 hours ago -> exceeds 24h updateAge
    const recentDate = Date.now() - 5 * 60 * 1000 // 5 mins ago -> within rotationAge

    const mockRecord = {
      active: new Date(staleActive),
      browser: 'TestBrowser',
      date: new Date(recentDate),
      id: 'token_5',
      ip: '127.0.0.1',
      token_x: 'old_x',
      token_y: 'hashed_old_y',
      user: 'user_10'
    }

    const dbMock = createDbMock([mockRecord])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await authInstance.check()

    expect(result).toBe(true)
    // Should NOT rotate (tokenAge within threshold)
    expect(dbMock.insert).not.toHaveBeenCalled()
    // Should update active timestamp (fallback path)
    expect(dbMock.tracker.updateCalls.length).toBe(1)
    const updatePayload = dbMock.tracker.updateCalls[0]
    expect(updatePayload.active).toBeInstanceOf(Date)
    // Should NOT have Epoch marker
    expect(updatePayload.date).toBeUndefined()
  })
})
