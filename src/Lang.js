const fsPromises = require('node:fs').promises
const {randomUUID} = require('node:crypto')
const Catalog = require('./Lang/Catalog.js')
const Files = require('./Lang/Files.js')
const Ipc = require('./Ipc.js')
const FrontendKeys = require('./Lang/Frontend.js')

// How often a cached language file (and the list of language files) is checked on disk.
const RECHECK_INTERVAL_MS = 2000
// Missing keys found within this window are written to disk in one go.
const SAVE_DEBOUNCE_MS = 500
// Accept-Language entries considered; the rest of an oversized header is ignored.
const MAX_ACCEPT_LANGUAGES = 16
const MAX_ACCEPT_LANGUAGE_LENGTH = 512
// Serializes language file writes across workers (and servers sharing a Redis Ipc).
const WRITE_LOCK = 'odac:lang:write'
const WRITE_LOCK_TTL = 10
// Debug warnings for missing translations are logged once per entry, up to this many.
const MAX_WARNED = 10000

// Browser translations per language: {entries, data, fallback, payload}, rebuilt only when
// one of its inputs changes (see Lang#client).
const clientCache = new Map()

function warn(message, fields) {
  console.error(JSON.stringify({level: 'WARN', message, ...fields}))
}

/**
 * Per-process language data shared by every request.
 * Why: Lang is instantiated for every request and WebSocket upgrade. Reading and parsing the
 * language file there blocked the event loop on each one, static files and 404s included.
 * The file is now loaded once per worker, asynchronously, and re-read only when its mtime
 * changes.
 */
class LanguageStore {
  // lang -> {data, mtimeMs, checkedAt, loading}
  #entries = new Map()
  // Language codes that have a file in storage/language/, refreshed in the background.
  #available = null
  #availableCheckedAt = 0
  #scanning = null
  // Collected entries not written yet: id -> {key, context}. Shared by all languages,
  // because a new key is written to every language file at once.
  #pending = new Map()
  #config = null
  #saveTimer = null
  #saving = Promise.resolve()
  #warned = new Set()

