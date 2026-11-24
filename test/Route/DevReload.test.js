const fs = require('fs')
const os = require('os')
const path = require('path')
const {EventEmitter} = require('events')
const DevReload = require('../../src/Route/DevReload.js')

describe('DevReload.classify()', () => {
  it.each([
    ['skeleton', 'main.html', {type: 'reload'}],
    ['skeleton', null, {type: 'reload'}],
    ['view', 'content/home.html', {type: 'part', name: 'content'}],
    ['view', 'header/nav/main.html', {type: 'part', name: 'header'}],
    ['view', 'components/card.html', {type: 'parts'}],
    ['view', 'stray.html', {type: 'parts'}],
    ['view', null, {type: 'parts'}],
    ['view', 'css/app.css', null],
    ['view', 'js/app.js', null],
    ['view', 'mail/welcome.html', null],
    ['public', 'assets/css/app.css', {type: 'css', url: '/assets/css/app.css'}],
    ['public', 'assets/js/app.js', {type: 'reload'}],
    ['public', 'assets/js/app.js.map', null],
    ['public', 'img/logo.png', {type: 'reload'}],
    ['route', 'www.js', {type: 'server'}],
    ['controller', 'page/index.js', {type: 'server'}],
    ['class', 'Shop.js', {type: 'server'}],
    ['middleware', 'auth.js', {type: 'server'}],
    ['hook', 'auth.js', {type: 'server'}],
    ['storage', 'sessions.mdb', null]
  ])('%s/%s → %j', (dir, file, expected) => {
    expect(DevReload.classify(dir, file)).toEqual(expected)
  })

  it.each(['content/.home.html.swp', 'content/home.html~', 'content/home.html.swp', 'content/4913', '.DS_Store', 'header/.git/x'])(
    'ignores editor leftover %s',
    file => {
      expect(DevReload.classify('view', file)).toBeNull()
    }
  )

  it('normalizes platform path separators', () => {
    expect(DevReload.classify('view', ['content', 'home.html'].join(path.sep))).toEqual({type: 'part', name: 'content'})
  })
})

describe('DevReload.message()', () => {
  const pending = over => ({reload: false, server: false, all: false, parts: new Set(), css: new Set(), ...over})

  it('a reload overrides everything else', () => {
    expect(DevReload.message(pending({reload: true, server: true, css: new Set(['/a.css'])}))).toEqual({reload: true})
  })

  it('a server change refreshes every part', () => {
    expect(DevReload.message(pending({server: true, parts: new Set(['content'])}))).toEqual({parts: '*'})
  })

  it('lists changed parts and stylesheets', () => {
    expect(DevReload.message(pending({parts: new Set(['content', 'header']), css: new Set(['/a.css'])}))).toEqual({
      css: ['/a.css'],
      parts: ['content', 'header']
    })
  })

  it('is null when nothing needs the browser', () => {
    expect(DevReload.message(pending())).toBeNull()
  })
})

