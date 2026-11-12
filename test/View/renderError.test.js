const fs = require('fs').promises
const fsSync = require('fs')
const os = require('os')
const path = require('path')
const View = require('../../src/View')

// A view that throws must answer 500 (never a cacheable 200 with an empty region), run once,
// and be compiled to disk atomically. Part names from request headers are not trusted.
describe('View render errors and production paths', () => {
  let tmpDir, originalCwd, mockOdac, headers, errorSpy

  const makeView = (overrides = {}) => {
    headers = {}
    mockOdac = {
      Config: {debug: true, view: {earlyHints: {enabled: false}}},
      View: {},
      Request: {
        req: {url: '/test'},
        res: {finished: false},
        isAjaxLoad: false,
        page: 'test_page',
        header: jest.fn((key, value) => {
          if (value === null) delete headers[key]
          else headers[key] = value
        }),
        end: jest.fn(() => {
          mockOdac.Request.res.finished = true
        }),
        abort: jest.fn(async () => {
          mockOdac.Request.res.finished = true
        }),
        get: jest.fn(),
        hasEarlyHints: jest.fn().mockReturnValue(false),
        ...overrides
      },
      Lang: {get: jest.fn()}
    }
    return new View(mockOdac)
  }

  const writeView = async (rel, html) => {
    const file = path.join(tmpDir, rel)
    await fs.mkdir(path.dirname(file), {recursive: true})
    await fs.writeFile(file, html)
  }

  beforeEach(async () => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'odac-view-error-'))
    global.__dir = tmpDir
    originalCwd = process.cwd()
    process.chdir(tmpDir)
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await writeView('skeleton/main.html', '<html><body><main>{{ CONTENT }}</main></body></html>')
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete global.__dir
    delete global.Odac
    process.chdir(originalCwd)
    fsSync.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('answers 500 and drops proxy caching when a view throws', async () => {
    await writeView('view/content/boom.html', '<p>{!! missing.value !!}</p>')
    const view = makeView()
    headers['X-ODAC-Cache'] = 60
    view.skeleton('main').set({content: 'boom'})

    await view.print()

    expect(mockOdac.Request.abort).toHaveBeenCalledWith(500)
    expect(mockOdac.Request.end).not.toHaveBeenCalled()
    expect(headers['X-ODAC-Cache']).toBeUndefined()
    expect(headers['Cache-Control']).toContain('no-store')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('content/boom.html'))
  })

  it('prints the view a custom 500 handler configures', async () => {
    await writeView('view/content/boom.html', '<p>{!! missing.value !!}</p>')
    await writeView('view/content/error.html', '<p>Something went wrong</p>')
    const view = makeView({
      abort: jest.fn(async () => {
        view.set({content: 'error'})
      })
    })
    view.skeleton('main').set({content: 'boom'})

    await view.print()

    expect(mockOdac.Request.end).toHaveBeenCalledTimes(1)
    expect(mockOdac.Request.end.mock.calls[0][0]).toContain('Something went wrong')
  })

  it('ends with an empty body when the error page fails too', async () => {
    await writeView('view/content/boom.html', '<p>{!! missing.value !!}</p>')
    const view = makeView({abort: jest.fn(async () => {})})
    view.skeleton('main').set({content: 'boom'})

    await view.print()

    expect(mockOdac.Request.abort).toHaveBeenCalledTimes(1)
    expect(mockOdac.Request.end).toHaveBeenCalledWith('')
  })

  it('runs a failing cached view once in production', async () => {
    await writeView('view/content/counted.html', '<odac:js>global.__viewRuns = (global.__viewRuns || 0) + 1; missing.value</odac:js>')
    global.__viewRuns = 0
    let view = makeView()
    view.skeleton('main').set({content: 'counted'})
    await view.print()
    expect(global.__viewRuns).toBe(1)

    view = makeView()
    mockOdac.Config.debug = false
    view.skeleton('main').set({content: 'counted'})
    await view.print()

    expect(global.__viewRuns).toBe(2)
    expect(mockOdac.Request.abort).toHaveBeenCalledWith(500)
    delete global.__viewRuns
  })

  it('writes the compiled view under a temporary name and renames it into place', async () => {
    await writeView('view/content/ok.html', '<p>ok</p>')
    const rename = jest.spyOn(fsSync.promises, 'rename')
    const view = makeView()
    view.skeleton('main').set({content: 'ok'})

    await view.print()

    expect(rename).toHaveBeenCalledTimes(1)
    const [from, to] = rename.mock.calls[0]
    expect(from).toMatch(/\.tmp$/)
    expect(path.dirname(from)).toBe(path.dirname(to))
    expect(fsSync.readdirSync(path.dirname(to)).some(name => name.endsWith('.tmp'))).toBe(false)
    expect(mockOdac.Request.end.mock.calls[0][0]).toContain('<p>ok</p>')
  })

  it('checks a view file for existence once in production', async () => {
    await writeView('view/content/ok.html', '<p>ok</p>')
    const access = jest.spyOn(fsSync.promises, 'access')
    for (let i = 0; i < 2; i++) {
      const view = makeView()
      mockOdac.Config.debug = false
      view.skeleton('main').set({content: 'ok'})
      await view.print()
      expect(mockOdac.Request.end.mock.calls[0][0]).toContain('<p>ok</p>')
    }
    expect(access.mock.calls.filter(([file]) => String(file).endsWith('content/ok.html'))).toHaveLength(1)
  })

  it('ignores inherited names in X-Odac-Load', async () => {
    await writeView('view/content/ok.html', '<p>ok</p>')
    const view = makeView({isAjaxLoad: true, ajaxLoad: ['__proto__', 'constructor', 'content'], clientParts: Object.create(null)})
    view.skeleton('main').set({content: 'ok'})

    await view.print()

    const payload = mockOdac.Request.end.mock.calls[0][0]
    expect(Object.keys(payload.output)).toEqual(['content'])
    expect(payload.output.content).toBe('<p>ok</p>')
  })
})
