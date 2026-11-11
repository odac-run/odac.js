const fsPromises = require('node:fs').promises

// How often a cached language file is checked for changes on disk.
const RECHECK_INTERVAL_MS = 2000
// Missing keys found within this window are written to disk in one go.
const SAVE_DEBOUNCE_MS = 500

/**
 * Per-process language data shared by every request.
 * Why: Lang is instantiated for every request and WebSocket upgrade. Reading and parsing the
 * language file there blocked the event loop on each one, static files and 404s included.
 * The file is now loaded once per worker, asynchronously, and re-read only when its mtime
 * changes.
 */
class LanguageStore {
  // lang -> {data, mtimeMs, checkedAt, loading, pending: Set, saveTimer}
  #entries = new Map()

  #file(lang) {
    return `${__dir}/storage/language/${lang}.json`
  }

  #entry(lang) {
    let entry = this.#entries.get(lang)
    if (!entry) {
      entry = {data: Object.create(null), mtimeMs: null, checkedAt: 0, loading: null, pending: new Set(), saveTimer: null}
      this.#entries.set(lang, entry)
    }
    return entry
  }

  async #readFile(lang) {
    try {
      const parsed = JSON.parse(await fsPromises.readFile(this.#file(lang), 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      // Missing or malformed file: serve keys untranslated rather than failing the request.
      return {}
    }
  }

  async #refresh(lang, entry) {
    let mtimeMs = null
    try {
      mtimeMs = (await fsPromises.stat(this.#file(lang))).mtimeMs
    } catch {
      // No file yet.
    }
    entry.checkedAt = Date.now()
    if (mtimeMs === entry.mtimeMs) return

    const data = Object.assign(Object.create(null), await this.#readFile(lang))
    // Keys collected but not yet saved must survive a reload.
    for (const key of entry.pending) if (!(key in data)) data[key] = key
    entry.data = data
    entry.mtimeMs = mtimeMs
  }

  /**
   * @param {string} lang Validated two-letter code.
   * @returns {Promise<object>} Null-prototype map of key -> translation.
   */
  async load(lang) {
    const entry = this.#entry(lang)
    if (Date.now() - entry.checkedAt >= RECHECK_INTERVAL_MS && !entry.loading) {
      entry.loading = this.#refresh(lang, entry).finally(() => (entry.loading = null))
    }
    if (entry.loading) await entry.loading
    return entry.data
  }

  /**
   * Records a key that has no translation yet so it shows up in the language file.
   * Writes are debounced and merged with the file's current content, so concurrent
   * workers add keys instead of overwriting each other's.
   */
  collect(lang, key) {
    const entry = this.#entry(lang)
    entry.data[key] = key
    entry.pending.add(key)
    if (entry.saveTimer) return
    entry.saveTimer = setTimeout(() => {
      entry.saveTimer = null
      this.#save(lang, entry).catch(() => {})
    }, SAVE_DEBOUNCE_MS)
    entry.saveTimer.unref?.()
  }

  async #save(lang, entry) {
    const keys = [...entry.pending]
    if (keys.length === 0) return
    entry.pending.clear()
    try {
      const dir = `${__dir}/storage/language/`
      await fsPromises.mkdir(dir, {recursive: true})
      const data = await this.#readFile(lang)
      let changed = false
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(data, key)) continue
        data[key] = key
        changed = true
      }
      if (!changed) return
      // Atomic write: a reader or another worker never sees a half-written file.
      const target = this.#file(lang)
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
      await fsPromises.writeFile(tmp, JSON.stringify(data, null, 4))
      await fsPromises.rename(tmp, target)
    } catch {
      // Best-effort persistence of auto-collected keys; never crash a request.
    }
  }

  /** Drops cached data and pending timers. Used by tests. */
  reset() {
    for (const entry of this.#entries.values()) clearTimeout(entry.saveTimer)
    this.#entries.clear()
  }
}

const store = new LanguageStore()

class Lang {
  #odac
  #lang

  /** Shared language cache; exposed so tests can reset it. */
  static store = store

  constructor(Odac) {
    this.#odac = Odac
    this.set()
  }

  /**
   * Translates a key, replacing `%s` (sequential) or `%s1`, `%s2` (numbered) placeholders.
   * Why: one lookup path for views, mails and validators. Untranslated keys are returned as
   * is and, when `lang.collect` is on (default: debug mode), added to the language file.
   * @returns {Promise<string>}
   */
  async get(...args) {
    if (typeof args[0] !== 'string') return args[0]
    const key = args[0]
    const data = await store.load(this.#lang)

    let str
    if (Object.prototype.hasOwnProperty.call(data, key) && typeof data[key] === 'string' && data[key]) {
      str = data[key]
    } else {
      str = key
      if (this.#collect() && !(key in data)) store.collect(this.#lang, key)
    }

    // Function replacers: argument values may contain `$&`-style patterns.
    if (/%s\d+/.test(str)) {
      for (let i = 1; i < args.length; i++) {
        const value = String(args[i])
        str = str.replace(new RegExp(`%s${i}`, 'g'), () => value)
      }
    } else {
      for (let i = 1; i < args.length; i++) {
        const value = String(args[i])
        str = str.replace('%s', () => value)
      }
    }
    return str
  }

  #collect() {
    const configured = this.#odac.Config?.lang?.collect
    return configured === undefined ? !!this.#odac.Config?.debug : !!configured
  }

  /**
   * Returns the active two-letter language code.
   * Why: controllers need it for locale-aware formatting (dates, numbers) that must match
   * the language the translations are served in.
   * @returns {string}
   */
  current() {
    return this.#lang
  }

  /**
   * Selects the request's language. Falls back to the Accept-Language header, then to
   * `lang.default`, then to `en`.
   * Why: the code becomes part of a filesystem path, so only two ASCII letters are accepted.
   * @param {string} [lang]
   */
  set(lang) {
    if (!lang || lang.length !== 2 || !this.#odac.Var(lang).is('alpha')) {
      if (
        this.#odac.Request &&
        this.#odac.Request.header &&
        this.#odac.Request.header('ACCEPT-LANGUAGE') &&
        this.#odac.Request.header('ACCEPT-LANGUAGE').length > 1
      ) {
        lang = this.#odac.Request.header('ACCEPT-LANGUAGE').slice(0, 2)
      } else {
        lang = this.#odac.Config.lang?.default || 'en'
      }
    }
    // Final gate before this value ever reaches a filesystem path: a language
    // code must be exactly two ASCII letters. Header junk ('a/', '..'), or a
    // misconfigured default, falls back to a guaranteed-valid code.
    lang = String(lang).toLowerCase()
    if (!/^[a-z]{2}$/.test(lang)) {
      lang = String(this.#odac.Config.lang?.default || 'en').toLowerCase()
      if (!/^[a-z]{2}$/.test(lang)) lang = 'en'
    }
    this.#lang = lang
  }
}

module.exports = Lang
