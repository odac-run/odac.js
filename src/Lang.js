const fsPromises = require('node:fs').promises
const Catalog = require('./Lang/Catalog.js')

// How often a cached language file (and the list of language files) is checked on disk.
const RECHECK_INTERVAL_MS = 2000
// Missing keys found within this window are written to disk in one go.
const SAVE_DEBOUNCE_MS = 500
// Accept-Language entries considered; the rest of an oversized header is ignored.
const MAX_ACCEPT_LANGUAGES = 16
const MAX_ACCEPT_LANGUAGE_LENGTH = 512

/**
 * Per-process language data shared by every request.
 * Why: Lang is instantiated for every request and WebSocket upgrade. Reading and parsing the
 * language file there blocked the event loop on each one, static files and 404s included.
 * The file is now loaded once per worker, asynchronously, and re-read only when its mtime
 * changes.
 */
class LanguageStore {
  // lang -> {data, mtimeMs, checkedAt, loading, pending: Map(id -> {key, context}), saveTimer}
  #entries = new Map()
  // Language codes that have a file in storage/language/, refreshed in the background.
  #available = null
  #availableCheckedAt = 0
  #scanning = null

  #dir() {
    return `${__dir}/storage/language/`
  }

  #file(lang) {
    return `${this.#dir()}${lang}.json`
  }

  #entry(lang) {
    let entry = this.#entries.get(lang)
    if (!entry) {
      entry = {data: Object.create(null), mtimeMs: null, checkedAt: 0, loading: null, pending: new Map(), saveTimer: null}
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
    for (const {key, context} of entry.pending.values()) Catalog.addEntry(data, key, context, key)
    entry.data = data
    entry.mtimeMs = mtimeMs
  }

  async #scan() {
    const codes = new Set()
    try {
      for (const name of await fsPromises.readdir(this.#dir())) {
        const code = name.slice(0, -5)
        if (name.endsWith('.json') && Catalog.isLanguageCode(code)) codes.add(code)
      }
    } catch {
      // No language directory yet.
    }
    this.#available = codes
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
   * Records a key that has no translation yet so it shows up in the language file.
   * Writes are debounced and merged with the file's current content, so concurrent
   * workers add keys instead of overwriting each other's.
   */
  collect(lang, key, context = '') {
    const entry = this.#entry(lang)
    Catalog.addEntry(entry.data, key, context, key)
    entry.pending.set(Catalog.entryId(key, context), {key, context})
    if (entry.saveTimer) return
    entry.saveTimer = setTimeout(() => {
      entry.saveTimer = null
      this.#save(lang, entry).catch(() => {})
    }, SAVE_DEBOUNCE_MS)
    entry.saveTimer.unref?.()
  }

  async #save(lang, entry) {
    const keys = [...entry.pending.values()]
    if (keys.length === 0) return
    entry.pending.clear()
    try {
      await fsPromises.mkdir(this.#dir(), {recursive: true})
      const data = await this.#readFile(lang)
      let changed = false
      for (const {key, context} of keys) if (Catalog.addEntry(data, key, context, key)) changed = true
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
    this.#available = null
    this.#availableCheckedAt = 0
    this.#scanning = null
  }
}

const store = new LanguageStore()

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
      if (this.#collect() && !Catalog.has(data, key, context)) store.collect(lang, key, context)
      const fallback = Catalog.defaultLanguage(this.#odac.Config)
      if (fallback !== lang) str = Catalog.lookup(await store.load(fallback), key, context)
      if (str === undefined) str = key
    }
    return Catalog.format(str, args)
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
