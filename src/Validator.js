const https = require('https')
const fs = require('fs')
const fsPromises = fs.promises
const path = require('path')

let disposableDomains = null
const CACHE_FILE = path.join(global.__dir || process.cwd(), 'storage', '.cache', 'odac_disposable_domains.conf')
const SOURCE_URL = 'https://hub.odac.run/blocklist/disposable-emails'

async function loadDisposableDomains() {
  if (disposableDomains instanceof Set) return

  disposableDomains = new Set()
  let content = ''
  let shouldUpdate = true

  try {
    try {
      const handle = await fsPromises.open(CACHE_FILE, 'r')
      try {
        const stats = await handle.stat()
        const ageInHours = (new Date() - stats.mtime) / (1000 * 60 * 60)
        if (ageInHours < 24) {
          content = await handle.readFile('utf8')
          shouldUpdate = false
        }
      } finally {
        await handle.close()
      }
    } catch {
      // Cache error check failed, proceed to validation update
    }

    if (shouldUpdate) {
      try {
        content = await new Promise((resolve, reject) => {
          const req = https.get(SOURCE_URL, res => {
            if (res.statusCode !== 200) {
              res.resume()
              reject(new Error(`Failed to fetch: ${res.statusCode}`))
              return
            }
            let data = ''
            res.on('data', chunk => (data += chunk))
            res.on('end', () => resolve(data))
          })
          req.on('error', reject)
          req.end()
        })
        const tempFile = `${CACHE_FILE}_${Date.now()}_${Math.random().toString(36).slice(2)}`
        await fsPromises.mkdir(path.dirname(CACHE_FILE), {recursive: true})
        const handle = await fsPromises.open(tempFile, 'wx', 0o600)
        try {
          // SECURITY NOTE: Supply Chain Attack Mitigation
          // We strictly sanitize the content fetched from the remote source before writing it to the local file system.
          // The regex whitelist /[^a-zA-Z0-9.\-\n\r]/g restricts the content to only alphanumeric characters, dots, hyphens, and newlines.
          // This aggressively neutralizes any potential malicious payloads (e.g., specific code injection, shell commands, or scrips)
          // even if the remote source (hub.odac.run) is compromised.
          const sanitizedContent = content.replace(/[^a-zA-Z0-9.\-\n\r]/g, '')
          await handle.write(sanitizedContent)
        } finally {
          await handle.close()
        }
        await fsPromises.rename(tempFile, CACHE_FILE)
      } catch {
        try {
          content = await fsPromises.readFile(CACHE_FILE, 'utf8')
        } catch {
          // No cache file available
        }
      }
    }

    if (content) {
      content.split('\n').forEach(line => {
        const domain = line.trim().toLowerCase()
        if (domain && !domain.startsWith('#')) {
          disposableDomains.add(domain)
        }
      })
    }
  } catch (error) {
    console.error(
      JSON.stringify({level: 'error', tag: 'ODAC Validator', message: 'Could not load disposable domains.', error: error.message})
    )
  }
}

class Validator {
  #checklist = {}
  #completed = false
  #message = {}
  #method = 'POST'
  #name = ''
  #request
  #odac

  constructor(Request, Odac) {
    this.#request = Request
    this.#odac = Odac || global.Odac
  }

