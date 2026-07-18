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

  it('renders a literal backtick without breaking the template literal', async () => {
    const output = await renderContent('backtick', '<code>const x = `hello`</code>')
    expect(output).toContain('`hello`')
  })

  it('renders a literal ${ sequence verbatim (no interpolation)', async () => {
    const output = await renderContent('dollar', '<p>Price: ${amount}</p>')
    expect(output).toContain('${amount}')
  })
})
