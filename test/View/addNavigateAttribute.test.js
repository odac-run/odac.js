const fs = require('fs').promises
const path = require('path')
const View = require('../../src/View')

describe('View.#addNavigateAttribute()', () => {
  let view
  let mockOdac

  beforeEach(() => {
    global.__dir = path.resolve(__dirname, '../../')
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

  it('should not wrap placeholder in display:contents if it is the first child of an element', async () => {
    const skeletonDir = path.join(global.__dir, 'skeleton')
    const contentDir = path.join(global.__dir, 'view/content/pages')
    await fs.mkdir(skeletonDir, {recursive: true})
    await fs.mkdir(contentDir, {recursive: true})

    await fs.writeFile(path.join(skeletonDir, 'main.html'), '<main id="app-main">\n  {{ CONTENT }}\n</main>')
    await fs.writeFile(path.join(contentDir, 'test.html'), '<h1>Content</h1>')

    view.skeleton('main').set({content: 'pages/test'})

    await view.print()

    expect(mockOdac.Request.end).toHaveBeenCalled()
    const outputHtml = mockOdac.Request.end.mock.calls[0][0]

    expect(outputHtml).toContain('<main id="app-main" data-odac-navigate="content">')
    expect(outputHtml).toContain('<h1>Content</h1>')
    expect(outputHtml).not.toContain('<div style="display:contents"')
  })
})