  check(rules) {
    if (!this.#checklist[this.#method]) this.#checklist[this.#method] = {}
    if (!this.#checklist[this.#method][this.#name]) this.#checklist[this.#method][this.#name] = []
    this.#checklist[this.#method][this.#name].push({rules: rules, message: null})
    return this
  }

  async error() {
    if (!this.#completed) await this.#validate()
    return Object.keys(this.#message).length > 0
  }

  get(key) {
    if (this.#completed) this.#completed = false
    this.#method = 'GET'
    this.#name = key
    return this
  }

  message(value) {
    const checks = this.#checklist[this.#method][this.#name]
    if (checks && checks.length > 0) {
      checks[checks.length - 1].message = value
    }
    return this
  }

  post(key) {
    if (this.#completed) this.#completed = false
    this.#method = 'POST'
    this.#name = key
    return this
  }

  async result(message, data) {
    if (!this.#completed) await this.#validate()
    let result = {}
    result.result = {}
    result.result.success = Object.keys(this.#message).length === 0
    if (result.result.success) {
      result.result.message = message ?? ''
      result.data = data ?? null
    } else {
      result.errors = this.#message['_odac_form'] ? {_odac_form: this.#message['_odac_form']} : this.#message
    }
    return result
  }

  success(callback) {
    if (typeof callback === 'string') return this.result(callback)
    else return this.result(null, callback)
  }

  async #validate() {
    for (const method of Object.keys(this.#checklist)) {
      for (const key of Object.keys(this.#checklist[method])) {
        const checks = this.#checklist[method][key]
        let value

        if (method === 'VAR') {
          value = checks.customValue
        } else if (method === 'FILES') {
          value = this.#request.file ? await this.#request.file(key) : null
        } else {
          value = await this.#request.request(key, method)
        }

        for (const checkItem of checks) {
          if (this.#message[key]) break

          let error = false
          let rules = checkItem.rules

          if (typeof rules === 'boolean') {
            error = rules === false
          } else {
            for (const rule of rules.includes('|') ? rules.split('|') : [rules]) {
              let vars = rule.split(':')
              let ruleName = vars[0].trim()
              let inverse = ruleName.startsWith('!')
              if (inverse) ruleName = ruleName.substr(1)

              if (!error) {
                switch (ruleName) {
                  case 'required':
                    error = value === undefined || value === '' || value === null
                    break
                  case 'accepted':
                    error = !value || (value !== 1 && value !== '1' && value !== 'on' && value !== 'yes' && value !== true)
                    break
                  case 'numeric':
                    error = value && value !== '' && !this.#odac.Var(value).is('numeric')
                    break
                  case 'alpha':
                    error = value && value !== '' && !this.#odac.Var(value).is('alpha')
                    break
                  case 'alphaspace':
                    error = value && value !== '' && !this.#odac.Var(value).is('alphaspace')
                    break
                  case 'alphanumeric':
                    error = value && value !== '' && !this.#odac.Var(value).is('alphanumeric')
                    break
                  case 'alphanumericspace':
                    error = value && value !== '' && !this.#odac.Var(value).is('alphanumericspace')
                    break
                  case 'email':
                    error = value && value !== '' && !this.#odac.Var(value).is('email')
                    break
                  case 'ip':
                    error = value && value !== '' && !this.#odac.Var(value).is('ip')
                    break
                  case 'float':
                    error = value && value !== '' && !this.#odac.Var(value).is('float')
                    break
                  case 'mac':
                    error = value && value !== '' && !this.#odac.Var(value).is('mac')
                    break
                  case 'domain':
                    error = value && value !== '' && !this.#odac.Var(value).is('domain')
                    break
                  case 'url':
                    error = value && value !== '' && !this.#odac.Var(value).is('url')
                    break
                  case 'username':
                    error = value && value !== '' && !/^[a-zA-Z0-9]+$/.test(value)
                    break
                  case 'xss':
                    error = value && value !== '' && /<[^>]*>/g.test(value)
                    break
                  case 'usercheck':
                    error = !(await this.#odac.Auth.check())
                    break
                  case 'array':
                    error = value && !Array.isArray(value)
                    break
                  case 'date':
                    error = value && value !== '' && isNaN(Date.parse(value))
                    break
                  case 'min':
                    error = value && value !== '' && vars[1] && value < vars[1]
                    break
                  case 'max':
                    error = value && value !== '' && vars[1] && value > vars[1]
                    break
                  case 'len':
                    error = value && value !== '' && vars[1] && String(value).length !== parseInt(vars[1])
                    break
                  case 'minlen':
                    error = value && value !== '' && vars[1] && String(value).length < parseInt(vars[1])
                    break
                  case 'maxlen':
                    error = value && value !== '' && vars[1] && String(value).length > parseInt(vars[1])
                    break
                  case 'mindate':
                    error = value && value !== '' && vars[1] && new Date(value).getTime() < new Date(vars[1]).getTime()
                    break
                  case 'maxdate':
                    error = value && value !== '' && vars[1] && new Date(value).getTime() > new Date(vars[1]).getTime()
                    break
                  case 'same': {
                    const otherValue = await this.#request.request(vars[1], method)
                    error = value !== otherValue
                    break
                  }
                  case 'different': {
                    const otherValue = await this.#request.request(vars[1], method)
                    error = value === otherValue
                    break
                  }
                  case 'equal':
                    error = value && vars[1] && value !== vars[1]
                    break
                  case 'notin':
                    error = value && value !== '' && vars[1] && String(value).includes(vars[1])
                    break
                  case 'in':
                    error = value && value !== '' && vars[1] && !String(value).includes(vars[1])
                    break
                  case 'not':
                    error = value && vars[1] && value === vars[1]
                    break
                  case 'regex':
                    error = value && value !== '' && vars[1] && !new RegExp(vars[1]).test(value)
                    break
                  case 'user': {
                    if (!(await this.#odac.Auth.check())) {
                      error = true
                    } else {
                      const userData = this.#odac.Auth.user(vars[1])
                      if (this.#odac.Var(userData).is('hash')) {
                        error = !this.#odac.Var(userData).hashCheck(value)
                      } else {
                        error = value !== userData
                      }
                    }
                    break
                  }
                  case 'disposable':
                    error = value && value !== '' && !(await Validator.isDisposable(value))
                    break
                }
                if (inverse) error = !error
              }
            }
          }

          if (error) {
            this.#message[key] = checkItem.message
            break
          }
        }
      }
    }
    this.#completed = true
  }

  static async isDisposable(email) {
    if (!email || typeof email !== 'string') return false
    await loadDisposableDomains()
    const domain = email.split('@').pop().toLowerCase()
    return disposableDomains && disposableDomains.has(domain)
  }

  var(name, value = null) {
    if (this.#completed) this.#completed = false
    this.#method = 'VAR'
    this.#name = name
    if (!this.#checklist[this.#method]) this.#checklist[this.#method] = {}
    if (!this.#checklist[this.#method][name]) {
      this.#checklist[this.#method][name] = []
      this.#checklist[this.#method][name].customValue = value === null ? name : value
    }
    return this
  }

  file(name) {
    if (this.#completed) this.#completed = false
    this.#method = 'FILES'
    this.#name = name
    return this
  }

  async brute(maxAttempts = 5) {
    const ip = this.#request.ip
    const now = new Date().toISOString().slice(0, 13).replace(/[-:T]/g, '')
    const page = this.#request.url.split('?')[0]
    const storage = this.#odac.Storage
    const validation = storage.get('validation') || {}

    this.#name = '_odac_form'

    if (Object.keys(this.#message).length > 0) {
      if (!validation.brute) validation.brute = {}
      if (!validation.brute[now]) validation.brute[now] = {}
      if (!validation.brute[now][page]) validation.brute[now][page] = {}
      if (!validation.brute[now][page][ip]) validation.brute[now][page][ip] = 0

      validation.brute[now][page][ip]++

      if (validation.brute[now][page][ip] >= maxAttempts) {
        this.#message['_odac_form'] = this.#odac.Lang
          ? await this.#odac.Lang.get('Too many failed attempts. Please try again later.')
          : 'Too many failed attempts. Please try again later.'
      }
    }

    storage.put('validation', validation)
    return this
  }
}

module.exports = Validator
