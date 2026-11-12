const fsPromises = require('fs').promises
const path = require('path')

// The events the framework fires, by hook file. Hooks are a closed set with documented
// contracts, not a general event bus: a file or export outside this list is reported at load
// time instead of silently never running (e.g. a misspelled `logn`).
const EVENTS = {
  auth: new Set(['beforeLogin', 'login', 'loginFailed'])
}

/**
 * Loads the app's `hook/` directory and runs the framework lifecycle hooks it defines.
 * Why: some app logic belongs to framework events rather than to a route (recording the last
 * login, vetoing a banned account). Listeners registered from route files would pile up on
 * every hot reload, so hooks live in convention files that are reloaded like middleware.
 */
class Hook {
  static #modules = {}

  /**
   * Loads new or changed hook files and drops the ones that were removed.
   * Why: runs with the route loader (startup and every hot reload cycle). A file that fails to
   * load keeps its previous handlers, so a half-saved edit never disables a running hook.
   * @param {string} [dir] Directory to scan; defaults to `<app>/hook/`.
   */
  static async load(dir = path.join(global.__dir || process.cwd(), 'hook')) {
    let files
    try {
      files = await fsPromises.readdir(dir)
    } catch {
      Hook.#modules = {}
      return
    }

    const seen = new Set()
    for (const file of files) {
      if (!file.endsWith('.js')) continue
      const name = file.slice(0, -3)
      const filePath = path.join(dir, file)
      seen.add(name)

      const {mtimeMs: mtime} = await fsPromises.stat(filePath)
      const current = Hook.#modules[name]
      if (current && current.path === filePath && current.mtime >= mtime - 1000) continue

      if (!EVENTS[name]) {
        Hook.#modules[name] = {path: filePath, mtime, handlers: {}}
        console.error(
          `\x1b[33m[ODAC]\x1b[0m Unknown hook file ignored: \x1b[33m${filePath}\x1b[0m (known: ${Object.keys(EVENTS).join(', ')})`
        )
        continue
      }

      try {
        delete require.cache[require.resolve(filePath)]
        Hook.#modules[name] = {path: filePath, mtime, handlers: Hook.#handlers(name, filePath, require(filePath))}
      } catch (err) {
        // Recorded so the same broken save is not retried every cycle.
        if (current) current.mtime = mtime
        else Hook.#modules[name] = {path: filePath, mtime, handlers: {}}
        console.error(`\x1b[31m[ODAC]\x1b[0m Failed to load hook: \x1b[33m${filePath}\x1b[0m`)
        console.error(`\x1b[31m[ODAC]\x1b[0m ${err.message}`)
      }
    }

    for (const name of Object.keys(Hook.#modules)) if (!seen.has(name)) delete Hook.#modules[name]
  }

  static #handlers(name, filePath, exported) {
    if (!exported || typeof exported !== 'object') throw new Error(`${filePath} must export an object of hook functions`)
    const handlers = {}
    for (const event of Object.keys(exported)) {
      if (!EVENTS[name].has(event)) {
        console.error(`\x1b[33m[ODAC]\x1b[0m Unknown ${name} hook "${event}" in ${filePath} (known: ${[...EVENTS[name]].join(', ')})`)
        continue
      }
      if (typeof exported[event] !== 'function') throw new Error(`${name} hook "${event}" in ${filePath} is not a function`)
      handlers[event] = exported[event]
    }
    return handlers
  }

  /**
   * Whether the app defines a hook.
   * Why: callers skip building the payload on the hot path when nothing listens.
   * @param {string} module Hook file name (e.g. 'auth').
   * @param {string} event Event name (e.g. 'login').
   * @returns {boolean}
   */
  static has(module, event) {
    return typeof Hook.#modules[module]?.handlers[event] === 'function'
  }

  /**
   * Runs a hook and reports its outcome without throwing.
   * Why: each caller decides what a failing hook means (a veto hook fails closed, a
   * notification hook is ignored), so errors are logged here and returned, never raised.
   * @param {string} module Hook file name.
   * @param {string} event Event name.
   * @param {...*} args Arguments passed to the hook.
   * @returns {Promise<{ran: boolean, value?: *, error?: Error}>}
   */
  static async run(module, event, ...args) {
    // Captured before awaiting: a hot reload mid-call must not swap the handler.
    const handler = Hook.#modules[module]?.handlers[event]
    if (typeof handler !== 'function') return {ran: false}
    try {
      return {ran: true, value: await handler(...args)}
    } catch (error) {
      console.error(`\x1b[31m[ODAC]\x1b[0m ${module} hook "${event}" failed:`, error)
      return {ran: true, error}
    }
  }
}

module.exports = Hook
