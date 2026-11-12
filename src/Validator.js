const https = require('https')
const fs = require('fs')
const fsPromises = fs.promises
const path = require('path')

const MIME_TYPES = require('./Route/MimeTypes.js')

const CACHE_FILE = path.join(global.__dir || process.cwd(), 'storage', '.cache', 'odac_disposable_domains.conf')
const SOURCE_URL = 'https://hub.odac.run/blocklist/disposable-emails'
const LIST_MAX_AGE = 24 * 60 * 60 * 1000
const LIST_RETRY_AFTER = 5 * 60 * 1000
const FETCH_TIMEOUT = 5000

// Types a browser executes when the file is opened from the site. A wildcard such as image/*
// must not admit them; an allowlist that wants them names them explicitly.
const ACTIVE_TYPES = new Set(['image/svg+xml', 'text/html', 'text/javascript', 'application/xhtml+xml', 'application/xml'])

const startsWith = bytes => buf => buf.subarray(0, bytes.length).equals(Buffer.from(bytes))
const zip = startsWith([0x50, 0x4b, 0x03, 0x04])
const SIGNATURES = {
  jpg: startsWith([0xff, 0xd8, 0xff]),
  jpeg: startsWith([0xff, 0xd8, 0xff]),
  png: startsWith([0x89, 0x50, 0x4e, 0x47]),
  gif: startsWith([0x47, 0x49, 0x46, 0x38]),
  // RIFF container + "WEBP" fourCC at offset 8 (distinguishes it from AVI/WAV).
  webp: buf => buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP',
  pdf: startsWith([0x25, 0x50, 0x44, 0x46, 0x2d]),
  zip,
  docx: zip,
  xlsx: zip,
  pptx: zip
}

function extensionMime(ext) {
  const type = (ext && Object.hasOwn(MIME_TYPES, ext) && MIME_TYPES[ext]) || 'application/octet-stream'
  return type.split(';')[0].trim()
}

// The list in use, when it was loaded, and the load in flight. Callers share one load: the
// set used to be published empty before loading finished, so every check made meanwhile
// treated disposable addresses as allowed.
let disposableDomains = null
let disposableLoadedAt = 0
let disposableLoading = null

async function readCachedList() {
  const handle = await fsPromises.open(CACHE_FILE, 'r')
  try {
    const stats = await handle.stat()
    return {content: await handle.readFile('utf8'), fresh: Date.now() - stats.mtimeMs < LIST_MAX_AGE}
  } finally {
    await handle.close()
  }
}

function fetchList() {
  return new Promise((resolve, reject) => {
    const req = https.get(SOURCE_URL, {timeout: FETCH_TIMEOUT}, res => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`Failed to fetch: ${res.statusCode}`))
        return
      }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('Timed out fetching the disposable domain list')))
    req.on('error', reject)
  })
}

async function writeCachedList(content) {
  const tempFile = `${CACHE_FILE}_${Date.now()}_${Math.random().toString(36).slice(2)}`
  await fsPromises.mkdir(path.dirname(CACHE_FILE), {recursive: true})
  const handle = await fsPromises.open(tempFile, 'wx', 0o600)
  try {
    await handle.write(content)
  } finally {
    await handle.close()
  }
  await fsPromises.rename(tempFile, CACHE_FILE)
}

function parseList(content) {
  const domains = new Set()
  for (const line of content.split('\n')) {
    const domain = line.trim().toLowerCase()
    if (domain && !domain.startsWith('#')) domains.add(domain)
  }
  return domains
}

async function loadDisposableDomains() {
  let cached = null
  try {
    cached = await readCachedList()
  } catch {
    // No cache yet.
  }
  if (cached?.fresh) return {domains: parseList(cached.content), complete: true}

  try {
    // SECURITY NOTE: Supply Chain Attack Mitigation
    // The fetched list is restricted to alphanumerics, dots, hyphens and newlines before it
    // is written to disk, neutralising any payload even if hub.odac.run is compromised.
    const content = (await fetchList()).replace(/[^a-zA-Z0-9.\-\n\r]/g, '')
    await writeCachedList(content).catch(() => {})
    return {domains: parseList(content), complete: true}
  } catch (error) {
    // A stale cache beats no list; retry the download soon either way.
    if (cached) return {domains: parseList(cached.content), complete: false}
    throw error
  }
}

/**
 * Returns the disposable-domain list, loading or refreshing it as needed.
 *
 * Why: the first check waits for the list instead of passing every address; afterwards a
 * stale list keeps serving while one shared refresh runs, so the list follows the daily
 * upstream updates without blocking requests.
 *
 * @returns {Promise<Set<string>>}
 */
