const Form = require('../../../src/View/Form.js')

// <odac:magic-login> remembers where a failed link should return (error-redirect, or the page
// the form is on) and shows the failure that brought the visitor back.

describe('Form magic-login', () => {
  const makeOdac = ({url = '/login', error = null} = {}) => {
    const session = {}
    return {
      session,
      Auth: {magicError: jest.fn(() => error)},
      Request: {
        url,
        header: () => 'TestBrowser',
        ip: '203.0.113.9',
        session: jest.fn((key, value) => {
          if (value === undefined) return key === '_client' ? 'client' : (session[key] ?? null)
          session[key] = value
        })
      }
    }
  }

  const storedConfig = Odac => Object.values(Odac.session).find(entry => entry?.config)?.config

  describe('extractMagicLoginConfig()', () => {
    it('reads error-redirect without mistaking it for redirect', () => {
      const config = Form.extractMagicLoginConfig('<odac:magic-login error-redirect="/oops" redirect="/home"></odac:magic-login>')
      expect(config.redirect).toBe('/home')
      expect(config.errorRedirect).toBe('/oops')
    })

    it('reads redirect when it is the only attribute', () => {
      const config = Form.extractMagicLoginConfig('<odac:magic-login redirect="/home"></odac:magic-login>')
      expect(config.redirect).toBe('/home')
      expect(config.errorRedirect).toBeNull()
    })

    it('does not take error-redirect as redirect when only error-redirect is set', () => {
      const config = Form.extractMagicLoginConfig('<odac:magic-login error-redirect="/oops"></odac:magic-login>')
      expect(config.redirect).toBeNull()
      expect(config.errorRedirect).toBe('/oops')
    })
  })

  describe('openForm()', () => {
    it('returns failed links to the page the form is on by default', async () => {
      const Odac = makeOdac({url: '/auth/login?next=1'})
      await Form.openForm(Odac, 'magic-login', {redirect: '/home', errorRedirect: null, fields: []})
      expect(storedConfig(Odac).errorRedirect).toBe('/auth/login?next=1')
    })

    it('keeps an explicit error-redirect', async () => {
      const Odac = makeOdac({url: '/auth/login'})
      await Form.openForm(Odac, 'magic-login', {redirect: '/home', errorRedirect: '/link-error', fields: []})
      expect(storedConfig(Odac).errorRedirect).toBe('/link-error')
    })

    it('shows the failure that brought the visitor back, escaped', async () => {
      const Odac = makeOdac({error: {code: 'expired', message: 'Link <b>expired</b>.'}})
      const html = await Form.openForm(Odac, 'magic-login', {fields: []})

      expect(html).toContain('odac-form-error="_odac_form"')
      expect(html).toContain('data-odac-magic-error="expired"')
      expect(html).toContain('Link &lt;b&gt;expired&lt;/b&gt;.')
    })

    it('renders no error element without a failure', async () => {
      const html = await Form.openForm(makeOdac(), 'magic-login', {fields: []})
      expect(html).not.toContain('odac-form-error')
    })

    it('leaves other forms alone', async () => {
      const Odac = makeOdac({error: {code: 'expired', message: 'Expired.'}})
      const html = await Form.openForm(Odac, 'login', {fields: []})

      expect(html).not.toContain('odac-form-error')
      expect(Odac.Auth.magicError).not.toHaveBeenCalled()
      expect(storedConfig(Odac).errorRedirect).toBeUndefined()
    })
  })
})
