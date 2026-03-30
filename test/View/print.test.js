const fsPromises = require('fs').promises
const View = require('../../src/View')

describe('View.print()', () => {
  let view
  let mockOdac

  beforeEach(() => {
    global.__dir = require('path').resolve(__dirname, '../../')
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
  })

  it('should be a function', () => {
    expect(typeof view.print).toBe('function')
  })

  describe('AJAX Rendering Edge Cases', () => {
    it("should extract title from priority parts even if their view path hasn't changed (skipped)", async () => {
      const fs = require('fs')
      const path = require('path')

      const headDir = path.join(global.__dir, 'view/head/inc')
      const contentDir = path.join(global.__dir, 'view/content/pages')
      fs.mkdirSync(headDir, {recursive: true})
      fs.mkdirSync(contentDir, {recursive: true})

      fs.writeFileSync(path.join(headDir, 'head.html'), '<title>Dynamic Title</title>')
      fs.writeFileSync(path.join(contentDir, 'test.html'), '<h1>Test</h1>')

      mockOdac.Request.isAjaxLoad = true
      mockOdac.Request.ajaxLoad = ['head', 'content']
      mockOdac.Request.clientParts = {head: 'inc/head'}
      mockOdac.Request.page = 'test_page'

      view.set({head: 'inc/head', content: 'pages/test'})

      await view.print()

      expect(mockOdac.Request.end).toHaveBeenCalled()

      const payload = mockOdac.Request.end.mock.calls[0][0]
      console.log('PAYLOAD:', payload)
      expect(payload.output.head).toBeUndefined()
      expect(payload.title).toBe('Dynamic Title')
    })
  })
})
