const Form = require('../../../src/View/Form.js')
const {project} = require('../project')

// <odac:submit> text, loading and body must accept translation expressions and
// <odac translate> markup, and resolve them per request like any other view content.

describe('Form <odac:submit>', () => {
  describe('parseSubmit()', () => {
    it('keeps translation expressions in text and loading intact', () => {
      const submit = Form.parseSubmit(` text="{{ __('Login') }}" loading="{{ __('Logging in...') }}"`)
      expect(submit.text).toBe("{{ __('Login') }}")
      expect(submit.loading).toBe("{{ __('Logging in...') }}")
    })

    it('accepts double quotes inside single-quoted values', () => {
      const submit = Form.parseSubmit(` text='{{ __("Save") }}'`)
      expect(submit.text).toBe('{{ __("Save") }}')
    })

    it('does not read text from loading-text or data-text', () => {
      const submit = Form.parseSubmit(` data-text="x" loading="Wait"`)
      expect(submit.text).toBeNull()
      expect(submit.loading).toBe('Wait')
    })

    it('uses a plain body as the button text', () => {
      expect(Form.parseSubmit('', '  Kaydet  ').text).toBe('Kaydet')
      expect(Form.parseSubmit('', "{{ __('Kaydet') }}").text).toBe("{{ __('Kaydet') }}")
    })

    it('treats a body with markup as html, leaving the text unset', () => {
      const submit = Form.parseSubmit('', '<odac translate>Login</odac>')
      expect(submit.html).toBe('<odac translate>Login</odac>')
      expect(submit.text).toBeNull()
    })

    it('does not mistake a comparison inside an expression for markup', () => {
      const submit = Form.parseSubmit('', '{{ count < 2 ? "One" : "Many" }}')
      expect(submit.html).toBeNull()
      expect(submit.text).toBe('{{ count < 2 ? "One" : "Many" }}')
    })

    it('prefers the text attribute over the body', () => {
      const submit = Form.parseSubmit(' text="Send"', '<b>Ignored</b>')
      expect(submit.text).toBe('Send')
      expect(submit.html).toBeNull()
    })
  })

  describe('applySubmitConfig()', () => {
    it('reads the body of a paired tag', () => {
      const config = {}
      Form.applySubmitConfig('<odac:submit>Kaydet</odac:submit>', config)
      expect(config.submitText).toBe('Kaydet')
    })

    it('reads attributes of a self-closing tag', () => {
      const config = {}
      Form.applySubmitConfig(`<odac:submit text="{{ __('Go') }}" class="btn" id="go"/>`, config)
      expect(config).toEqual({submitText: "{{ __('Go') }}", submitClass: 'btn', submitId: 'go'})
    })

    it('returns false without a submit tag', () => {
      expect(Form.applySubmitConfig('<div></div>', {})).toBe(false)
    })
  })

  describe('generateSubmitButton()', () => {
    const meta = Form.FORM_META.form

    it('leaves template tokens unescaped and escapes the rest', () => {
      const html = Form.generateSubmitButton({submitText: `{{ __('Login') }} "now"`, submitLoading: "{{ __('Wait') }}"}, meta)
      expect(html).toBe(
        `<button type="submit" data-submit-text="{{ __('Login') }} &quot;now&quot;" data-loading-text="{{ __('Wait') }}">{{ __('Login') }} &quot;now&quot;</button>`
      )
    })

    it('emits a markup body verbatim without data-submit-text', () => {
      const html = Form.generateSubmitButton({submitHtml: '<odac translate>Login</odac>'}, meta)
      expect(html).toBe('<button type="submit" data-loading-text="Processing..."><odac translate>Login</odac></button>')
    })

    it('falls back to the form type defaults', () => {
      expect(Form.generateSubmitButton({}, Form.FORM_META.login)).toBe(
        '<button type="submit" data-submit-text="Login" data-loading-text="Logging in...">Login</button>'
      )
    })
  })

  describe('rendered view', () => {
    const p = project()
    beforeEach(p.setup)
    afterEach(p.teardown)

    const dictionary = {Login: 'Giriş', 'Logging in...': 'Giriş yapılıyor...', Save: 'Kaydet', Send: 'Gönder'}

    const render = async name => {
      const view = p.view()
      Object.assign(p.odac.Request, {ip: '203.0.113.9', session: jest.fn(() => null)})
      p.odac.View.Form = Form
      p.odac.Lang = {get: key => dictionary[key] ?? key, getx: key => dictionary[key] ?? key}
      view.set({content: name})
      await view.print()
      return p.odac.Request.end.mock.calls[0]?.[0]?.output?.content
    }

    it('translates text and loading attributes', async () => {
      await p.write(
        'view/content/attrs.html',
        `<odac:login><odac:submit text="{{ __('Login') }}" loading="{{ __('Logging in...') }}"/></odac:login>`
      )
      const html = await render('attrs')
      expect(html).toContain('<button type="submit" data-submit-text="Giriş" data-loading-text="Giriş yapılıyor...">Giriş</button>')
    })

    it('translates an <odac translate> body', async () => {
      await p.write('view/content/body.html', '<odac:form><odac:submit class="btn"><odac translate>Save</odac></odac:submit></odac:form>')
      const html = await render('body')
      expect(html).toContain('<button type="submit" data-loading-text="Processing..." class="btn">Kaydet</button>')
    })

    it('translates input labels and placeholders', async () => {
      await p.write(
        'view/content/input.html',
        `<odac:login><odac:input name="email" label="{{ __('Login') }}" placeholder="{{ __('Send') }}"/></odac:login>`
      )
      const html = await render('input')
      expect(html).toContain('placeholder="Gönder"')
      expect(html).toContain('<label for="odac-email">Giriş</label>')
    })

    it('translates the magic-login email-label and submit-text attributes', async () => {
      await p.write(
        'view/content/magic.html',
        `<odac:magic-login email-label="{{ __('Login') }}" submit-text="{{ __('Send') }}"></odac:magic-login>`
      )
      const html = await render('magic')
      expect(html).toContain('<label for="odac-email">Giriş</label>')
      expect(html).toContain('>Gönder</button>')
    })

    it('renders each submit tag with its own settings', async () => {
      await p.write(
        'view/content/multi.html',
        `<odac:form><odac:submit text="{{ __('Save') }}"/><odac:submit id="b">Send</odac:submit></odac:form>`
      )
      const html = await render('multi')
      expect(html).toContain('data-submit-text="Kaydet" data-loading-text="Processing...">Kaydet</button>')
      expect(html).toContain('data-submit-text="Send" data-loading-text="Processing..." id="b">Send</button>')
    })
  })
})