describe('DevReload', () => {
  let watchers, watch

  const fakeWatch = () => {
    watchers = {}
    watch = jest.fn((dir, options, listener) => {
      const watcher = new EventEmitter()
      watcher.close = jest.fn()
      watcher.listener = listener
      watchers[path.basename(dir)] = watcher
      return watcher
    })
  }

  const client = () => {
    const sent = []
    let onClose
    const stream = {}
    const Odac = {
      stream: jest.fn(input => {
        onClose = input(
          message => sent.push(message),
          () => onClose()
        )
        return stream
      })
    }
    return {Odac, sent, stream, disconnect: () => onClose()}
  }

  const flush = () => new Promise(resolve => setTimeout(resolve, 20))

  beforeEach(fakeWatch)

  it('watches each project directory recursively without keeping the process alive', () => {
    const dev = new DevReload({root: '/app', reload: jest.fn(), watch})
    dev.start()
    const dirs = watch.mock.calls.map(([dir]) => dir)
    expect(dirs).toEqual(
      ['view', 'skeleton', 'public', 'route', 'controller', 'class', 'middleware', 'hook'].map(d => path.join('/app', d))
    )
    expect(watch.mock.calls[0][1]).toEqual({recursive: true, persistent: false})
    dev.start()
    expect(watch).toHaveBeenCalledTimes(8)
    dev.stop()
  })

  it('skips directories that do not exist', () => {
    const missing = jest.fn(dir => {
      if (dir.endsWith('class')) throw Object.assign(new Error('missing'), {code: 'ENOENT'})
      return watch(dir, {}, () => {})
    })
    const dev = new DevReload({root: '/app', reload: jest.fn(), watch: missing})
    expect(() => dev.start()).not.toThrow()
    expect(watchers.class).toBeUndefined()
    dev.stop()
  })

  it('collects a burst of changes into one message for every connected tab', async () => {
    const dev = new DevReload({root: '/app', reload: jest.fn(), watch, debounce: 5})
    dev.start()
    const a = client()
    const b = client()
    dev.connect(a.Odac)
    dev.connect(b.Odac)
    expect(dev.clients).toBe(2)

    watchers.view.listener('change', 'content/home.html')
    watchers.view.listener('rename', 'content/home.html')
    watchers.public.listener('change', 'assets/css/app.css')
    await flush()

    expect(a.sent).toEqual([{css: ['/assets/css/app.css'], parts: ['content']}])
    expect(b.sent).toEqual(a.sent)
    dev.stop()
  })

  it('reloads server code before telling the browser', async () => {
    const order = []
    const reload = jest.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      order.push('reloaded')
    })
    const dev = new DevReload({root: '/app', reload, watch, debounce: 5})
    dev.start()
    const tab = {
      Odac: {
        stream: input =>
          input(
            m => order.push(m),
            () => {}
          )
      }
    }
    dev.connect(tab.Odac)

    watchers.controller.listener('change', 'page/index.js')
    await new Promise(resolve => setTimeout(resolve, 40))

    expect(reload).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['reloaded', {parts: '*'}])
    dev.stop()
  })

  it('reloads server code even with no tab connected, and survives a failing reload', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {})
    const reload = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue()
    const dev = new DevReload({root: '/app', reload, watch, debounce: 5})
    dev.start()

    watchers.route.listener('change', 'www.js')
    await flush()
    watchers.route.listener('change', 'www.js')
    await flush()

    expect(reload).toHaveBeenCalledTimes(2)
    expect(errors.mock.calls.some(([line]) => JSON.parse(line).error === 'boom')).toBe(true)
    errors.mockRestore()
    dev.stop()
  })

  it('sends nothing for ignored files', async () => {
    const dev = new DevReload({root: '/app', reload: jest.fn(), watch, debounce: 5})
    dev.start()
    const tab = client()
    dev.connect(tab.Odac)
    watchers.view.listener('change', 'css/app.css')
    watchers.view.listener('change', 'content/.home.html.swp')
    await flush()
    expect(tab.sent).toEqual([])
    dev.stop()
  })

  it('forgets a tab once its stream closes', async () => {
    const dev = new DevReload({root: '/app', reload: jest.fn(), watch, debounce: 5})
    dev.start()
    const tab = client()
    dev.connect(tab.Odac)
    tab.disconnect()
    expect(dev.clients).toBe(0)
    watchers.skeleton.listener('change', 'main.html')
    await flush()
    expect(tab.sent).toEqual([])
    dev.stop()
  })

  it('drops a watcher that errors', () => {
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {})
    const dev = new DevReload({root: '/app', reload: jest.fn(), watch})
    dev.start()
    watchers.view.emit('error', new Error('EMFILE'))
    expect(watchers.view.close).toHaveBeenCalled()
    dev.stop()
    expect(watchers.view.close).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('stop() closes watchers and open streams and cancels a pending burst', async () => {
    const dev = new DevReload({root: '/app', reload: jest.fn(), watch, debounce: 5})
    dev.start()
    const close = jest.fn()
    dev.connect({stream: input => input(() => {}, close)})
    watchers.view.listener('change', 'content/home.html')
    dev.stop()
    await flush()
    expect(close).toHaveBeenCalled()
    expect(dev.clients).toBe(0)
    for (const watcher of Object.values(watchers)) expect(watcher.close).toHaveBeenCalled()
  })

  it('reports real changes through fs.watch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-dev-'))
    fs.mkdirSync(path.join(root, 'view/content'), {recursive: true})
    const dev = new DevReload({root, reload: jest.fn(), debounce: 20})
    dev.start()
    const tab = client()
    dev.connect(tab.Odac)
    try {
      // Watchers may start late, and macOS also replays the creation of the directories made just
      // above (refreshing every part); write until the edit itself is reported.
      const reported = () => tab.sent.some(message => Array.isArray(message.parts) && message.parts.includes('content'))
      for (let i = 0; i < 50 && !reported(); i++) {
        fs.writeFileSync(path.join(root, 'view/content/home.html'), `<p>${i}</p>`)
        await new Promise(resolve => setTimeout(resolve, 60))
      }
      expect(tab.sent).toContainEqual({parts: ['content']})
    } finally {
      dev.stop()
      fs.rmSync(root, {recursive: true, force: true})
    }
  })
})
