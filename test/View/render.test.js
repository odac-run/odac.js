const fs = require('fs').promises
const fsSync = require('fs')
const os = require('os')
const path = require('path')
const View = require('../../src/View')

// #render is private; it is exercised through print()'s AJAX path, which returns
// the rendered part HTML in the payload. See IMPROVEMENT-PLAN 1.6: a literal
// backtick (or ${) in a .html view broke the generated template literal and the
// view rendered empty / threw "Invalid or unexpected token".
describe('View.#render()', () => {
  let view
  let mockOdac
  let tmpDir
  let originalCwd

  beforeEach(() => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'odac-view-render-'))
    global.__dir = tmpDir
    originalCwd = process.cwd()
    process.chdir(tmpDir)
    mockOdac = {
      Config: {view: {earlyHints: {enabled: false}}},
      View: {},
      Request: {
        req: {url: '/test'},
        res: {finished: false},
        isAjaxLoad: true,
        ajaxLoad: ['content'],
        clientParts: {},
        page: 'test_page',
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
    // The compiled-view cache lives on global.Odac keyed by view path; reset it
    // so a cache entry from one test (whose tmp dir is deleted below) is not
    // reused by the next.
    delete global.Odac
    process.chdir(originalCwd)
    fsSync.rmSync(tmpDir, {recursive: true, force: true})
  })

  // Each call uses a distinct view path so the md5-keyed compiled cache never
  // collides between tests.
  async function renderContent(name, html) {
    const contentDir = path.join(global.__dir, 'view/content/pages')
    await fs.mkdir(contentDir, {recursive: true})
    await fs.writeFile(path.join(contentDir, `${name}.html`), html)
    view.set({content: `pages/${name}`})
    await view.print()
    const payload = mockOdac.Request.end.mock.calls[0][0]
    return payload.output.content
  }

  describe('loop source validation', () => {
    let errorSpy

    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    })

    it.each(['for', 'list'])('renders <odac:%s in="..."> without a missing-argument error', async tag => {
      const html = `<odac:js>const items = ['a', 'b'];</odac:js><odac:${tag} in="items" value="item">[{!! item !!}]</odac:${tag}>`
      const output = await renderContent(`${tag}_in`, html)
      expect(output).toContain('[a][b]')
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('renders <odac:for in="a.b"> with a dotted path and key without a missing-argument error', async () => {
      const html = `<odac:js>const post = {tags: ['x']};</odac:js><odac:for in="post.tags" key="i" value="tag">{!! i !!}={!! tag !!}</odac:for>`
      const output = await renderContent('for_in_path', html)
      expect(output).toContain('0=x')
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('renders <odac:for var="..."> without a missing-argument error', async () => {
      const html = `<odac:js>const items = ['a'];</odac:js><odac:for var="items" value="item">[{!! item !!}]</odac:for>`
      const output = await renderContent('for_var', html)
      expect(output).toContain('[a]')
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('does not corrupt an in expression that contains the literal "$in"', async () => {
      const html = `<odac:js>const $index = ['a'];</odac:js><odac:for in="$index" value="item">[{!! item !!}]</odac:for>`
      const output = await renderContent('for_in_dollar', html)
      expect(output).toContain('[a]')
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('still reports a loop with no source at all', async () => {
      await renderContent('for_no_source', '<odac:for value="item">x</odac:for>')
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"var", "get" or "in" is required'))
    })
  })

  it('renders a literal backtick without breaking the template literal', async () => {
    const output = await renderContent('backtick', '<code>const x = `hello`</code>')
    expect(output).toContain('`hello`')
  })

  it('renders a literal ${ sequence verbatim (no interpolation)', async () => {
    const output = await renderContent('dollar', '<p>Price: ${amount}</p>')
    expect(output).toContain('${amount}')
  })

  // The HTML escaping pass doubles backslashes so raw markup is safe inside the
  // generated backtick string. <odac:js> bodies are emitted as JS, not as string
  // content, so they must be lifted out before that pass runs: otherwise
  // /^\/assets\// compiled to /^\\/assets\\// and threw "Invalid regular
  // expression flags".
  it('keeps backslash escapes inside an <odac:js> regex intact', async () => {
    const output = await renderContent(
      'js-regex',
      "<odac:js>const re = /^\\/assets\\//; html += re.test('/assets/app.css') ? 'MATCH' : 'MISS';</odac:js>"
    )
    expect(output).toBe('MATCH')
  })

  it('keeps backticks and ${} interpolation inside an <odac:js> body intact', async () => {
    const output = await renderContent('js-template', '<odac:js>const n = 2; html += `n=${n}`;</odac:js>')
    expect(output).toBe('n=2')
  })

  it('keeps backslash escapes inside a <script:odac> regex intact', async () => {
    const output = await renderContent(
      'script-regex',
      "<script:odac>const re = /^\\/assets\\//; html += re.test('/assets/app.css') ? 'MATCH' : 'MISS';</script:odac>"
    )
    expect(output).toBe('MATCH')
  })
})
