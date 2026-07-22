const fs = require('node:fs')
const fsPromises = fs.promises

class Lang {
  #odac
  #data = {}
  #lang

  constructor(Odac) {
    this.#odac = Odac
    this.set()
  }

  async get(...args) {
    if (typeof args[0] !== 'string') return args[0]
    if (!this.#data[args[0]]) {
      this.#data[args[0]] = args[0]
      // Fire-and-forget so we never block the response on disk I/O; #save()
      // swallows its own errors, and .catch() is a belt-and-braces guard.
      this.#save().catch(() => {})
    }
    let str = this.#data[args[0]]

    // Support both %s (sequential) and %s1, %s2 (numbered) placeholders
    const hasNumberedPlaceholders = /%s\d+/.test(str)

    if (hasNumberedPlaceholders) {
      for (let i = 1; i < args.length; i++) {
        const numberedPattern = new RegExp(`%s${i}`, 'g')
        str = str.replace(numberedPattern, args[i])
      }
    } else {
      for (let i = 1; i < args.length; i++) {
        str = str.replace('%s', args[i])
      }
    }
    return str
  }

  async #save() {
    if (!this.#lang) return
    try {
      const langDir = __dir + '/storage/language/'
      if (!fs.existsSync(langDir)) await fsPromises.mkdir(langDir, {recursive: true})
      // Atomic write: a concurrent worker writing the same file can otherwise
      // interleave and corrupt the JSON. Write to a unique temp file, then rename.
      const target = langDir + this.#lang + '.json'
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
      await fsPromises.writeFile(tmp, JSON.stringify(this.#data, null, 4))
      await fsPromises.rename(tmp, target)
    } catch {
      // Best-effort persistence of auto-collected keys; never crash a request.
    }
  }

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
    const langFile = __dir + '/storage/language/' + lang + '.json'
    if (fs.existsSync(langFile)) {
      // Use Sync read here only because it's during initialization/request entry
      // and we need to block briefly to ensure data is ready before logic proceeds.
      // In a high-load system, this should Ideally be pre-cached.
      this.#data = JSON.parse(fs.readFileSync(langFile, 'utf8'))
    } else {
      this.#data = {}
    }
  }
}

module.exports = Lang
