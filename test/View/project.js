const fs = require('fs').promises
const fsSync = require('fs')
const os = require('os')
const path = require('path')
const View = require('../../src/View')

// A throwaway project directory with view files, and a View that renders one content part
// through the AJAX path so the test reads the part's HTML directly.
function project() {
  const state = {dir: null, cwd: null, odac: null, errors: null}

  const escapeHtml = value =>
    String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char])

  state.setup = () => {
    state.dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'odac-component-'))
    state.cwd = process.cwd()
    global.__dir = state.dir
    process.chdir(state.dir)
    state.errors = jest.spyOn(console, 'error').mockImplementation(() => {})
  }

  state.teardown = () => {
    jest.restoreAllMocks()
    delete global.__dir
    delete global.Odac
    process.chdir(state.cwd)
    fsSync.rmSync(state.dir, {recursive: true, force: true})
  }

  state.write = async (rel, html) => {
    const file = path.join(state.dir, rel)
    await fs.mkdir(path.dirname(file), {recursive: true})
    await fs.writeFile(file, html)
  }

  state.view = ({variables = {}, debug = true, ajax = true} = {}) => {
    const stored = {}
    for (const key of Object.keys(variables)) stored[key] = {value: variables[key], ajax: false}
    state.odac = {
      Config: {debug, view: {earlyHints: {enabled: false}}},
      View: {},
      Var: value => ({html: () => escapeHtml(value)}),
      Request: {
        req: {url: '/test'},
        res: {finished: false},
        isAjaxLoad: ajax,
        ajaxLoad: ['content'],
        clientParts: {},
        page: 'test_page',
        variables: stored,
        sharedData: {},
        header: jest.fn(),
        end: jest.fn(() => {
          state.odac.Request.res.finished = true
        }),
        abort: jest.fn(async () => {
          state.odac.Request.res.finished = true
        }),
        get: key => stored[key]?.value,
        hasEarlyHints: jest.fn().mockReturnValue(false)
      },
      Lang: {get: (...args) => args[0], getx: key => key}
    }
    return new View(state.odac)
  }

  // Renders `view/content/<name>.html`; undefined when the render failed (answered 500).
  state.render = async (name, options) => {
    const view = state.view(options)
    view.set({content: name})
    await view.print()
    return state.odac.Request.end.mock.calls[0]?.[0]?.output?.content
  }

  // Renders `view/content/<name>.html` as a full page in `skeleton/main.html`; the HTML sent.
  state.renderPage = async (name, options = {}) => {
    const view = state.view({...options, ajax: false})
    view.skeleton('main').set({content: name})
    await view.print()
    return state.odac.Request.end.mock.calls[0]?.[0]
  }

  // The AJAX navigation payload for `view/content/<name>.html`.
  state.renderAjax = async (name, options) => {
    const view = state.view(options)
    view.set({content: name})
    await view.print()
    return state.odac.Request.end.mock.calls[0]?.[0]
  }

  // The logged error lines, joined for matching.
  state.logged = () => state.errors.mock.calls.map(call => call.join(' ')).join('\n')

  return state
}

module.exports = {project}
