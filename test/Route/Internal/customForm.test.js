const Internal = require('../../../src/Route/Internal')

// Internal.customForm builds the `form` helper handed to custom form actions.
// Covers the helper contract only (validation/session guards are exercised
// elsewhere): success() must be able to return action-computed data alongside
// the rotated token, and error() must accept a whole error map so a multi-field
// form can report every invalid field in one response.

const TOKEN = 'tok123'

function makeOdac(action, formConfig = {}) {
  const session = {
    _client: 'client-1',
    [`_custom_form_${TOKEN}`]: {
      expires: Date.now() + 60000,
      sessionId: 'client-1',
      userAgent: 'jest-agent',
      ip: '127.0.0.1',
      config: {token: TOKEN}
    }
  }

  return {
    session,
    request: jest.fn(async key => (key === '_odac_form_token' ? TOKEN : undefined)),
    return: jest.fn(data => data),
    file: jest.fn(),
    formData: {},
    formConfig: {action: 'Ctrl.handle', ...formConfig},
    formValidator: {error: async () => false, result: () => ({})},
    formUniqueFields: [],
    Route: {class: {Ctrl: {module: {handle: action}}}},
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

describe('Internal.customForm()', () => {
  describe('form.success()', () => {
    it('returns action data to the client alongside the rotated token', async () => {
      const Odac = makeOdac(async (_odac, form) => form.success('Avatar updated.', {data: {avatar: 'a1b2.png'}}))
      const out = await Internal.customForm(Odac)

      expect(out.result.success).toBe(true)
      expect(out.result.data).toEqual({avatar: 'a1b2.png'})
      expect(out.result._token).toEqual(expect.any(String))
      expect(Odac.session[`_custom_form_${out.result._token}`]).toBeTruthy()
      expect(Odac.session[`_custom_form_${TOKEN}`]).toBeNull()
    })

    it('omits data when the action does not provide any', async () => {
      const Odac = makeOdac(async (_odac, form) => form.success('Saved.'))
      const out = await Internal.customForm(Odac)

      expect(out.result.success).toBe(true)
      expect('data' in out.result).toBe(false)
    })

    it('keeps the legacy string signature working as a redirect', async () => {
      const Odac = makeOdac(async (_odac, form) => form.success('Saved.', '/thank-you'))
      const out = await Internal.customForm(Odac)

      expect(out.result.redirect).toBe('/thank-you')
      expect(out.result._token).toBeNull()
    })

    it('accepts redirect and data together', async () => {
      const Odac = makeOdac(async (_odac, form) => form.success('Saved.', {redirect: '/profile', data: {id: 7}}))
      const out = await Internal.customForm(Odac)

      expect(out.result.redirect).toBe('/profile')
      expect(out.result.data).toEqual({id: 7})
      expect(out.result._token).toBeNull()
    })

    it('falls back to the configured redirect when options omit one', async () => {
      const Odac = makeOdac(async (_odac, form) => form.success('Saved.', {data: {id: 7}}), {redirect: '/done'})
      const out = await Internal.customForm(Odac)

      expect(out.result.redirect).toBe('/done')
      expect(out.result.data).toEqual({id: 7})
    })
  })

  describe('form.error()', () => {
    it('reports a single field', async () => {
      const Odac = makeOdac(async (_odac, form) => form.error('email', 'Already registered'))
      const out = await Internal.customForm(Odac)

      expect(out.result.success).toBe(false)
      expect(out.errors).toEqual({email: 'Already registered'})
    })

    it('reports every field of a multi-field error map', async () => {
      const Odac = makeOdac(async (_odac, form) => form.error({email: 'Already registered', name: 'Too short'}))
      const out = await Internal.customForm(Odac)

      expect(out.result.success).toBe(false)
      expect(out.errors).toEqual({email: 'Already registered', name: 'Too short'})
    })
  })
})
