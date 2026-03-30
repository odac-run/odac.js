const fs = require('fs')
const fsPromises = fs.promises
const path = require('path')
const View = require('../../src/View')

const FIXTURE_DIR = path.resolve(__dirname, '_fixtures_get')

describe('View odac tags (var, get, translate) raw attribute', () => {
  let originalDir
  let originalCwd

  beforeAll(async () => {
    await fsPromises.mkdir(path.join(FIXTURE_DIR, 'skeleton'), {recursive: true})
    await fsPromises.mkdir(path.join(FIXTURE_DIR, 'view', 'content'), {recursive: true})
  })

  afterAll(async () => {
    await fsPromises.rm(FIXTURE_DIR, {recursive: true, force: true})
  })

  beforeEach(() => {
    originalDir = global.__dir
    originalCwd = process.cwd()
    global.__dir = FIXTURE_DIR
    process.chdir(FIXTURE_DIR)

    if (global.Odac?.View?.cache) {
      global.Odac.View.cache = {}
    }
    if (global.Odac?.View?.skeletons) {
      global.Odac.View.skeletons = {}
    }

    for (const key of Object.keys(require.cache)) {
      if (key.includes('.cache')) {
        delete require.cache[key]
      }
    }
  })

  afterEach(() => {
    global.__dir = originalDir
    process.chdir(originalCwd)
  })

  let testCounter = 0

  async function renderTemplate(templateContent, getValues = {}) {
    const uniqueId = `test_get_${++testCounter}`
    const viewFile = path.join(FIXTURE_DIR, 'view', 'content', `${uniqueId}.html`)
    await fsPromises.writeFile(viewFile, templateContent, 'utf8')

    const skeletonFile = path.join(FIXTURE_DIR, 'skeleton', 'main.html')
    await fsPromises.writeFile(skeletonFile, '{{ CONTENT }}', 'utf8')

    let capturedOutput = ''
    const mockOdac = {
      Config: {debug: true},
      Var: value => {
        const str = value === null || value === undefined ? '' : String(value)
        return {
          html: () => str.replace(/[&<>"']/g, m => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[m])
        }
      },
      Request: {
        get: key => getValues[key] || '',
        req: {url: '/test'},
        res: {finished: false, headersSent: false},
        isAjaxLoad: false,
        ajaxLoad: [],
        variables: {},
        sharedData: {},
        page: '',
        header: () => {},
        end: output => {
          capturedOutput = output
        },
        hasEarlyHints: () => false,
        setEarlyHints: () => {}
      },
      Lang: {
        get: (...args) => args[0]
      },
      View: {}
    }

    const view = new View(mockOdac)
    view.skeleton('main')
    view.set('content', uniqueId)
    await view.print()

    return capturedOutput
  }

  it('should escape <odac get> by default', async () => {
    const result = await renderTemplate('<odac get="html" />', {html: '<b>bold</b>'})
    expect(result).toContain('&lt;b&gt;bold&lt;/b&gt;')
    expect(result).not.toContain('<b>')
  })

  it('should not escape <odac get> when raw attribute is present (self-closing)', async () => {
    const result = await renderTemplate('<odac get="html" raw />', {html: '<b>bold</b>'})
    expect(result).toContain('<b>bold</b>')
  })

  it('should not escape <odac get> when raw attribute is present (block-level)', async () => {
    const result = await renderTemplate('<odac get="html" raw></odac>', {html: '<b>bold</b>'})
    expect(result).toContain('<b>bold</b>')
  })

  it('should handle missing parameters gracefully with raw', async () => {
    const result = await renderTemplate('<odac get="missing" raw />', {})
    expect(result).toContain('data-odac-navigate="content"')
    expect(result).toContain('id="odac-data"')
  })

  it('should not escape <odac translate> when raw attribute is present', async () => {
    const result = await renderTemplate('<odac translate raw><b>bold</b></odac>')
    expect(result).toContain('<b>bold</b>')
    expect(result).not.toContain('&lt;b&gt;')
  })

  it('should escape <odac var> by default', async () => {
    const result = await renderTemplate('<script:odac>var htmlVar = "<em>test</em>";</script:odac><odac var="htmlVar" />')
    expect(result).toContain('&lt;em&gt;test&lt;/em&gt;')
  })

  it('should not escape <odac var> when raw attribute is present', async () => {
    const result = await renderTemplate('<script:odac>var htmlVar = "<em>test</em>";</script:odac><odac var="htmlVar" raw />')
    expect(result).toContain('<em>test</em>')
  })
})
