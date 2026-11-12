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
  it('declares UTF-8 for full HTML pages', async () => {
    const skeletonDir = path.join(global.__dir, 'skeleton')
    await fs.mkdir(skeletonDir, {recursive: true})
    await fs.writeFile(path.join(skeletonDir, 'main.html'), '<html><body>ş</body></html>')
    view.set({skeleton: 'main'})
    await view.print()
    expect(mockOdac.Request.header).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8')
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
})
