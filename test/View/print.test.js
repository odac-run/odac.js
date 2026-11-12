const fs = require('fs').promises
const fsSync = require('fs')
const os = require('os')
const path = require('path')
const View = require('../../src/View')

describe('View.print()', () => {
  let view
  let mockOdac
  let tmpDir
  let originalCwd

  beforeEach(() => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'odac-view-print-'))
    global.__dir = tmpDir
    originalCwd = process.cwd()
    process.chdir(tmpDir)
    mockOdac = {
      Config: {view: {earlyHints: {enabled: false}}},
      View: {},
      Request: {
        req: {url: '/test'},
        res: {finished: false},
        isAjaxLoad: false,
        header: jest.fn(),
        end: jest.fn(),
        get: jest.fn(),
        hasEarlyHints: jest.fn().mockReturnValue(false)
      },
      Lang: {get: jest.fn()}
    }
    view = new View(mockOdac)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete global.__dir
    process.chdir(originalCwd)
    fsSync.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('should be a function', () => {
    expect(typeof view.print).toBe('function')
  })

  describe('AJAX Rendering Edge Cases', () => {
    it("should extract title from priority parts even if their view path hasn't changed", async () => {
      const headDir = path.join(global.__dir, 'view/head/inc')
      const contentDir = path.join(global.__dir, 'view/content/pages')
      await fs.mkdir(headDir, {recursive: true})
      await fs.mkdir(contentDir, {recursive: true})

      await fs.writeFile(path.join(headDir, 'head.html'), '<title>Dynamic Title</title>')
      await fs.writeFile(path.join(contentDir, 'test.html'), '<h1>Test</h1>')

      mockOdac.Request.isAjaxLoad = true
      mockOdac.Request.ajaxLoad = ['head', 'content']
      mockOdac.Request.clientParts = {head: 'inc/head'}
      mockOdac.Request.page = 'test_page'

      view.set({head: 'inc/head', content: 'pages/test'})

      await view.print()

      expect(mockOdac.Request.end).toHaveBeenCalled()

      const payload = mockOdac.Request.end.mock.calls[0][0]
      expect(payload.output.head).toBeUndefined()
      expect(payload.title).toBe('Dynamic Title')
    })
  })
  describe('browser translations', () => {
    const payload = {lang: 'tr', v: 'abc123', t: {Hello: 'Merhaba </script><script>alert(1)</script>'}}

    // Compiled views are cached by path for the process; every render gets its own.
    let seq = 0
    const renderAjax = async header => {
      const name = `ajaxlang${++seq}`
      await fs.mkdir(path.join(global.__dir, 'view/content'), {recursive: true})
      await fs.writeFile(path.join(global.__dir, `view/content/${name}.html`), '<p>x</p>')
      mockOdac.Lang.client = jest.fn(async () => payload)
      mockOdac.Request.isAjaxLoad = true
      mockOdac.Request.ajaxLoad = ['content']
      mockOdac.Request.header = jest.fn(name => (name === 'X-Odac-Lang' ? header : undefined))
      view.set({content: name})
      await view.print()
      return mockOdac.Request.end.mock.calls[0][0]
    }

    it('embeds them in the page so they cannot break out of the script element', async () => {
      await fs.mkdir(path.join(global.__dir, 'skeleton'), {recursive: true})
      await fs.writeFile(path.join(global.__dir, 'skeleton', 'langpage.html'), '<html><body></body></html>')
      mockOdac.Lang.client = jest.fn(async () => payload)
      view.set({skeleton: 'langpage'})
      await view.print()
      const html = mockOdac.Request.end.mock.calls[0][0]
      const match = html.match(/<script type="application\/json" id="odac-lang">([^<]*)<\/script><\/body>/)
      expect(match).not.toBeNull()
      expect(JSON.parse(match[1])).toEqual(payload)
      expect(html.match(/<\/script>/g)).toHaveLength(2)
    })

    it('omits them when the frontend uses no translations, and survives a failing lookup', async () => {
      await fs.mkdir(path.join(global.__dir, 'skeleton'), {recursive: true})
      await fs.writeFile(path.join(global.__dir, 'skeleton', 'nolang.html'), '<html><body></body></html>')
      mockOdac.Lang.client = jest.fn(async () => {
        throw new Error('boom')
      })
      view.set({skeleton: 'nolang'})
      await view.print()
      const html = mockOdac.Request.end.mock.calls[0][0]
      expect(html).toContain('id="odac-data"')
      expect(html).not.toContain('odac-lang')
    })

    const held = async header => {
      mockOdac.Request.end.mockClear()
      view = new View(mockOdac)
      return (await renderAjax(header)).lang
    }

    it('sends them on navigation only when the browser holds other ones', async () => {
      expect(await held('tr:abc123')).toBeUndefined()
      expect(await held('en:abc123')).toEqual(payload)
    })

    it('sends them again after a language file changed their content', async () => {
      expect(await held('tr:old')).toEqual(payload)
    })

    it('sends them to a browser that reports only the language (an older odac.js)', async () => {
      expect(await held('tr')).toEqual(payload)
    })
  })

  it('declares UTF-8 for full HTML pages', async () => {
    const skeletonDir = path.join(global.__dir, 'skeleton')
    await fs.mkdir(skeletonDir, {recursive: true})
    await fs.writeFile(path.join(skeletonDir, 'main.html'), '<html><body>ş</body></html>')
    view.set({skeleton: 'main'})
    await view.print()
    expect(mockOdac.Request.header).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8')
  })

  describe('skeleton placeholders', () => {
    // Skeletons and compiled views are cached by path in production mode; unique names per
    // test keep one test's files from being served to the next.
    let seq = 0
    const renderPage = async (skeleton, parts) => {
      const name = `placeholder${++seq}`
      mockOdac.Var = (...args) => new (require('../../src/Var'))(...args)
      await fs.mkdir(path.join(global.__dir, 'skeleton'), {recursive: true})
      await fs.writeFile(path.join(global.__dir, 'skeleton', `${name}.html`), skeleton)
      const set = {skeleton: name}
      for (const [part, html] of Object.entries(parts)) {
        const dir = path.join(global.__dir, 'view', part)
        await fs.mkdir(dir, {recursive: true})
        await fs.writeFile(path.join(dir, `${name}.html`), html)
        set[part] = name
      }
      view.set(set)
      await view.print()
      return mockOdac.Request.end.mock.calls[0][0]
    }

    it('inserts rendered HTML containing $ replacement patterns verbatim', async () => {
      const html = await renderPage('<!DOCTYPE html><html><body><main>{{ CONTENT }}</main></body></html>', {
        content: "<p>$` $& $$ $' $1</p>"
      })
      expect(html).toContain("<p>$` $& $$ $' $1</p>")
      expect(html.match(/<!DOCTYPE html>/g)).toHaveLength(1)
    })

    it('keeps an escaped quote after a dollar sign intact', async () => {
      const html = await renderPage('<main>{{ CONTENT }}</main>', {
        content: `<odac:js>const price = "A$'B";</odac:js><p>{{ price }}</p>`
      })
      expect(html).toContain('<p>A$&#39;B</p>')
    })

    it('does not fill or erase placeholder-like text inside rendered parts', async () => {
      const html = await renderPage('<main>{{ CONTENT }}</main><footer>{{ FOOTER }}</footer>', {
        // User data that happens to look like a placeholder, printed through an escaped tag.
        content: `<odac:js>const note = '{{ FOOTER }} and {{ NAME }}';</odac:js><code>{{ note }}</code>`,
        footer: '<p>real footer</p>'
      })
      expect(html).toContain('<code>{{ FOOTER }} and {{ NAME }}</code>')
      expect(html).toMatch(/<footer[^>]*><p>real footer<\/p><\/footer>/)
    })

    it('renders unresolved skeleton placeholders empty', async () => {
      const html = await renderPage('<main>{{ CONTENT }}</main><aside>{{ SIDEBAR }}</aside>', {content: 'c'})
      expect(html).not.toContain('SIDEBAR }}')
      expect(html).toMatch(/<aside[^>]*><\/aside>/)
    })

    it('fills remaining placeholders from the all pattern after explicit parts', async () => {
      await fs.mkdir(path.join(global.__dir, 'view', 'pages', 'header'), {recursive: true})
      await fs.writeFile(path.join(global.__dir, 'view', 'pages', 'header', 'home.html'), 'H')
      await fs.mkdir(path.join(global.__dir, 'view', 'pages', 'content'), {recursive: true})
      await fs.writeFile(path.join(global.__dir, 'view', 'pages', 'content', 'home.html'), 'from all')
      await fs.mkdir(path.join(global.__dir, 'skeleton'), {recursive: true})
      await fs.writeFile(
        path.join(global.__dir, 'skeleton', 'placeholderAll.html'),
        '<header>{{ HEADER }}</header><main>{{ CONTENT }}</main>'
      )
      await fs.mkdir(path.join(global.__dir, 'view', 'content'), {recursive: true})
      await fs.writeFile(path.join(global.__dir, 'view', 'content', 'own.html'), 'explicit')
      view.set({skeleton: 'placeholderAll', all: 'pages.home', content: 'own'})
      await view.print()
      const html = mockOdac.Request.end.mock.calls[0][0]
      expect(html).toMatch(/<header[^>]*>H<\/header>/)
      expect(html).toMatch(/<main[^>]*>explicit<\/main>/)
    })
  })

  describe('Shared data injection', () => {
    const renderWithSharedData = async sharedData => {
      const skeletonDir = path.join(global.__dir, 'skeleton')
      await fs.mkdir(skeletonDir, {recursive: true})
      await fs.writeFile(path.join(skeletonDir, 'main.html'), '<html><body><main></main></body></html>')
      mockOdac.Request.sharedData = sharedData
      view.set({skeleton: 'main'})
      await view.print()
      return mockOdac.Request.end.mock.calls[0][0]
    }

    const extractPayload = html => html.match(/<script type="application\/json" id="odac-data">([\s\S]*?)<\/script>/)[1]

    it('should not let shared strings close the data script element', async () => {
      const html = await renderWithSharedData({name: '</script><script>alert(1)</script><!--'})

      expect(html).not.toContain('<script>alert(1)')
      expect(html.match(/<\/script>/g)).toHaveLength(1)
      expect(JSON.parse(extractPayload(html))).toEqual({name: '</script><script>alert(1)</script><!--'})
    })

    it('should escape ampersands and JavaScript line terminators while preserving the value', async () => {
      const value = {text: 'a & b \u2028 c \u2029 d > e'}
      const html = await renderWithSharedData(value)
      const payload = extractPayload(html)

      expect(payload).not.toMatch(/[<>&\u2028\u2029]/)
      expect(JSON.parse(payload)).toEqual(value)
    })

    it('should not expand replacement patterns contained in shared data', async () => {
      const value = {price: "$& $' $` $$"}
      const html = await renderWithSharedData(value)

      expect(JSON.parse(extractPayload(html))).toEqual(value)
      expect(html.endsWith('</body></html>')).toBe(true)
    })
  })
  describe('Early hints learning', () => {
    const renderAt = async (View, earlyHints, url) => {
      mockOdac.Request.req.url = url
      mockOdac.Request.end = jest.fn()
      global.Odac = {View: {EarlyHints: earlyHints}}
      const instance = new View(mockOdac)
      instance.set({skeleton: 'main', content: 'user.profile'})
      await instance.print()
    }

    beforeEach(async () => {
      await fs.mkdir(path.join(global.__dir, 'skeleton'), {recursive: true})
      await fs.mkdir(path.join(global.__dir, 'view/content/user'), {recursive: true})
      await fs.writeFile(
        path.join(global.__dir, 'skeleton/main.html'),
        '<html><head><link rel="stylesheet" href="/app.css"></head><body>{{ CONTENT }}</body></html>'
      )
      await fs.writeFile(path.join(global.__dir, 'view/content/user/profile.html'), '<h1>Profile</h1>')
    })

    it('keys learned hints by the views of the page, not by its URL', async () => {
      const EarlyHints = require('../../src/View/EarlyHints')
      const earlyHints = new EarlyHints({enabled: true, auto: true, maxResources: 5})
      const cacheHints = jest.spyOn(earlyHints, 'cacheHints')
      mockOdac.Request.setEarlyHints = jest.fn()

      for (let id = 1; id <= 3; id++) await renderAt(View, earlyHints, `/user/${id}?tab=info`)

      const keys = new Set(cacheHints.mock.calls.map(([key]) => key))
      expect(keys.size).toBe(1)
      expect([...keys][0]).not.toContain('/user/')
      expect(mockOdac.Request.setEarlyHints).toHaveBeenLastCalledWith([{href: '/app.css', as: 'style'}])
      delete global.Odac
    })
  })

  describe('document language', () => {
    const headers = () => Object.fromEntries(mockOdac.Request.header.mock.calls.filter(call => call.length === 2))
    // Skeletons and compiled views are cached by path for the process; every test gets its own.
    let seq = 0
    const writeSkeleton = async html => {
      const name = `doclang${++seq}`
      await fs.mkdir(path.join(global.__dir, 'skeleton'), {recursive: true})
      await fs.writeFile(path.join(global.__dir, 'skeleton', `${name}.html`), html)
      return name
    }

    const renderPage = async (skeleton, served) => {
      const name = await writeSkeleton(skeleton)
      mockOdac.Lang.served = jest.fn(async () => served)
      view.set({skeleton: name})
      await view.print()
      return mockOdac.Request.end.mock.calls[0][0]
    }

    const renderAjax = async served => {
      await fs.mkdir(path.join(global.__dir, 'view/content'), {recursive: true})
      const name = `doclang${++seq}`
      await fs.writeFile(path.join(global.__dir, `view/content/${name}.html`), '<p>x</p>')
      mockOdac.Lang.served = jest.fn(async () => served)
      mockOdac.Request.isAjaxLoad = true
      mockOdac.Request.ajaxLoad = ['content']
      view.set({content: name})
      await view.print()
      return mockOdac.Request.end.mock.calls[0][0]
    }

    it('replaces the skeleton lang and dir with the served language', async () => {
      const html = await renderPage('<html lang="en" dir=ltr class="x"><body></body></html>', {lang: 'ar', dir: 'rtl', varies: true})
      expect(html).toMatch(/^<html class="x" lang="ar" dir="rtl" data-odac-skeleton="doclang\d+"/)
      expect(html.match(/\slang=/g)).toHaveLength(1)
      expect(headers()['Content-Language']).toBe('ar')
      expect(headers().Vary).toBe('Accept-Language')
    })

    it('keeps attributes that only look like lang', async () => {
      const html = await renderPage('<html xml:lang="en" data-lang="q" data-x="a lang=b"><body></body></html>', {
        lang: 'tr',
        dir: 'ltr',
        varies: false
      })
      expect(html).toContain('<html xml:lang="en" data-lang="q" data-x="a lang=b" lang="tr" dir="ltr"')
    })

    it('does not vary with Accept-Language for a language chosen by the application', async () => {
      await renderPage('<html><body></body></html>', {lang: 'tr', dir: 'ltr', varies: false})
      expect(headers()['Content-Language']).toBe('tr')
      expect(headers().Vary).toBeUndefined()
    })

    it('leaves the skeleton and headers alone when no language is declared', async () => {
      const html = await renderPage('<html lang="tr"><body></body></html>', null)
      expect(html).toMatch(/^<html lang="tr" data-odac-skeleton/)
      expect(headers()['Content-Language']).toBeUndefined()
      expect(headers().Vary).toBeUndefined()
    })

    it('renders the page when the language lookup fails', async () => {
      const name = await writeSkeleton('<html lang="tr"><body></body></html>')
      mockOdac.Lang.served = jest.fn(async () => {
        throw new Error('boom')
      })
      view.set({skeleton: name})
      await view.print()
      expect(mockOdac.Request.end.mock.calls[0][0]).toMatch(/^<html lang="tr" data-odac-skeleton/)
    })

    it('sends the language to a navigation and varies the response with it', async () => {
      const payload = await renderAjax({lang: 'ar', dir: 'rtl', varies: true})
      expect(payload.document).toEqual({lang: 'ar', dir: 'rtl'})
      expect(headers()['Content-Language']).toBe('ar')
      expect(headers().Vary).toBe('X-Odac, X-Odac-Lang, Accept-Language')
    })

    it('omits the language from a navigation when none is declared', async () => {
      const payload = await renderAjax(null)
      expect(payload.document).toBeUndefined()
      expect(headers().Vary).toBe('X-Odac, X-Odac-Lang')
    })
  })
})
