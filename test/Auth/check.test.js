const nodeCrypto = require('crypto')
const Auth = require('../../src/Auth.js')

// token_y is stored as a SHA-256 hash ($sha256$<hex>) of the odac_y cookie ('old_y').
const HASHED_OLD_Y = '$sha256$' + nodeCrypto.createHash('sha256').update('old_y').digest('hex')

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
      header: jest.fn(name => (name === 'user-agent' ? 'TestBrowser' : null)),
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
        nanoid: () => 'nano_' + Date.now(),
        // schema: used by #ensureTokenTableV2 migration (hasTable/hasColumn/alterTable)
        schema: {
          alterTable: jest.fn(() => Promise.resolve()),
          createTable: jest.fn(() => Promise.resolve()),
          hasColumn: jest.fn(() => Promise.resolve(true)),
          hasTable: jest.fn(() => Promise.resolve(true))
        }
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
      token_y: HASHED_OLD_Y,
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
    // token_y is now a fast SHA-256 hash of the fresh secret
    expect(inserted.token_y).toMatch(/^\$sha256\$[a-f0-9]{64}$/)

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
    const rotatedActiveDate = new Date(Date.now() - maxAge + 30000) // Grace period (30s) just started

    const mockRecord = {
      active: rotatedActiveDate,
      browser: 'TestBrowser',
      date: new Date(0), // Epoch marker = already rotated
      id: 'token_2',
      ip: '127.0.0.1',
      token_x: 'old_x',
      token_y: HASHED_OLD_Y,
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
    // active was set to: rotationTime - maxAge + grace (30s)
    // So: inactiveAge = now - active = timeSinceRotation + maxAge - grace
    const rotatedActiveDate = new Date(Date.now() - maxAge + 30000 - timeSinceRotation)

    const mockRecord = {
      active: rotatedActiveDate,
      browser: 'TestBrowser',
      date: new Date(0), // Epoch marker = rotated
      id: 'token_recovery',
      ip: '127.0.0.1',
      token_x: 'old_x',
      token_y: HASHED_OLD_Y,
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
      token_y: HASHED_OLD_Y,
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
      token_y: HASHED_OLD_Y,
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
      header: jest.fn(name => (name === 'user-agent' ? 'TestBrowser' : null)),
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
      token_y: HASHED_OLD_Y,
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
    const rotatedActiveDate = new Date(Date.now() - maxAge + 30000 - timeSinceRotation)

    const wsReqMock = {
      cookie: jest.fn((name, value) => {
        if (value !== undefined) return
        return {odac_x: 'old_x', odac_y: 'old_y'}[name] || null
      }),
      header: jest.fn(name => (name === 'user-agent' ? 'TestBrowser' : null)),
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
      token_y: HASHED_OLD_Y,
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
      token_y: HASHED_OLD_Y,
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

  // ─── SESSION ANOMALY DETECTION ────────────────────────────────────────────

  const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
  const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  const CHROME_WIN_OLD = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'

  // Builds a request whose headers/ip/cookies can differ from the stored token.
  const buildReq = ({ua = CHROME_WIN, lang = 'en-US', ip = '127.0.0.1', y = 'old_y'} = {}) => {
    const store = {odac_x: 'old_x', odac_y: y}
    return {
      cookie: jest.fn((name, value) => {
        if (value !== undefined) {
          store[name] = value
          return
        }
        return store[name] || null
      }),
      header: jest.fn(name => (name === 'user-agent' ? ua : name === 'accept-language' ? lang : null)),
      ip,
      res: {}
    }
  }

  // Fresh, non-rotating token record (recent active + date) so only the anomaly
  // path is exercised.
  const freshRecord = (overrides = {}) => ({
    accept_language: 'en-US',
    active: new Date(),
    browser: CHROME_WIN,
    date: new Date(),
    id: 'tok_anomaly',
    ip: '127.0.0.1',
    token_x: 'old_x',
    token_y: HASHED_OLD_Y,
    user: 'user_10',
    ...overrides
  })

  it('deletes the token and fails when the browser family changes', async () => {
    const dbMock = createDbMock([freshRecord()])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await new Auth(buildReq({ua: FIREFOX_WIN})).check()

    expect(result).toBe(false)
    expect(dbMock.tracker.deleteCalls.length).toBe(1)
    expect(dbMock.insert).not.toHaveBeenCalled()
  })

  it('deletes the token and fails when the OS family changes', async () => {
    const dbMock = createDbMock([freshRecord()])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await new Auth(buildReq({ua: CHROME_MAC})).check()

    expect(result).toBe(false)
    expect(dbMock.tracker.deleteCalls.length).toBe(1)
  })

  it('deletes the token and fails on a browser version downgrade', async () => {
    const dbMock = createDbMock([freshRecord()])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await new Auth(buildReq({ua: CHROME_WIN_OLD})).check()

    expect(result).toBe(false)
    expect(dbMock.tracker.deleteCalls.length).toBe(1)
  })

  it('deletes the token when the IP moves and Accept-Language differs', async () => {
    const dbMock = createDbMock([freshRecord()])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await new Auth(buildReq({ip: '8.8.8.8', lang: 'fr-FR'})).check()

    expect(result).toBe(false)
    expect(dbMock.tracker.deleteCalls.length).toBe(1)
  })

  it('allows an IP change alone when UA and language are unchanged', async () => {
    const dbMock = createDbMock([freshRecord()])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await new Auth(buildReq({ip: '8.8.8.8'})).check()

    expect(result).toBe(true)
    expect(dbMock.tracker.deleteCalls.length).toBe(0)
  })

  it('skips the language rule and backfills when a legacy row has no accept_language baseline', async () => {
    // Pre-migration row: accept_language is NULL. An IP move with a differing
    // language must NOT kill the session; instead the baseline is backfilled.
    const dbMock = createDbMock([freshRecord({accept_language: null})])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await new Auth(buildReq({ip: '8.8.8.8', lang: 'fr-FR'})).check()

    expect(result).toBe(true)
    expect(dbMock.tracker.deleteCalls.length).toBe(0)
    // Backfill update stores the current language as the new baseline
    const backfill = dbMock.tracker.updateCalls.find(p => p.accept_language === 'fr-FR')
    expect(backfill).toBeDefined()
  })

  it('refreshes the UA baseline during activity updates so legitimate drift does not accumulate', async () => {
    const CHROME_WIN_121 = CHROME_WIN.replace('Chrome/120', 'Chrome/121')
    // inactiveAge > updateAge (24h) triggers the activity update; date recent
    // enough to stay under rotationAge is impossible here, so disable rotation
    // to exercise the non-rotating fallback path.
    global.Odac.Config.auth.rotation = false

    const dbMock = createDbMock([
      freshRecord({
        active: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago -> exceeds updateAge
        date: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) // old token, rotation disabled
      })
    ])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    // Same family/OS, +1 major version: legitimate drift, not an anomaly
    const result = await new Auth(buildReq({ua: CHROME_WIN_121})).check()

    expect(result).toBe(true)
    expect(dbMock.tracker.deleteCalls.length).toBe(0)
    // Activity update must carry the new UA as the refreshed baseline
    const refresh = dbMock.tracker.updateCalls.find(p => p.browser === CHROME_WIN_121)
    expect(refresh).toBeDefined()
    expect(refresh.active).toBeInstanceOf(Date)
  })

  it('classifies iOS browser variants (CriOS) consistently with their desktop family', async () => {
    const CHROME_IOS =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1'
    const SAFARI_IOS =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

    // Stored: Chrome on iOS. Presented: Safari on iOS -> browser family change -> delete.
    const dbMock = createDbMock([freshRecord({browser: CHROME_IOS})])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await new Auth(buildReq({ua: SAFARI_IOS})).check()

    expect(result).toBe(false)
    expect(dbMock.tracker.deleteCalls.length).toBe(1)
  })

  it('sweeps expired tokens from the request path, not only on login', async () => {
    // Force the throttle window open (static #lastTokenSweep starts at process
    // start, so default-interval tests never sweep)
    global.Odac.Config.auth.sweepInterval = -1

    const dbMock = createDbMock([freshRecord()])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await new Auth(buildReq()).check()

    expect(result).toBe(true)
    // The only delete in this healthy-session scenario is the range sweep
    expect(dbMock.tracker.deleteCalls.length).toBe(1)
  })

  // ─── PER-REQUEST MEMOIZATION ──────────────────────────────────────────────
  // Route.check() calls Auth.check() at several user-code boundaries (see
  // IMPROVEMENT-PLAN 3.3). Cookies are immutable for the lifetime of a
  // request, so neither outcome can change between those calls: a successful
  // check is served from #user, and a failed one must not re-query the token
  // table at every boundary (stale-cookie visitors would otherwise pay up to
  // 3-4 identical queries per request).

  it('memoizes a failed token check within the request (no repeated queries)', async () => {
    const dbMock = createDbMock([]) // no matching token row -> check fails
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    expect(await authInstance.check()).toBe(false)
    const queriesAfterFirst = dbMock.where.mock.calls.length
    expect(queriesAfterFirst).toBeGreaterThan(0)

    expect(await authInstance.check()).toBe(false)
    expect(dbMock.where.mock.calls.length).toBe(queriesAfterFirst)
  })

  it('serves repeated successful checks from memory after the first', async () => {
    const dbMock = createDbMock([freshRecord()])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const auth = new Auth(buildReq())
    expect(await auth.check()).toBe(true)
    const queriesAfterFirst = dbMock.where.mock.calls.length

    expect(await auth.check()).toBe(true)
    expect(dbMock.where.mock.calls.length).toBe(queriesAfterFirst)
  })

  it('accepts a legacy scrypt-hashed token for backward compatibility', async () => {
    // #verifyToken routes $scrypt$ tokens through Odac.Var().hashCheck() (mocked true).
    const dbMock = createDbMock([freshRecord({token_y: '$scrypt$deadbeef$cafe'})])
    global.Odac.DB.user_tokens = dbMock
    global.Odac.DB.users = dbMock

    const result = await new Auth(buildReq()).check()

    expect(result).toBe(true)
    expect(dbMock.tracker.deleteCalls.length).toBe(0)

    // In-place upgrade: the same secret must be rehashed to SHA-256 so the
    // scrypt hash disappears after the first successful verification
    const upgrade = dbMock.tracker.updateCalls.find(p => p.token_y)
    expect(upgrade).toBeDefined()
    expect(upgrade.token_y).toBe(HASHED_OLD_Y)
  })
})
