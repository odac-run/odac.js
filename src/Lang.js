const fsPromises = require('node:fs').promises
const path = require('node:path')
const {createHash, randomUUID} = require('node:crypto')
const Catalog = require('./Lang/Catalog.js')
const Files = require('./Lang/Files.js')
const Ipc = require('./Ipc.js')
const FrontendKeys = require('./Lang/Frontend.js')
const Runtime = require('./Lang/Runtime.js')

// How often a cached language file (and the list of language files) is checked on disk.
const RECHECK_INTERVAL_MS = 2000
// Missing keys found within this window are written to disk in one go.
const SAVE_DEBOUNCE_MS = 500
// Accept-Language entries considered; the rest of an oversized header is ignored.
const MAX_ACCEPT_LANGUAGES = 16
const MAX_ACCEPT_LANGUAGE_LENGTH = 512
// A language range longer than this is cut before its subtags are examined.
const MAX_RANGE_LENGTH = 64
// Serializes language file writes across workers (and servers sharing a Redis Ipc).
const WRITE_LOCK = 'odac:lang:write'
const WRITE_LOCK_TTL = 10
// Debug warnings for missing translations are logged once per entry, up to this many.
const MAX_WARNED = 10000
// Entries recorded as used at runtime per process; bounds memory when keys come from input.
const MAX_SEEN = 50000

// Browser translations per language: {entries, data, fallback, payload}, rebuilt only when
// one of its inputs changes (see Lang#client).
const clientCache = new Map()

function warn(message, fields) {
  console.error(JSON.stringify({level: 'WARN', message, ...fields}))
}

/**
 * Per-process language data shared by every request.
 * Why: Lang is instantiated for every request and WebSocket upgrade, and `Odac.__()` is
 * synchronous. Every language file is therefore read once per worker at startup, without
 * blocking the event loop, and kept in memory; lookups never touch the disk. Files are
 * re-checked in the background and re-read only when their mtime changes
 * (stale-while-revalidate: the lookup that notices a stale file is still served the
 * version in memory).
 */
class LanguageStore {
  // lang -> {data, mtimeMs, checkedAt, loading, failedMtimeMs}
  #entries = new Map()
  // Language codes that have a file in the language directory, refreshed in the background. A
  // code is added only once its file is loaded, so language selection never picks a
  // language whose translations are not in memory yet.
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
  #notReadyWarned = false
  // Incremented by reset(), so background work started before it is discarded.
  #generation = 0
  // Entries looked up while collecting: id -> day last recorded (see Lang/Runtime.js).
  #seen = new Map()
  // Entries whose day changed and is not written yet: id -> {key, context, seen}.
  #seenPending = new Map()
  // The resolved language directory: {root, config, promise}; resolved again when the
  // project root or the config object changes (Lang used before Odac.init(), then init()).
  #directory = null
  #directoryWarned = false

