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
})
