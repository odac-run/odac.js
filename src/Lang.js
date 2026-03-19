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
      this.#save()
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
    const langDir = __dir + '/storage/language/'
    if (!fs.existsSync(langDir)) await fsPromises.mkdir(langDir, {recursive: true})
    await fsPromises.writeFile(langDir + this.#lang + '.json', JSON.stringify(this.#data, null, 4))
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