  #dir() {
    return `${__dir}/storage/language/`
  }

  #file(lang) {
    return `${this.#dir()}${lang}.json`
  }

  #entry(lang) {
    let entry = this.#entries.get(lang)
    if (!entry) {
      entry = {data: Object.create(null), mtimeMs: null, checkedAt: 0, loading: null}
      this.#entries.set(lang, entry)
    }
    return entry
  }

  async #readFile(lang) {
    try {
      return Catalog.parse(await fsPromises.readFile(this.#file(lang), 'utf8'))
    } catch {
      // Missing file: serve keys untranslated rather than failing the request.
      return Object.create(null)
    }
  }

  // The value a not yet translated entry has: the key in the default language, '' elsewhere.
  #placeholder(lang, key) {
    return lang === Catalog.defaultLanguage(this.#config) ? key : ''
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

    const data = await this.#readFile(lang)
    // Keys collected but not yet saved must survive a reload.
    for (const {key, context} of this.#pending.values()) Catalog.addEntry(data, key, context, this.#placeholder(lang, key))
    entry.data = data
    entry.mtimeMs = mtimeMs
  }

  async #scan() {
    this.#available = new Set(await Files.listLanguages(this.#dir()))
    this.#availableCheckedAt = Date.now()
  }

  /**
   * Lists the language files on disk once, so the first request already sees them.
   * Why: language selection is synchronous (it runs in the Lang constructor); it reads a
   * snapshot that this primes at startup and that refreshes in the background afterwards.
   * @returns {Promise<void>}
   */
  init() {
    if (!this.#scanning) this.#scanning = this.#scan().finally(() => (this.#scanning = null))
    return this.#scanning
  }

  /** @returns {boolean} true once the language directory has been listed. */
  get ready() {
    return this.#available !== null
  }

  /**
   * Returns the languages a request may be served in.
   * Why: Accept-Language is client input. Without this whitelist any visitor could make the
   * server look up, and with key collection create, a file for every two-letter code.
   * `lang.supported` is a strict whitelist; without it, the files on disk decide. The
   * default language is always included.
   * @param {object} [config]
   * @returns {Set<string>}
   */
  languages(config) {
    const configured = Catalog.configuredLanguages(config)
    if (configured) return configured
    if (Date.now() - this.#availableCheckedAt >= RECHECK_INTERVAL_MS) this.init().catch(() => {})
    const codes = new Set(this.#available ?? [])
    codes.add(Catalog.defaultLanguage(config))
    return codes
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
   * Records an entry that no language file has yet, so it is added to all of them.
   * Writes are debounced, merged with the files' current content and serialized across
   * workers, so concurrent workers add keys instead of overwriting each other's.
   * @param {string} key
   * @param {string} context
   * @param {object} config The application config (default and supported languages).
   */
  collect(key, context, config) {
    this.#config = config
    const id = Catalog.entryId(key, context)
    if (this.#pending.has(id)) return
    this.#pending.set(id, {key, context})
    for (const [lang, entry] of this.#entries) Catalog.addEntry(entry.data, key, context, this.#placeholder(lang, key))
    this.#schedule()
  }

  #schedule() {
    if (this.#saveTimer) return
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null
      this.#saving = this.#saving.then(() => this.#save())
    }, SAVE_DEBOUNCE_MS)
    this.#saveTimer.unref?.()
  }

  async #save() {
    const items = [...this.#pending.values()]
    if (items.length === 0) return
    let owner = null
    try {
      // Every language file is written, so the list of them must be known first.
      if (!this.ready) await this.init()
      if (Ipc.initialized) {
        owner = randomUUID()
        if (!(await Ipc.lock(WRITE_LOCK, WRITE_LOCK_TTL, owner))) {
          // Another worker is writing; try again after it.
          owner = null
          this.#schedule()
          return
        }
      }
      for (const item of items) this.#pending.delete(Catalog.entryId(item.key, item.context))
      const result = await Files.sync(this.#dir(), {
        languages: this.languages(this.#config),
        defaultLanguage: Catalog.defaultLanguage(this.#config),
        add: items
      })
      for (const code of result.invalid) warn('Language file is not valid JSON; collected keys were not added to it', {lang: code})
    } catch (e) {
      // Best-effort persistence of auto-collected keys; never crash a request.
      warn('Could not save collected translation keys', {error: e?.message ?? String(e)})
    } finally {
      if (owner) await Ipc.unlock(WRITE_LOCK, owner).catch(() => {})
    }
  }

  /**
   * Logs a missing translation once per language and entry.
   * Why: missing translations fall back to the default language, so the page looks fine and
   * nobody notices; debug mode says so instead.
   * @returns {void}
   */
  warnMissing(lang, key, context) {
    const id = `${lang}\u0000${Catalog.entryId(key, context)}`
    if (this.#warned.has(id) || this.#warned.size >= MAX_WARNED) return
    this.#warned.add(id)
    warn('Missing translation', context ? {lang, key, context} : {lang, key})
  }

  /** Resolves once pending writes are on disk. Used by tests. */
  async flush() {
    clearTimeout(this.#saveTimer)
    this.#saveTimer = null
    this.#saving = this.#saving.then(() => this.#save())
    await this.#saving
  }

  /** Drops cached data and pending timers. Used by tests. */
  reset() {
    clientCache.clear()
    clearTimeout(this.#saveTimer)
    this.#saveTimer = null
    this.#entries.clear()
    this.#pending.clear()
    this.#warned.clear()
    this.#available = null
    this.#availableCheckedAt = 0
    this.#scanning = null
    this.#config = null
  }
}

const store = new LanguageStore()
const frontendKeys = new FrontendKeys()

/**
 * Parses an Accept-Language header into two-letter codes, most preferred first.
 * @param {string} header
 * @returns {string[]}
 */
function parseAcceptLanguage(header) {
  if (typeof header !== 'string' || header === '') return []
  const ranked = []
  const parts = header.slice(0, MAX_ACCEPT_LANGUAGE_LENGTH).split(',', MAX_ACCEPT_LANGUAGES)
  for (let i = 0; i < parts.length; i++) {
    const [range, ...params] = parts[i].trim().split(';')
    const code = range.trim().slice(0, 2).toLowerCase()
    if (!Catalog.isLanguageCode(code) || (range.length > 2 && range[2] !== '-')) continue
    let q = 1
    for (const param of params) {
      const [name, value] = param.trim().split('=')
      if (name === 'q') q = Number(value)
    }
    if (!(q > 0)) continue
    ranked.push({code, q, i})
  }
  ranked.sort((a, b) => b.q - a.q || a.i - b.i)
  return ranked.map(r => r.code)
}

class Lang {
  #odac
  #lang
  // Languages asked for (explicitly or through Accept-Language), in order of preference.
  #candidates = []
  // Set when #lang was chosen before the language directory was listed.
  #provisional = false

  /** Shared language cache; exposed so tests can reset it. */
  static store = store
  /** Frontend key scan; exposed so tests can reset it. */
  static frontendKeys = frontendKeys

  constructor(Odac) {
    this.#odac = Odac
    this.set()
  }

  /**
   * Translates a key, replacing `%s` (sequential) or `%s1`, `%s2` (numbered) placeholders.
   * Why: one lookup path for views, mails and validators. A key without a translation in the
   * active language falls back to the default language, then to the key itself. Untranslated
   * keys are added to the language file when `lang.collect` is on (default: debug mode).
   * @returns {Promise<string>}
   */
  get(key, ...args) {
    return this.#translate(key, '', args)
  }

  /**
   * Translates a key within a context, e.g. `getx('Gül', 'verb')`.
   * Why: the same source text can need different translations depending on where it is used
   * ("Gül" is "Rose" as a noun and "Smile" as a verb). The context is part of the entry's
   * identity; in the language file the key holds an object of context -> translation. A
   * missing context variant falls back to the same variant in the default language, then to
   * the key; never to another context's translation.
   * @param {string} key
   * @param {string} context
   * @param {...*} args Placeholder values.
   * @returns {Promise<string>}
   */
  getx(key, context, ...args) {
    return this.#translate(key, Catalog.normalizeContext(context), args)
  }

  async #translate(key, context, args) {
    if (typeof key !== 'string') return key
    const lang = await this.#resolved()
    const data = await store.load(lang)

    let str = Catalog.lookup(data, key, context)
    if (str === undefined) {
      const config = this.#odac.Config
      if (this.#collect() && !Catalog.has(data, key, context)) store.collect(key, context, config)
      const fallback = Catalog.defaultLanguage(config)
      if (fallback !== lang) {
        str = Catalog.lookup(await store.load(fallback), key, context)
        if (config?.debug) {
          store.warnMissing(lang, key, context)
          // Opt-in debug aid: makes text served from the fallback visible on the page.
          if (config.lang?.highlightMissing) str = `⟦${str ?? key}⟧`
        }
      }
      if (str === undefined) str = key
    }
    return Catalog.format(str, args)
  }

  /**
   * Returns the translations the browser code needs, for `Odac.__()` in `view/js/`.
   * Why: only entries used under `view/js/` are included, already resolved for the active
   * language (with the default-language fallback), so the browser gets neither the rest of
   * the dictionary nor a way to write to it. In debug mode, frontend entries missing from
   * the language files are collected like server-side ones.
   * @returns {Promise<{lang: string, t: object}|null>} null when the frontend uses no keys.
   */
  async client() {
    const config = this.#odac.Config
    const entries = await frontendKeys.entries(__dir, !!config?.debug)
    if (entries.length === 0) return null
    const lang = await this.#resolved()
    const data = await store.load(lang)
    const def = Catalog.defaultLanguage(config)
    const fallback = def === lang ? null : await store.load(def)

    if (this.#collect()) for (const {key, context} of entries) if (!Catalog.has(data, key, context)) store.collect(key, context, config)

    const cached = clientCache.get(lang)
    if (cached && cached.entries === entries && cached.data === data && cached.fallback === fallback) return cached.payload

    const translated = []
    const values = new Map()
    for (const entry of entries) {
      const value = Catalog.lookup(data, entry.key, entry.context) ?? (fallback && Catalog.lookup(fallback, entry.key, entry.context))
      if (!value) continue
      translated.push(entry)
      values.set(Catalog.entryId(entry.key, entry.context), value)
    }
    const t = Catalog.build(translated, (key, context) => values.get(Catalog.entryId(key, context)))
    const payload = Object.freeze({lang, t})
    clientCache.set(lang, {entries, data, fallback, payload})
    return payload
  }

  #collect() {
    const configured = this.#odac.Config?.lang?.collect
    return configured === undefined ? !!this.#odac.Config?.debug : !!configured
  }

  // A language chosen before the directory was listed is re-checked once it is.
  async #resolved() {
    if (this.#provisional) {
      if (!store.ready) await store.init()
      this.#choose()
    }
    return this.#lang
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
   * Selects the request's language: the given code if it is supported, otherwise the most
   * preferred supported language of the Accept-Language header, otherwise `lang.default`,
   * then `en`.
   * Why: the code becomes part of a filesystem path, so only two ASCII letters are accepted,
   * and only languages the application has (see LanguageStore#languages).
   * @param {string} [lang]
   */
  set(lang) {
    const candidates = []
    if (lang && lang.length === 2 && this.#odac.Var(lang).is('alpha')) candidates.push(String(lang).toLowerCase())
    const header = this.#odac.Request?.header?.('ACCEPT-LANGUAGE')
    for (const code of parseAcceptLanguage(header)) candidates.push(code)
    this.#candidates = candidates
    this.#choose()
  }

  #choose() {
    const config = this.#odac.Config
    const supported = store.languages(config)
    this.#provisional = !store.ready && !Catalog.configuredLanguages(config)
    this.#lang = this.#candidates.find(code => Catalog.isLanguageCode(code) && supported.has(code)) ?? Catalog.defaultLanguage(config)
  }
}

module.exports = Lang