  // Resolves to the language directory (see Files.resolveDirectory).
  #dir() {
    const root = __dir
    const config = this.#config
    if (this.#directory?.root !== root || this.#directory.config !== config) {
      const promise = Files.resolveDirectory(root, config).then(result => {
        this.#reportDirectory(result, config)
        return result.dir
      })
      this.#directory = {root, config, promise}
    }
    return this.#directory.promise
  }

  // Logged once per process: both cases keep working, so nothing else would point them out.
  #reportDirectory({legacy, ignored}, config) {
    if (this.#directoryWarned || (!legacy && !ignored)) return
    this.#directoryWarned = true
    if (ignored) warn('lang.path is not a non-empty string; using the default language directory', {path: config?.lang?.path})
    if (legacy) {
      warn('Language files are read from the deprecated storage/language/; move them to lang/ or set lang.path', {
        dir: path.join('storage', 'language')
      })
    }
  }

  #entry(lang) {
    let entry = this.#entries.get(lang)
    if (!entry) {
      entry = {data: Object.create(null), mtimeMs: null, checkedAt: 0, loading: null, failedMtimeMs: undefined}
      this.#entries.set(lang, entry)
    }
    return entry
  }

  // The value a not yet translated entry has: the key in the default language, '' elsewhere.
  #placeholder(lang, key) {
    return lang === Catalog.defaultLanguage(this.#config) ? key : ''
  }

  async #refresh(lang, entry) {
    const dir = await this.#dir()
    let mtimeMs = null
    try {
      mtimeMs = (await fsPromises.stat(path.join(dir, `${lang}.json`))).mtimeMs
    } catch {
      // No file yet.
    }
    entry.checkedAt = Date.now()
    if (mtimeMs === entry.mtimeMs) return

    // A file that cannot be read or is not a JSON object (a typo, or one read while an editor
    // or upload was still writing it) keeps the last valid translations instead of wiping
    // them. entry.mtimeMs stays behind, so it is read again on every check until it is
    // valid; the warning is logged once per version of the file.
    let file
    try {
      file = await Files.readLanguage(dir, lang)
    } catch (e) {
      file = {valid: false, error: e?.message ?? String(e)}
    }
    if (!file.valid) {
      if (entry.failedMtimeMs !== mtimeMs) {
        entry.failedMtimeMs = mtimeMs
        if (file.error) warn('Language file could not be read; serving its last valid version', {lang, error: file.error})
        else warn('Language file is not valid JSON; serving its last valid version', {lang})
      }
      return
    }
    entry.failedMtimeMs = undefined

    // A missing file (raw null) serves the keys untranslated.
    const data = file.data
    // Keys collected but not yet saved must survive a reload.
    for (const {key, context} of this.#pending.values()) Catalog.addEntry(data, key, context, this.#placeholder(lang, key))
    entry.data = data
    entry.mtimeMs = mtimeMs
  }

  // Starts a background re-check of a language file unless one is running or it was
  // checked within RECHECK_INTERVAL_MS. Returns the running check, if any.
  #revalidate(lang, entry) {
    if (!entry.loading && Date.now() - entry.checkedAt >= RECHECK_INTERVAL_MS) {
      entry.loading = this.#refresh(lang, entry)
        .catch(e => warn('Language file could not be checked', {lang, error: e?.message ?? String(e)}))
        .finally(() => (entry.loading = null))
    }
    return entry.loading
  }

  async #scan() {
    // A scan still running when reset() is called must not touch the new state.
    const generation = this.#generation
    const codes = await Files.listLanguages(await this.#dir())
    if (generation !== this.#generation) return
    // Languages served without a file of their own (the default, lang.supported) are loaded
    // too, so a file created for them later is noticed by the regular re-check.
    const wanted = new Set(codes)
    wanted.add(Catalog.defaultLanguage(this.#config))
    for (const code of Catalog.configuredLanguages(this.#config) ?? []) wanted.add(code)
    // Only languages never loaded are awaited; the others are re-checked on their own schedule.
    await Promise.all([...wanted].filter(code => this.#entry(code).checkedAt === 0).map(code => this.#revalidate(code, this.#entry(code))))
    if (generation !== this.#generation) return
    this.#available = new Set(codes)
    this.#availableCheckedAt = Date.now()
  }

  /**
   * Lists the language files on disk and loads every one of them into memory.
   * Why: translation and language selection are synchronous (`Odac.__()`, the Lang
   * constructor), so the translations must be in memory before the first request. Awaited
   * once at startup; afterwards it runs in the background to notice added files.
   * @param {object} [config] The application config (default and supported languages).
   * @returns {Promise<void>}
   */
  init(config) {
    if (config) this.#config = config
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
   * server look up, and with key collection create, a file for every language code.
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
   * Returns the translations of a language from memory, never waiting for the disk.
   * Why: lookups are synchronous. A stale file is re-checked in the background and its new
   * version is served from the next lookup on. A language not loaded at startup (one added
   * to the config at runtime) has no translations until its first load finishes.
   * @param {string} lang Validated canonical code.
   * @returns {object} Null-prototype map of key -> translation.
   */
  load(lang) {
    const entry = this.#entry(lang)
    this.#revalidate(lang, entry)
    return entry.data
  }

  /** Resolves once background scans and file re-checks have finished. Used by tests. */
  async settle() {
    await this.#scanning
    await Promise.all([...this.#entries.values()].map(entry => entry.loading))
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

  /**
   * Records that an entry was looked up, for the runtime record `odac lang:prune` consults.
   * Why: keys built at runtime cannot be found in the source; this is how prune learns they
   * are in use. An entry is written at most once a day, so lookups stay a Map check.
   * @param {string} key
   * @param {string} context
   */
  seen(key, context) {
    const id = Catalog.entryId(key, context)
    const day = Runtime.today()
    const previous = this.#seen.get(id)
    if (previous === day || (previous === undefined && this.#seen.size >= MAX_SEEN)) return
    this.#seen.set(id, day)
    this.#seenPending.set(id, {key, context, seen: day})
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
    if (this.#pending.size === 0 && this.#seenPending.size === 0) return
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
      // Taken after the lock: entries collected while waiting are written in this round.
      const items = [...this.#pending.values()]
      const seen = [...this.#seenPending.values()]
      this.#pending.clear()
      this.#seenPending.clear()
      await Promise.all([this.#saveEntries(items), this.#saveSeen(seen)])
    } catch (e) {
      // Best-effort persistence of auto-collected keys; never crash a request.
      warn('Could not save collected translation keys', {error: e?.message ?? String(e)})
    } finally {
      if (owner) await Ipc.unlock(WRITE_LOCK, owner).catch(() => {})
    }
  }

  async #saveEntries(items) {
    if (items.length === 0) return
    try {
      const result = await Files.sync(await this.#dir(), {
        languages: this.languages(this.#config),
        defaultLanguage: Catalog.defaultLanguage(this.#config),
        add: items
      })
      for (const code of result.invalid) warn('Language file is not valid JSON; collected keys were not added to it', {lang: code})
    } catch (e) {
      warn('Could not save collected translation keys', {error: e?.message ?? String(e)})
    }
  }

  async #saveSeen(items) {
    if (items.length === 0) return
    try {
      await Runtime.record(__dir, items)
    } catch (e) {
      // Forget them so the next lookup records them again.
      for (const {key, context} of items) this.#seen.delete(Catalog.entryId(key, context))
      warn('Could not save the runtime translation record', {error: e?.message ?? String(e)})
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

  /**
   * Logs once that translations were requested before the language files were loaded.
   * Why: keys are then served untranslated, which in a script that skipped Odac.init()
   * otherwise looks like missing translations.
   * @returns {void}
   */
  warnNotReady() {
    if (this.#notReadyWarned) return
    this.#notReadyWarned = true
    warn('Translation requested before the language files were loaded; serving the key')
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
    this.#generation++
    clientCache.clear()
    clearTimeout(this.#saveTimer)
    this.#saveTimer = null
    this.#entries.clear()
    this.#pending.clear()
    this.#warned.clear()
    this.#notReadyWarned = false
    this.#seen.clear()
    this.#seenPending.clear()
    this.#available = null
    this.#availableCheckedAt = 0
    this.#scanning = null
    this.#config = null
    this.#directory = null
    this.#directoryWarned = false
  }
}

const store = new LanguageStore()
const frontendKeys = new FrontendKeys()

// The canonical code of a language range, dropping trailing subtags ODAC does not use
// (`de-CH-1996` -> `de-CH`, `en-US-u-ca-gregory` -> `en-US`); null for `*` or garbage.
function rangeLanguage(range) {
  let tag = range.slice(0, MAX_RANGE_LENGTH)
  for (;;) {
    const code = Catalog.normalizeLanguage(tag)
    if (code) return code
    const end = tag.lastIndexOf('-')
    if (end <= 0) return null
    tag = tag.slice(0, end)
  }
}

/**
 * Parses an Accept-Language header into canonical language codes, most preferred first.
 * @param {string} header
 * @returns {string[]}
 */
function parseAcceptLanguage(header) {
  if (typeof header !== 'string' || header === '') return []
  const ranked = []
  const parts = header.slice(0, MAX_ACCEPT_LANGUAGE_LENGTH).split(',', MAX_ACCEPT_LANGUAGES)
  for (let i = 0; i < parts.length; i++) {
    const [range, ...params] = parts[i].trim().split(';')
    const code = rangeLanguage(range.trim())
    if (!code) continue
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
  // Languages asked for through Accept-Language, in order of preference.
  #candidates = []
  // The code passed to set(), canonical, when it is a valid language code.
  #explicit = null
  // True when #lang was matched from #explicit, so it does not depend on Accept-Language.
  #fromExplicit = false
  // Languages a missing translation is served from, in order: the supported parents of #lang
  // (`pt` for `pt-BR`), then the default language.
  #fallbacks = []
  // How many of #fallbacks are parents; a translation found past them is a missing one.
  #parents = 0
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
   * active language falls back to its more general languages (`pt` for `pt-BR`), then to the
   * default language, then to the key itself. Untranslated
   * keys are added to the language file when `lang.collect` is on (default: debug mode); every
   * key looked up is then also recorded for `odac lang:prune` (see Lang/Runtime.js).
   * Synchronous: translations are served from memory (see LanguageStore), so the result can
   * be used directly in expressions; `await` on it is harmless.
   * @param {string} key
   * @param {...*} args Placeholder values.
   * @returns {string}
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
   * @returns {string}
   */
  getx(key, context, ...args) {
    return this.#translate(key, Catalog.normalizeContext(context), args)
  }

  #translate(key, context, args) {
    if (typeof key !== 'string') return key
    const lang = this.#resolved()
    const data = store.load(lang)
    const collect = this.#collect()
    if (collect) store.seen(key, context)

    let str = Catalog.lookup(data, key, context)
    if (str === undefined) {
      const config = this.#odac.Config
      // Before the files are loaded every key looks missing; nothing is collected then.
      if (collect && store.ready && !Catalog.has(data, key, context)) store.collect(key, context, config)
      const fallbacks = this.#fallbacks
      let found = 0
      for (; found < fallbacks.length; found++) {
        str = Catalog.lookup(store.load(fallbacks[found]), key, context)
        if (str !== undefined) break
      }
      // A regional language leaves to its parent what it does not override (`pt-BR` -> `pt`);
      // only text served from the default language, or not at all, is missing.
      if (config?.debug && found >= this.#parents && lang !== Catalog.defaultLanguage(config)) {
        store.warnMissing(lang, key, context)
        // Opt-in debug aid: makes text served from the fallback visible on the page.
        if (config.lang?.highlightMissing) str = `⟦${str ?? key}⟧`
      }
      if (str === undefined) str = key
    }
    return Catalog.format(str, args)
  }

  // The translation of an entry in the fallback languages, or undefined.
  #fallbackLookup(datas, key, context) {
    for (const data of datas) {
      const value = Catalog.lookup(data, key, context)
      if (value !== undefined) return value
    }
    return undefined
  }

  /**
   * Returns the translations the browser code needs, for `Odac.__()` in `view/js/`.
   * Why: only entries used under `view/js/` are included, already resolved for the active
   * language (with the same fallbacks as Odac.__()), so the browser gets neither the rest of
   * the dictionary nor a way to write to it. In debug mode, frontend entries missing from
   * the language files are collected like server-side ones.
   * `v` identifies the content: the browser reports it on AJAX navigation, so it receives
   * the translations again after a language file changed, not only after a language switch.
   * @returns {Promise<{lang: string, v: string, t: object}|null>} null when the frontend uses no keys.
   */
  async client() {
    const config = this.#odac.Config
    const entries = await frontendKeys.entries(__dir, !!config?.debug)
    if (entries.length === 0) return null
    const lang = this.#resolved()
    const data = store.load(lang)
    const fallbacks = this.#fallbacks.map(code => store.load(code))

    if (this.#collect() && store.ready)
      for (const {key, context} of entries) if (!Catalog.has(data, key, context)) store.collect(key, context, config)

    const cached = clientCache.get(lang)
    if (
      cached &&
      cached.entries === entries &&
      cached.data === data &&
      cached.fallbacks.length === fallbacks.length &&
      cached.fallbacks.every((fallback, i) => fallback === fallbacks[i])
    )
      return cached.payload

    const translated = []
    const values = new Map()
    for (const entry of entries) {
      const value = Catalog.lookup(data, entry.key, entry.context) ?? this.#fallbackLookup(fallbacks, entry.key, entry.context)
      if (!value) continue
      translated.push(entry)
      values.set(Catalog.entryId(entry.key, entry.context), value)
    }
    const t = Catalog.build(translated, (key, context) => values.get(Catalog.entryId(key, context)))
    // Computed only when the translations are rebuilt, never per request.
    const v = createHash('sha256').update(JSON.stringify(t)).digest('base64url').slice(0, 16)
    const payload = Object.freeze({lang, v, t})
    clientCache.set(lang, {entries, data, fallbacks, payload})
    return payload
  }

  #collect() {
    const configured = this.#odac.Config?.lang?.collect
    return configured === undefined ? !!this.#odac.Config?.debug : !!configured
  }

  // A language chosen before the language files were loaded is chosen again once they are.
  // Until then (Lang used before Odac.init(), e.g. in a script) keys are served
  // untranslated; the constructor has already started loading them.
  #resolved() {
    if (this.#provisional) {
      if (store.ready) this.#choose()
      else if (this.#odac.Config?.debug) store.warnNotReady()
    }
    return this.#lang
  }

  /**
   * Returns the active language code in canonical form (`tr`, `pt-BR`, `zh-Hant`).
   * Why: controllers need it for locale-aware formatting (dates, numbers) that must match
   * the language the translations are served in; it is a valid BCP 47 tag for `Intl`.
   * @returns {string}
   */
  current() {
    return this.#lang
  }

  /**
   * Returns the writing direction of the active language: `'rtl'` or `'ltr'`.
   * Why: layout that depends on direction (icons, margins, `<html dir>`) must follow the
   * language the page is served in.
   * @returns {'ltr'|'rtl'}
   */
  dir() {
    return Catalog.direction(this.#lang)
  }

  /**
   * Describes the language the response is served in, for `<html lang dir>` and the
   * `Content-Language` / `Vary` headers.
   * Why: screen readers, browser translation, hyphenation and case mapping (`text-transform`
   * turns `i` into `İ` only under `lang="tr"`) all read the declared language, and a shared
   * cache must not hand one visitor's language to another.
   * The language is declared only when the application declares languages: it serves more
   * than one, or configures `lang.default` / `lang.supported`. A single-language application
   * that configures nothing keeps whatever its skeleton says, since `en` would only be a guess.
   * `varies` is true when another Accept-Language could select another language. A language
   * chosen through set(code) (from the URL or the session) does not depend on that header.
   * @returns {{lang: string, dir: 'ltr'|'rtl', varies: boolean}|null}
   */
  served() {
    const lang = this.#resolved()
    const config = this.#odac.Config
    const multilingual = store.languages(config).size > 1
    if (!multilingual && config?.lang?.default == null && !Catalog.configuredLanguages(config)) return null
    return {lang, dir: Catalog.direction(lang), varies: multilingual && !this.#fromExplicit}
  }

  /**
   * Selects the request's language: the given code if a supported language serves it,
   * otherwise the most preferred Accept-Language entry one serves, otherwise `lang.default`,
   * then `en`. A code is served by itself, its parents (`pt` for `pt-BR`), its likely forms
   * (`zh-Hant` for `zh-TW`) or a more specific language (`pt-BR` for `pt`); see
   * Catalog.matchLanguage.
   * Why: the code becomes part of a filesystem path, so only `language[-Script][-REGION]`
   * is accepted (any case, `-` or `_`), and only languages the application has (see
   * LanguageStore#languages).
   * @param {string} [lang]
   */
  set(lang) {
    this.#explicit = Catalog.normalizeLanguage(lang)
    this.#candidates = parseAcceptLanguage(this.#odac.Request?.header?.('ACCEPT-LANGUAGE'))
    this.#choose()
  }

  #choose() {
    const config = this.#odac.Config
    const supported = store.languages(config)
    const def = Catalog.defaultLanguage(config)
    this.#provisional = !store.ready
    const explicit = this.#explicit ? Catalog.matchLanguage([this.#explicit], supported) : null
    this.#fromExplicit = explicit !== null
    const lang = explicit ?? Catalog.matchLanguage(this.#candidates, supported) ?? def
    const fallbacks = Catalog.parentLanguages(lang).filter(code => supported.has(code))
    this.#parents = fallbacks.length
    if (lang !== def && !fallbacks.includes(def)) fallbacks.push(def)
    this.#lang = lang
    this.#fallbacks = fallbacks
  }
}

module.exports = Lang