async function getDisposableDomains() {
  const age = Date.now() - disposableLoadedAt
  if (disposableDomains && age < LIST_MAX_AGE) return disposableDomains
  if (!disposableLoading) {
    disposableLoading = loadDisposableDomains()
      .then(({domains, complete}) => {
        disposableDomains = domains
        disposableLoadedAt = complete ? Date.now() : Date.now() - LIST_MAX_AGE + LIST_RETRY_AFTER
      })
      .catch(error => {
        console.error(
          JSON.stringify({level: 'error', tag: 'ODAC Validator', message: 'Could not load disposable domains.', error: error.message})
        )
        disposableDomains ??= new Set()
        disposableLoadedAt = Date.now() - LIST_MAX_AGE + LIST_RETRY_AFTER
      })
      .finally(() => {
        disposableLoading = null
      })
  }
  if (!disposableDomains) await disposableLoading
  return disposableDomains
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

          // Normalize file value to array
          let files = []
          if (method === 'FILES') {
            if (Array.isArray(value)) {
              files = value
            } else if (value) {
              files = [value]
            }
            // Implicit server-limit guard: truncated files always fail
            if (files.some(f => f.truncated)) {
              error = true
              this.#message[key] = checkItem.message
              continue
            }
          }

          // Format rules apply to present values only, and only to scalars: `value && ...`
          // skipped 0 and false (`{"qty": 0}` passed `min:1`), and an array or object coerces to
          // a string that can match (`["a@b.co"]` passed `email`) and then reach the database.
          const empty = value === undefined || value === null || value === ''
          const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          const text = scalar ? String(value) : ''
          const invalid = test => !empty && (!scalar || !test(text))
          const number = scalar ? parseFloat(text) : NaN

          if (typeof rules === 'boolean') {
            error = rules === false
          } else {
            for (const rule of rules.includes('|') ? rules.split('|') : [rules]) {
              let vars = rule.split(/:(.+)/)
              let ruleName = vars[0].trim()
              let inverse = ruleName.startsWith('!')
              if (inverse) ruleName = ruleName.slice(1)
              const arg = vars[1]
              const hasArg = arg !== undefined && arg !== ''

              if (!error) {
                switch (ruleName) {
                  case 'required':
                    if (method === 'FILES') {
                      error = files.length === 0
                    } else {
                      error = empty
                    }
                    break
                  case 'accepted':
                    error = !value || (value !== 1 && value !== '1' && value !== 'on' && value !== 'yes' && value !== true)
                    break
                  case 'numeric':
                  case 'alpha':
                  case 'alphaspace':
                  case 'alphanumeric':
                  case 'alphanumericspace':
                  case 'email':
                  case 'ip':
                  case 'float':
                  case 'mac':
                  case 'domain':
                  case 'url':
                  case 'username':
                    error = invalid(v => this.#odac.Var(v).is(ruleName))
                    break
                  case 'xss':
                    error = invalid(v => !/<[^>]*>/.test(v))
                    break
                  case 'usercheck':
                    error = !(await this.#odac.Auth.check())
                    break
                  case 'array':
                    error = !empty && !Array.isArray(value)
                    break
                  case 'date':
                    error = invalid(v => !isNaN(Date.parse(v)))
                    break
                  case 'min':
                    // A value that is not a number cannot be at least X.
                    error = hasArg && !empty && (!Number.isFinite(number) || number < parseFloat(arg))
                    break
                  case 'max':
                    error = hasArg && !empty && (!Number.isFinite(number) || number > parseFloat(arg))
                    break
                  case 'len':
                    error = hasArg && invalid(v => v.length === parseInt(arg))
                    break
                  case 'minlen':
                    error = hasArg && invalid(v => v.length >= parseInt(arg))
                    break
                  case 'maxlen':
                    error = hasArg && invalid(v => v.length <= parseInt(arg))
                    break
                  case 'mindate':
                    error = hasArg && invalid(v => !(new Date(v).getTime() < new Date(arg).getTime()))
                    break
                  case 'maxdate':
                    error = hasArg && invalid(v => !(new Date(v).getTime() > new Date(arg).getTime()))
                    break
                  case 'same': {
                    const otherValue = await this.#request.request(arg, method)
                    error = value !== otherValue
                    break
                  }
                  case 'different': {
                    const otherValue = await this.#request.request(arg, method)
                    error = value === otherValue
                    break
                  }
                  case 'equal':
                    error = hasArg && invalid(v => v === arg)
                    break
                  case 'notin':
                    error = hasArg && invalid(v => !v.includes(arg))
                    break
                  case 'in':
                    error = hasArg && invalid(v => v.includes(arg))
                    break
                  case 'not':
                    error = hasArg && !empty && scalar && text === arg
                    break
                  case 'regex':
                    error = hasArg && invalid(v => new RegExp(arg).test(v))
                    break
                  case 'user': {
                    if (!(await this.#odac.Auth.check())) {
                      error = true
                    } else {
                      const userData = this.#odac.Auth.user(arg)
                      if (this.#odac.Var(userData).is('hash')) {
                        error = !scalar || !(await this.#odac.Var(userData).hashCheckAsync(text))
                      } else {
                        error = value !== userData
                      }
                    }
                    break
                  }
                  case 'disposable':
                    error = !empty && (!scalar || !(await Validator.isDisposable(text)))
                    break
                  case 'maxsize':
                    if (method === 'FILES' && hasArg) {
                      const maxBytes = this.#parseSize(arg)
                      error = files.some(f => f.size > maxBytes)
                    }
                    break
                  case 'minsize':
                    if (method === 'FILES' && hasArg) {
                      const minBytes = this.#parseSize(arg)
                      error = files.some(f => f.size < minBytes)
                    }
                    break
                  case 'mimetype':
                  case 'accept':
                    if (method === 'FILES' && hasArg && files.length > 0) {
                      error = !(await this.#validateMimetype(files, arg))
                    }
                    break
                  case 'ext':
                    if (method === 'FILES' && hasArg && files.length > 0) {
                      const allowedExts = arg.split(',').map(e => e.trim().toLowerCase())
                      error = !files.every(f => allowedExts.includes(f.ext))
                    }
                    break
                  case 'maxfiles':
                    if (method === 'FILES' && hasArg) {
                      error = files.length > parseInt(arg)
                    }
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

  #parseSize(sizeStr) {
    const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i)
    if (!match) return 0
    let bytes = parseFloat(match[1])
    const unit = (match[2] || 'B').toUpperCase()
    const multipliers = {B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024}
    return Math.floor(bytes * (multipliers[unit] || 1))
  }

  /**
   * Checks uploaded files against a MIME allowlist.
   *
   * Why: the type is derived from the file extension, which decides how the file is stored
   * and later served. The client-declared MIME type is ignored: accepting either the declared
   * type or the extension let `evil.html` sent as `image/png` pass `image/*`. Wildcards never
   * match script-capable types (SVG, HTML, XML, JavaScript); list them explicitly to allow
   * them. Formats with a known signature must also match it byte for byte.
   *
   * @param {object[]} files Uploaded file objects.
   * @param {string} mimeStr Comma-separated allowlist, e.g. `image/png,image/*`.
   * @returns {Promise<boolean>}
   */
  async #validateMimetype(files, mimeStr) {
    const allowedTypes = mimeStr.split(',').map(m => m.trim().toLowerCase())
    for (const file of files) {
      const mime = extensionMime(file.ext)
      const allowed = allowedTypes.some(type => {
        if (type === mime) return true
        if (!type.endsWith('/*') || ACTIVE_TYPES.has(mime)) return false
        return mime.startsWith(type.slice(0, -1))
      })
      if (!allowed) return false
      if (file.path && (await this.#matchesSignature(file.path, file.ext)) === false) return false
    }
    return true
  }

  // true when the leading bytes match the extension's signature, false when they do not,
  // null when the extension has no signature (the extension check alone applies).
  async #matchesSignature(filePath, ext) {
    const signature = SIGNATURES[ext]
    if (!signature) return null

    const buf = Buffer.alloc(12)
    let handle
    try {
      handle = await fsPromises.open(filePath, 'r')
      await handle.read(buf, 0, buf.length, 0)
    } catch {
      return null // unreadable: don't fail validation on a sniff error
    } finally {
      if (handle) await handle.close().catch(() => {})
    }
    return signature(buf)
  }

  /**
   * Whether an email address belongs to a disposable-mail provider.
   *
   * Why: backs the `disposable` rule; exposed for checks outside a form.
   *
   * @param {string} email
   * @returns {Promise<boolean>}
   */
  static async isDisposable(email) {
    if (!email || typeof email !== 'string') return false
    const domains = await getDisposableDomains()
    return domains.has(email.split('@').pop().toLowerCase())
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

  /**
   * Limits failed submissions of this form per client IP.
   * Why: forms that check secrets need a ceiling on guesses. Each submission that fails
   * validation counts; once `maxAttempts` is reached every submission from that IP to this
   * page is rejected, valid or not, until the window (`windowSeconds`, starting at the first
   * failure) expires. Counters carry a TTL, so idle clients leave nothing behind.
   * @param {number} [maxAttempts=5]
   * @param {number} [windowSeconds=3600]
   * @returns {Promise<Validator>}
   */
  async brute(maxAttempts = 5, windowSeconds = 3600) {
    this.#name = '_odac_form'

    const ipc = this.#odac.Ipc
    if (!ipc) return this

    // brute() may be called before error(); the outcome of this submission must be known.
    if (!this.#completed) await this.#validate()

    const page = this.#request.url.split('?')[0]
    const key = `brute:${page}:${this.#request.ip}`
    const failed = Object.keys(this.#message).length > 0
    // Ipc.incrBy is atomic across workers, so concurrent failures cannot be lost.
    const count = failed ? await ipc.incrBy(key, 1, windowSeconds) : Number((await ipc.get(key)) ?? 0)

    if (count >= maxAttempts) {
      this.#message['_odac_form'] = this.#odac.Lang
        ? await this.#odac.Lang.get('Too many failed attempts. Please try again later.')
        : 'Too many failed attempts. Please try again later.'
    }

    return this
  }
}

module.exports = Validator
