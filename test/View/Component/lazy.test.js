const fsSync = require('fs')
const path = require('path')
const {project} = require('../project')
const Lazy = require('../../../src/View/Lazy')

// `<c:name lazy>` renders a placeholder holding an encrypted token; `/_odac/lazy` renders the
// component from that token in a second request. The token cannot be read, changed or used by
// another signed-in user, and expires.
describe('View lazy components', () => {
  const app = project()
  beforeEach(() => {
    app.setup()
    Lazy.reset()
  })
  afterEach(app.teardown)

  let pages
  beforeEach(() => {
    pages = 0
  })
  const page = async (html, options) => {
    const name = `page${++pages}`
    await app.write(`view/content/${name}.html`, html)
    return app.render(name, options)
  }

  const tokenOf = html => html.match(/data-odac-lazy="([A-Za-z0-9_-]+)"/)[1]

  // Serves `/_odac/lazy?t=<token>` with a fresh request context; `user` is the signed-in id.
  const serve = async (token, {user = null, header = 'lazy', lang, configure} = {}) => {
    const view = app.view()
    const odac = app.odac
    odac.Request.header = jest.fn(name => (name === 'X-Odac' ? header : undefined))
    odac.Request.data = {get: {t: token}}
    odac.Auth = {user: key => (user === null ? false : key === 'id' ? user : undefined)}
    odac.Lang.set = jest.fn()
    if (lang) odac.Lang.current = () => lang
    configure?.(odac)
    odac.View = view
    const result = await Lazy.serve(odac)
    return {result, odac}
  }

  beforeEach(async () => {
    await app.write(
      'view/components/comments.html',
      [
        '<odac:props :postId />',
        '<odac:push to="head"><link rel="stylesheet" href="/css/comments.css"></odac:push>',
        "<section {!! attrs.class('comments') !!}>Post {{ postId }}</section>"
      ].join('\n')
    )
  })

  describe('placeholder', () => {
    it('renders a placeholder with a token instead of the component, around the tag children', async () => {
      const html = await page('<c:comments lazy :post-id="7" class="mt-4"><p>Loading</p></c:comments>')
      expect(html).toMatch(/^<odac-lazy data-odac-lazy="[A-Za-z0-9_-]+"><p>Loading<\/p><\/odac-lazy>$/)
      expect(html).not.toContain('Post 7')
    })

    it('marks lazy="load" placeholders to load without waiting for visibility', async () => {
      expect(await page('<c:comments lazy="load" :post-id="1" />')).toMatch(
        /^<odac-lazy data-odac-lazy="[^"]+" data-odac-when="load"><\/odac-lazy>$/
      )
    })

    it('renders the placeholder in the caller scope', async () => {
      const html = await page('<odac:for in="[1, 2]" value="id"><c:comments lazy :post-id="id">#{{ id }}</c:comments></odac:for>')
      expect(html.match(/<odac-lazy [^>]+>#1<\/odac-lazy><odac-lazy [^>]+>#2<\/odac-lazy>/)).not.toBeNull()
    })

    it('encrypts the props: they do not appear in the page', async () => {
      const html = await page(`<c:comments lazy :post-id="'secret-value-123'" />`)
      expect(Buffer.from(tokenOf(html), 'base64url').toString('latin1')).not.toContain('secret-value-123')
    })

    it('fails the page for a missing component or a missing required prop', async () => {
      expect(await page('<c:nope lazy />')).toBeUndefined()
      expect(app.logged()).toContain('Component "nope" not found')
      expect(await page('<p>x</p>\n<c:comments lazy />')).toBeUndefined()
      expect(app.logged()).toContain('Component "comments" requires the "postId" prop\n  in line 2')
    })

    it('fails the page when props are too large or cannot be serialized', async () => {
      expect(await page(`<c:comments lazy :post-id="'x'.repeat(${Lazy.MAX_PAYLOAD})" />`)).toBeUndefined()
      expect(app.logged()).toContain('pass ids and load the data in the component')
      expect(await page('<c:comments lazy :post-id="() => 1" />')).toBeUndefined()
      expect(app.logged()).toContain('Lazy component "comments" has a prop that cannot be sent to the browser')
    })
  })

  describe('lazy request', () => {
    it('renders the component with the props and attributes of the tag, with its pushes', async () => {
      const token = tokenOf(await page('<c:comments lazy :post-id="7" class="mt-4" data-x="{{ 1 + 1 }}" />'))
      const {result} = await serve(token)
      expect(result).toEqual({
        html: '<section class="comments mt-4" data-x="2">Post 7</section>',
        stacks: {head: [{key: expect.stringMatching(/^[0-9a-f]{16}$/), html: '<link rel="stylesheet" href="/css/comments.css">'}]}
      })
    })

    it('keeps value types through the token', async () => {
      await app.write(
        'view/components/types.html',
        '<odac:props :v />\n{{ typeof v.n }} {{ v.d.getTime() === 0 }} {{ v.list.length }} {{ v.u === undefined }}'
      )
      const token = tokenOf(await page(`<c:types lazy :v="{n: 1, d: new Date(0), list: [1, 2], u: undefined}" />`))
      expect((await serve(token)).result.html).toBe('number true 2 true')
    })

    it('renders lazy components inside a lazy component as placeholders', async () => {
      await app.write('view/components/outer.html', '<div><c:comments lazy :post-id="2" /></div>')
      const {result} = await serve(tokenOf(await page('<c:outer lazy />')))
      expect(result.html).toMatch(/^<div><odac-lazy data-odac-lazy="[^"]+"><\/odac-lazy><\/div>$/)
    })

    it('rejects requests without the X-Odac: lazy header', async () => {
      const token = tokenOf(await page('<c:comments lazy :post-id="1" />'))
      const {odac} = await serve(token, {header: 'ajaxload'})
      expect(odac.Request.abort).toHaveBeenCalledWith(400)
    })

    it.each([
      ['a missing token', () => undefined],
      ['a non-string token', () => ['a', 'b']],
      ['garbage', () => 'not-a-token'],
      ['a token with invalid characters', token => token + '!'],
      ['a changed token', token => token.slice(0, 20) + (token[20] === 'A' ? 'B' : 'A') + token.slice(21)],
      ['a truncated token', token => token.slice(0, -4)]
    ])('rejects %s with 400', async (label, change) => {
      const token = tokenOf(await page('<c:comments lazy :post-id="1" />'))
      const {odac, result} = await serve(change(token))
      expect(odac.Request.abort).toHaveBeenCalledWith(400)
      expect(result).toBeUndefined()
    })

    it('rejects an expired token', async () => {
      const token = tokenOf(await page('<c:comments lazy :post-id="1" />'))
      const now = Date.now()
      jest.spyOn(Date, 'now').mockReturnValue(now + Lazy.MAX_AGE + 1000)
      const {odac} = await serve(token)
      expect(odac.Request.abort).toHaveBeenCalledWith(400)
    })

    it('binds the token to the signed-in user who received the page', async () => {
      await app.write('view/content/user.html', '<c:comments lazy :post-id="1" />')
      const view = app.view()
      app.odac.Auth = {user: key => (key === 'id' ? 5 : undefined)}
      view.set({content: 'user'})
      await view.print()
      const token = tokenOf(app.odac.Request.end.mock.calls[0][0].output.content)

      expect((await serve(token, {user: null})).odac.Request.abort).toHaveBeenCalledWith(403)
      expect((await serve(token, {user: 6})).odac.Request.abort).toHaveBeenCalledWith(403)
      expect((await serve(token, {user: '5'})).result.html).toContain('Post 1')
    })

    it('lets anyone load a token issued to a guest (pages cached with Odac.cache())', async () => {
      const token = tokenOf(await page('<c:comments lazy :post-id="1" />'))
      expect((await serve(token, {user: 9})).result.html).toContain('Post 1')
    })

    it('renders in the language the page was served in', async () => {
      await app.write('view/content/lang.html', '<c:comments lazy :post-id="1" />')
      const view = app.view()
      app.odac.Lang.current = () => 'tr'
      view.set({content: 'lang'})
      await view.print()
      const token = tokenOf(app.odac.Request.end.mock.calls[0][0].output.content)
      expect((await serve(token)).odac.Lang.set).toHaveBeenCalledWith('tr')
    })

    it('answers 500 when the component throws', async () => {
      await app.write('view/components/boom.html', '<odac:props :x />\n{{ x.deep.deeper }}')
      const {odac, result} = await serve(tokenOf(await page('<c:boom lazy :x="{}" />')))
      expect(odac.Request.abort).toHaveBeenCalledWith(500)
      expect(result).toBeUndefined()
      expect(app.logged()).toContain('in line 2\n  of "./view/components/boom.html"\n  used in "/_odac/lazy (boom)"')
    })
  })

  describe('keys', () => {
    const keyFile = () => path.join(app.dir, 'storage', '.key')

    it('generates one key file shared by concurrent workers, readable by the owner only', async () => {
      const odac = {Config: {}}
      const tokens = await Promise.all(
        Array.from({length: 4}, async () => {
          Lazy.reset()
          return Lazy.seal(odac, {name: 'comments', attributes: [], user: null, lang: null})
        })
      )
      Lazy.reset()
      for (const token of tokens) expect(await Lazy.open(odac, token)).toEqual({name: 'comments', attributes: [], user: null, lang: null})
      expect(fsSync.readFileSync(keyFile(), 'utf8')).toMatch(/^[0-9a-f]{64}\n$/)
      expect(fsSync.statSync(keyFile()).mode & 0o777).toBe(0o600)
    })

    it('uses a configured encrypt.key instead of a generated one, the same on every server', async () => {
      const token = await Lazy.seal({Config: {encrypt: {key: 'server-secret'}}}, {name: 'a', attributes: [], user: null, lang: null})
      Lazy.reset()
      expect(await Lazy.open({Config: {encrypt: {key: 'server-secret'}}}, token)).not.toBeNull()
      expect(await Lazy.open({Config: {encrypt: {key: 'other-secret'}}}, token)).toBeNull()
      expect(fsSync.existsSync(keyFile())).toBe(false)
    })

    it('does not use the well-known default encrypt.key', async () => {
      const token = await Lazy.seal({Config: {encrypt: {key: 'odac'}}}, {name: 'a', attributes: [], user: null, lang: null})
      expect(fsSync.existsSync(keyFile())).toBe(true)
      expect(await Lazy.open({Config: {encrypt: {key: 'odac'}}}, token)).not.toBeNull()
    })

    it('refuses a corrupted key file instead of replacing it', async () => {
      await app.write('storage/.key', 'short')
      await expect(Lazy.seal({Config: {}}, {name: 'a', attributes: [], user: null, lang: null})).rejects.toThrow(
        'storage/.key does not hold a valid ODAC key'
      )
    })
  })
})
