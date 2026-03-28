const fs = require('fs')
const fsPromises = fs.promises
const path = require('path')
const View = require('../../src/View')

const FIXTURE_DIR = path.resolve(__dirname, '_fixtures')

/**
 * Integration tests for the #parseOdacTag private method.
 * Since #parseOdacTag is private, we test it indirectly through the
 * full render pipeline by creating temporary .html view files,
 * invoking View.print(), and asserting the rendered output.
 */
describe('View.#parseOdacTag()', () => {
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

    // Clear require cache for compiled templates
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

  /**
   * Writes a view file, triggers render via print(), and captures output.
   * Uses a unique filename per call to avoid cache collisions between tests.
   * Returns the rendered HTML string.
   */
  async function renderTemplate(templateContent) {
    const uniqueId = `test_${++testCounter}`
    const viewFile = path.join(FIXTURE_DIR, 'view', 'content', `${uniqueId}.html`)
    await fsPromises.writeFile(viewFile, templateContent, 'utf8')

    const skeletonFile = path.join(FIXTURE_DIR, 'skeleton', 'main.html')
    await fsPromises.writeFile(skeletonFile, '{{ CONTENT }}', 'utf8')

    let capturedOutput = ''
    const errors = []
    const originalError = console.error
    console.error = (...args) => errors.push(args.join(' '))

    const mockOdac = {
      Config: {debug: true},
      Var: value => {
        const str = value === null || value === undefined ? '' : String(value)
        return {
          html: () => str.replace(/[&<>"']/g, m => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[m])
        }
      },
      Request: {
        req: {url: '/test'},
        res: {finished: false, headersSent: false},
        isAjaxLoad: false,
        ajaxLoad: [],
        variables: {},
        sharedData: {},
        page: '',
        get: () => '',
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

    try {
      const view = new View(mockOdac)
      view.skeleton('main')
      view.set('content', uniqueId)
      await view.print()
    } finally {
      console.error = originalError
    }

    if (errors.length > 0) {
      throw new Error(`Template render error: ${errors.join('\n')}`)
    }

    return capturedOutput
  }

  describe('single quote escaping in <odac> tags', () => {
    it('should render a single quote inside <odac> without syntax error', async () => {
      const result = await renderTemplate("<odac>'</odac>")
      // Single quotes are HTML-escaped by Odac.Var().html()
      expect(result).toContain('&#39;')
    })

    it('should render text with embedded single quotes', async () => {
      const result = await renderTemplate("<odac>it's working</odac>")
      expect(result).toContain('it&#39;s working')
    })

    it('should render multiple single quotes', async () => {
      const result = await renderTemplate("<odac>it's a developer's life</odac>")
      expect(result).toContain('it&#39;s a developer&#39;s life')
    })

    it('should render escaped apostrophe in translation tags', async () => {
      const result = await renderTemplate("<odac t>it's translated</odac>")
      expect(result).toContain('it&#39;s translated')
    })
  })

  describe('basic <odac> tag rendering', () => {
    it('should render plain text inside <odac> tags', async () => {
      const result = await renderTemplate('<odac>hello world</odac>')
      expect(result).toContain('hello world')
    })

    it('should strip backend comments (multi-line)', async () => {
      const result = await renderTemplate('visible<!--odac hidden odac-->visible2')
      expect(result).toContain('visible')
      expect(result).toContain('visible2')
      expect(result).not.toContain('hidden')
    })

    it('should strip backend comments (single-line)', async () => {
      const result = await renderTemplate('visible<!--odac hidden -->visible2')
      expect(result).toContain('visible')
      expect(result).toContain('visible2')
      expect(result).not.toContain('hidden')
    })

    it('should handle empty <odac> tags gracefully', async () => {
      const result = await renderTemplate('<odac></odac>')
      expect(typeof result).toBe('string')
    })
  })

  describe('special characters in <odac> tags', () => {
    it('should handle double quotes inside <odac> tags', async () => {
      const result = await renderTemplate('<odac>say "hello"</odac>')
      expect(result).toContain('say')
    })

    it('should handle angle brackets in text (HTML entities)', async () => {
      const result = await renderTemplate('<odac>&lt;div&gt;</odac>')
      // Already-escaped entities get double-escaped by Odac.Var().html()
      expect(result).toContain('&amp;lt;div&amp;gt;')
    })
  })
})
