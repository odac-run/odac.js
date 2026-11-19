const fs = require('fs')
const path = require('path')

// Saves arrive as bursts (write + rename + chmod, formatters, Tailwind rebuilding after a view
// edit). One window collects a burst into a single message for the browser.
const DEBOUNCE_MS = 100

// Directories whose files run on the server: a change reloads them before the browser refreshes.
const SERVER_DIRS = ['route', 'controller', 'class', 'middleware', 'hook']
// view/ subdirectories that are not page parts: sources the asset watchers compile into public/
// (whose output is watched instead) and mail templates, which no page renders.
const NON_PART_VIEW_DIRS = new Set(['css', 'js', 'mail'])
// Editor and tool leftovers: dotfiles, backups (`file~`), swap files and Vim's `4913` probe.
const IGNORED = /(?:^|\/)\.|~$|\.(?:swp|swx|swo|tmp)$|(?:^|\/)\d+$/

/**
 * Pushes source changes to open browser tabs while the app runs in debug mode.
 *
 * Why: the server already picks up edited views and code without a restart, but the developer
 * still had to refresh by hand. This watches the project, sorts each change by what it affects
 * and tells the page the least it must do: swap a stylesheet, re-render the changed part
 * through the AJAX navigation path, or reload the page. Only part names and public CSS URLs
 * leave the server, never server-side file paths.
 */
class DevReload {
  #root
  #reload
  #watch
  #debounce
  #watchers = []
  #clients = new Set()
  #pending = null
  #timer = null
  #flushing = Promise.resolve()

  /**
   * @param {object} options
   * @param {string} options.root Project root.
   * @param {() => Promise<void>} options.reload Reloads server-side code (the route loader cycle).
   * @param {typeof fs.watch} [options.watch] Watcher factory, injectable for tests.
   * @param {number} [options.debounce] Milliseconds a burst of changes is collected for.
   */
  constructor({root, reload, watch = fs.watch, debounce = DEBOUNCE_MS}) {
    this.#root = root
    this.#reload = reload
    this.#watch = watch
    this.#debounce = debounce
  }

  /**
   * Sorts a changed file by what the open page has to do about it.
   * Why: kept pure and static so the routing of every kind of change is testable on its own.
   * @param {string} dir Watched top-level directory (`view`, `skeleton`, `public`, a server dir).
   * @param {string|null} file Path inside `dir`, as fs.watch reports it; null when the platform
   *   does not name the file.
   * @returns {{type: 'reload'}|{type: 'css', url: string}|{type: 'part', name: string}|{type: 'parts'}|{type: 'server'}|null}
   *   null when the change needs nothing.
   */
  static classify(dir, file) {
    const rel = file ? String(file).split(path.sep).join('/') : null
    if (rel !== null && IGNORED.test(rel)) return null

    if (SERVER_DIRS.includes(dir)) return {type: 'server'}
    if (dir === 'skeleton') return {type: 'reload'}

    if (dir === 'public') {
      if (rel === null) return {type: 'reload'}
      if (rel.endsWith('.map')) return null
      if (rel.endsWith('.css')) return {type: 'css', url: `/${rel}`}
      return {type: 'reload'}
    }

    if (dir === 'view') {
      if (rel === null) return {type: 'parts'}
      const slash = rel.indexOf('/')
      if (slash === -1) return {type: 'parts'}
      const name = rel.slice(0, slash)
      if (NON_PART_VIEW_DIRS.has(name)) return null
      // Components and other shared views are not parts: every part may render them.
      if (name === 'components') return {type: 'parts'}
      return {type: 'part', name}
    }

    return null
  }

  /**
   * Starts watching the project directories that exist.
   * Why: recursive fs.watch reports a save at once, where the 5 s reload poll made every edit
   * wait. A directory that cannot be watched is skipped; the poll still covers server code.
   */
  start() {
    if (this.#watchers.length > 0) return
    for (const dir of ['view', 'skeleton', 'public', ...SERVER_DIRS]) {
      const full = path.join(this.#root, dir)
      let watcher
      try {
        watcher = this.#watch(full, {recursive: true, persistent: false}, (event, file) => this.#queue(dir, file))
      } catch (err) {
        if (err.code !== 'ENOENT') this.#log('WARN', 'Dev reload cannot watch a directory', {dir, error: err.message})
        continue
      }
      watcher.on('error', err => {
        this.#log('WARN', 'Dev reload stopped watching a directory', {dir, error: err.message})
        watcher.close()
        this.#watchers = this.#watchers.filter(w => w !== watcher)
      })
      this.#watchers.push(watcher)
    }
  }

  /**
   * Stops every watcher and ends every open browser connection.
   * Why: watchers hold file handles and the streams hold sockets; both must go on shutdown and
   * between tests.
   */
  stop() {
    clearTimeout(this.#timer)
    this.#timer = null
    this.#pending = null
    for (const watcher of this.#watchers) watcher.close()
    this.#watchers = []
    for (const client of this.#clients) client.close()
    this.#clients.clear()
  }

  /**
   * Serves the `/_odac/dev` event stream one browser tab listens to.
   * @param {object} Odac Request-scoped Odac instance.
   * @returns {import('../Stream.js')}
   */
  connect(Odac) {
    return Odac.stream((send, close) => {
      const client = {send, close}
      this.#clients.add(client)
      return () => this.#clients.delete(client)
    })
  }

  /** Number of connected browser tabs. */
  get clients() {
    return this.#clients.size
  }

  #queue(dir, file) {
    const change = DevReload.classify(dir, file)
    if (!change) return

    const pending = (this.#pending ??= {reload: false, server: false, all: false, parts: new Set(), css: new Set()})
    if (change.type === 'reload') pending.reload = true
    else if (change.type === 'server') pending.server = true
    else if (change.type === 'parts') pending.all = true
    else if (change.type === 'part') pending.parts.add(change.name)
    else if (change.type === 'css') pending.css.add(change.url)

    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      // Flushes run one after another so a burst saved during a slow server reload is not
      // announced before that reload has finished.
      this.#flushing = this.#flushing.then(() => this.#flush())
    }, this.#debounce)
    this.#timer.unref?.()
  }

  async #flush() {
    const pending = this.#pending
    this.#pending = null
    if (!pending) return

    if (pending.server) {
      try {
        await this.#reload()
      } catch (err) {
        this.#log('ERROR', 'Dev reload could not reload server code', {error: err.message})
      }
    }

    const message = DevReload.message(pending)
    if (!message || this.#clients.size === 0) return
    for (const client of this.#clients) client.send(message)
  }

  /**
   * Builds the message for one burst of changes.
   * Why: a reload makes everything else moot, and a server-side change can alter any part
   * (a controller sets the parts), so it refreshes them all.
   * @param {{reload: boolean, server: boolean, all: boolean, parts: Set<string>, css: Set<string>}} pending
   * @returns {{reload: true}|{css?: string[], parts?: string[]|'*'}|null}
   */
  static message(pending) {
    if (pending.reload) return {reload: true}
    const message = {}
    if (pending.css.size > 0) message.css = [...pending.css]
    if (pending.server || pending.all) message.parts = '*'
    else if (pending.parts.size > 0) message.parts = [...pending.parts]
    return Object.keys(message).length > 0 ? message : null
  }

  #log(level, message, fields) {
    console.error(JSON.stringify({level, message: `[ODAC] ${message}`, ...fields}))
  }
}

module.exports = DevReload
