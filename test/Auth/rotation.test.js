const nodeCrypto = require('crypto')
const Auth = require('../../src/Auth.js')

// Token rotation is claimed with a conditional write so concurrent requests carrying the same
// cookie rotate exactly once, and timestamps are read the same way on every driver.

const HASHED_OLD_Y = '$sha256$' + nodeCrypto.createHash('sha256').update('old_y').digest('hex')
const FIFTEEN_MINUTES = 15 * 60 * 1000

describe('Auth token rotation', () => {
  let tokens
  let claims

  // A token table whose conditional updates answer from `claims` in order, like a database
  // where only the first UPDATE ... WHERE date >= threshold still matches the row.
  const tokenTable = row => {
    tokens = {inserts: [], updates: [], deletes: 0, conditions: []}
    const chain = (conditions = []) => {
      const query = {
        where: (...args) => chain([...conditions, args]),
        update: payload => {
          tokens.updates.push({payload, conditions})
          tokens.conditions.push(conditions)
          return Promise.resolve(claims.length ? claims.shift() : 1)
        },
        delete: () => {
          tokens.deletes++
          return Promise.resolve(claims.length ? claims.shift() : 1)
        },
        then: (resolve, reject) => Promise.resolve([row]).then(resolve, reject)
      }
      return query
    }
    return {
      where: (...args) => chain([args]),
      insert: payload => {
        tokens.inserts.push(payload)
        return tokens.insertResult ?? Promise.resolve([1])
      }
    }
  }

  const makeRequest = () => {
    const cookies = {odac_x: 'old_x', odac_y: 'old_y'}
    const set = []
    return {
      set,
      cookie: (name, value) => {
        if (value === undefined) return cookies[name] ?? null
        set.push(name)
      },
      header: name => (name === 'user-agent' ? 'TestBrowser' : null),
      ip: '127.0.0.1',
      res: {}
    }
  }

  const setup = row => {
    const table = tokenTable(row)
    global.Odac = {
      Config: {auth: {key: 'id', table: 'users', token: 'user_tokens', rotationAge: FIFTEEN_MINUTES}},
      DB: {
        nanoid: () => 'nano',
        schema: {hasTable: async () => true, hasColumn: async () => true, alterTable: async () => {}},
        user_tokens: table,
        users: {where: () => ({first: async () => ({id: 'u1'})})}
      }
    }
  }

  const tokenRow = overrides => ({
    id: 'tok_1',
    user: 'u1',
    token_x: 'old_x',
    token_y: HASHED_OLD_Y,
    browser: 'TestBrowser',
    ip: '127.0.0.1',
    accept_language: null,
    date: new Date(Date.now() - 2 * FIFTEEN_MINUTES),
    active: new Date(),
    ...overrides
  })

  beforeEach(() => {
    claims = []
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete global.Odac
  })

  it('rotates once when two requests present the same token concurrently', async () => {
    setup(tokenRow())
    claims = [1, 0]
    const first = makeRequest()
    const second = makeRequest()

    const results = await Promise.all([new Auth(first).check(), new Auth(second).check()])

    expect(results).toEqual([true, true])
    expect(tokens.inserts).toHaveLength(1)
    expect([first.set.length, second.set.length].sort()).toEqual([0, 2])
  })

  it('claims only a row that has not been rotated yet', async () => {
    setup(tokenRow())
    await new Auth(makeRequest()).check()
    const claim = tokens.updates[0]
    expect(claim.conditions).toContainEqual(['date', '>=', new Date(31536000000)])
    expect(claim.payload.date).toEqual(new Date(0))
  })

  it('restores the old token when the replacement cannot be stored', async () => {
    const row = tokenRow()
    setup(row)
    tokens.insertResult = Promise.reject(new Error('disk full'))
    const request = makeRequest()

    await expect(new Auth(request).check()).resolves.toBe(true)
    expect(request.set).toHaveLength(0)
    const restore = tokens.updates[1]
    expect(restore.payload).toEqual({date: row.date, active: row.active})
  })

  it('consumes a recovery token with a delete before minting its replacement', async () => {
    const maxAge = 30 * 24 * 60 * 60 * 1000
    // A rotated row: epoch date, active set to (rotation time - maxAge + grace), rotated 10 s ago.
    setup(tokenRow({date: new Date(0), active: new Date(Date.now() - 10000 - maxAge + 30000)}))
    claims = [0]
    const request = makeRequest()

    await new Auth(request).check()
    expect(tokens.deletes).toBe(1)
    expect(tokens.inserts).toHaveLength(0) // another request already consumed it
    expect(request.set).toHaveLength(0)
  })

  it('reads a zoneless SQLite text timestamp as UTC instead of local time', async () => {
    // What a CURRENT_TIMESTAMP default stores: UTC, no zone designator.
    const nowText = new Date().toISOString().slice(0, 19).replace('T', ' ')
    setup(tokenRow({date: nowText, active: nowText}))

    await new Auth(makeRequest()).check()
    // A fresh token: no rotation claim and no replacement.
    expect(tokens.updates).toHaveLength(0)
    expect(tokens.inserts).toHaveLength(0)
  })
})
