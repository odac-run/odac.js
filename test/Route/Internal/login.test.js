const Internal = require('../../../src/Route/Internal')

// Internal.login drives the built-in login form. See IMPROVEMENT-PLAN 1.2:
// Auth.login() returns a boolean, but Internal.login read loginResult.success /
// .error — so `true.success` was undefined and every successful login was
// reported to the client as a failure (even though cookies/token were set).

const TOKEN = 'tok123'

function makeOdac(loginImpl) {
  const session = {
    _client: 'client-1',
    [`_login_form_${TOKEN}`]: {
      expires: Date.now() + 60000,
      sessionId: 'client-1',
      userAgent: 'jest-agent',
      ip: '127.0.0.1',
      config: {
        redirect: '/dashboard',
        fields: [
          {name: 'username', validations: []},
          {name: 'password', validations: []}
        ]
      }
    }
  }

  const requestValues = {
    _odac_login_token: TOKEN,
    username: 'alice',
    password: 'secret'
  }

  return {
    request: jest.fn(async key => requestValues[key]),
    return: jest.fn(data => data),
    Auth: {login: jest.fn(loginImpl)},
    validator: () => ({error: async () => false, result: () => ({})}),
    Request: {
      ip: '127.0.0.1',
      header: jest.fn(() => 'jest-agent'),
      session: jest.fn((key, value) => {
        if (value === undefined) return session[key]
        session[key] = value
      })
    }
  }
}

describe('Internal.login()', () => {
  it('reports success when Auth.login succeeds (truthy)', async () => {
    const Odac = makeOdac(async () => true)
    const out = await Internal.login(Odac)
    expect(out.result.success).toBe(true)
    expect(out.result.redirect).toBe('/dashboard')
  })

  it('reports success when Auth.login returns a truthy non-boolean', async () => {
    const Odac = makeOdac(async () => [1]) // e.g. knex insert returning ids
    const out = await Internal.login(Odac)
    expect(out.result.success).toBe(true)
  })

  it('reports failure with a message when Auth.login fails (falsy)', async () => {
    const Odac = makeOdac(async () => false)
    const out = await Internal.login(Odac)
    expect(out.result.success).toBe(false)
    expect(out.errors._odac_form).toBeTruthy()
  })

  it('reports a service-unavailable message when Auth.login throws', async () => {
    const Odac = makeOdac(async () => {
      throw new Error('Database connection failed')
    })
    const out = await Internal.login(Odac)
    expect(out.result.success).toBe(false)
    expect(out.errors._odac_form).toMatch(/temporarily unavailable/i)
  })
})
