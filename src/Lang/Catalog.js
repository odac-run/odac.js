'use strict'

/**
 * Pure helpers for the language file format, shared by the runtime (Lang.js), the
 * extractor and the `odac lang:*` commands so all of them read, write and order entries
 * the same way.
 *
 * File format: a flat JSON object. A value is either a translation string, or, when the
 * same source text needs different translations depending on where it is used, an object
 * of context -> translation. The empty context `""` is the variant used without one.
 *
 *   { "Login": "Giriş Yap", "Gül": { "flower": "Rose", "verb": "Smile" } }
 *
 * An empty string means "known but not translated yet", so untranslated entries stay
 * distinguishable from translations that happen to equal their key.
 */

const LANGUAGE_CODE = /^[a-z]{2}$/
// A context is part of an entry's identity and becomes a JSON key; bounded so a template
// typo cannot produce unbounded keys.
const MAX_CONTEXT_LENGTH = 100

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

/**
 * Validates a language code.
 * Why: codes become filesystem paths; only two lowercase ASCII letters are ever accepted.
 * @param {*} code
 * @returns {boolean}
 */
function isLanguageCode(code) {
  return typeof code === 'string' && LANGUAGE_CODE.test(code)
}

/**
 * Resolves the configured default language.
 * Why: one rule for the runtime and the CLI; an invalid `lang.default` falls back to `en`.
 * @param {object} [config] The application config (`Odac.Config` or parsed odac.json).
 * @returns {string}
 */
function defaultLanguage(config) {
  const configured = String(config?.lang?.default ?? 'en').toLowerCase()
  return isLanguageCode(configured) ? configured : 'en'
}

/**
 * Returns the explicitly configured `lang.supported` list, or null when none is configured.
 * Why: an explicit list is a strict whitelist; without one, the language files on disk
 * decide. The default language is always included.
 * @param {object} [config]
 * @returns {Set<string>|null}
 */
function configuredLanguages(config) {
  const supported = config?.lang?.supported
  if (!Array.isArray(supported)) return null
  const codes = new Set([defaultLanguage(config)])
  for (const code of supported) {
    const lower = typeof code === 'string' ? code.toLowerCase() : code
    if (isLanguageCode(lower)) codes.add(lower)
  }
  return codes
}

/**
 * Normalizes a translation context.
 * Why: `undefined`, `null` and whitespace all mean "no context"; anything else is trimmed
 * and capped so it is a stable, bounded part of the entry's identity.
 * @param {*} context
 * @returns {string}
 */
function normalizeContext(context) {
  if (context === undefined || context === null) return ''
  return String(context).trim().slice(0, MAX_CONTEXT_LENGTH)
}

/**
 * Returns the translation stored for a key/context, or undefined when it is missing or empty.
 * @param {object} data Parsed language file.
 * @param {string} key
 * @param {string} [context='']
 * @returns {string|undefined}
 */
function lookup(data, key, context = '') {
  if (!data || !hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'string') return context === '' && value !== '' ? value : undefined
  if (value && typeof value === 'object' && hasOwn(value, context)) {
    const variant = value[context]
    return typeof variant === 'string' && variant !== '' ? variant : undefined
  }
  return undefined
}

/**
 * Tells whether a key/context has an entry, translated or not.
 * Why: an empty entry is known to the language file and must not be collected again.
 * @param {object} data
 * @param {string} key
 * @param {string} [context='']
 * @returns {boolean}
 */
function has(data, key, context = '') {
  if (!data || !hasOwn(data, key)) return false
  const value = data[key]
  if (typeof value === 'string') return context === ''
  return !!value && typeof value === 'object' && hasOwn(value, context)
}

/**
 * Returns the raw stored value for a key/context ('' when the entry exists but is untranslated
 * or malformed), or undefined when there is no entry.
 * @param {object} data
 * @param {string} key
 * @param {string} [context='']
 * @returns {string|undefined}
 */
function stored(data, key, context = '') {
  if (!has(data, key, context)) return undefined
  const value = typeof data[key] === 'string' ? data[key] : data[key][context]
  return typeof value === 'string' ? value : ''
}

/**
 * Adds a key/context entry when it is missing.
 * Why: a plain string entry gains its first context by turning into a context object that
 * keeps the original translation under `""`.
 * @param {object} data Null-prototype object, mutated in place.
 * @param {string} key
 * @param {string} context
 * @param {string} value
 * @returns {boolean} true when the data changed.
 */
function addEntry(data, key, context, value) {
  if (has(data, key, context)) return false
  const current = hasOwn(data, key) ? data[key] : undefined
  if (context === '') {
    if (current && typeof current === 'object') current[''] = value
    else data[key] = value
    return true
  }
  let variants
  if (current && typeof current === 'object') variants = current
  else {
    variants = Object.create(null)
    if (typeof current === 'string') variants[''] = current
    data[key] = variants
  }
  variants[context] = value
  return true
}

/**
 * Lists every key/context pair of a language file.
 * @param {object} data
 * @returns {Array<{key: string, context: string}>}
 */
function entries(data) {
  const list = []
  if (!data || typeof data !== 'object') return list
  for (const key of Object.keys(data)) {
    const value = data[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const context of Object.keys(value)) list.push({key, context})
    } else {
      list.push({key, context: ''})
    }
  }
  return list
}

/**
 * Builds the identity of a key/context pair, used as a Map key.
 * @param {string} key
 * @param {string} [context='']
 * @returns {string}
 */
function entryId(key, context = '') {
  return `${key}\u0000${context}`
}

/**
 * Builds a language file from a set of entries in a deterministic order.
 * Why: every language file lists the same entries in the same order, so files can be
 * compared side by side and diffs stay minimal no matter which worker wrote them. Keys are
 * sorted by code unit; inside a context object the no-context variant comes first.
 * @param {Iterable<{key: string, context: string}>} list Entries to include.
 * @param {(key: string, context: string) => string} valueFor Value for each entry.
 * @returns {object} Null-prototype object ready for serialize().
 */
function build(list, valueFor) {
  const grouped = new Map()
  for (const {key, context} of list) {
    let contexts = grouped.get(key)
    if (!contexts) grouped.set(key, (contexts = new Set()))
    contexts.add(context)
  }
  const data = Object.create(null)
  for (const key of [...grouped.keys()].sort()) {
    const contexts = [...grouped.get(key)].sort()
    if (contexts.length === 1 && contexts[0] === '') {
      data[key] = valueFor(key, '')
      continue
    }
    const variants = Object.create(null)
    for (const context of contexts) variants[context] = valueFor(key, context)
    data[key] = variants
  }
  return data
}

/**
 * Serializes a language file.
 * @param {object} data
 * @returns {string}
 */
function serialize(data) {
  return `${JSON.stringify(data, null, 4)}\n`
}

/**
 * Parses a language file, accepting only a JSON object.
 * @param {string} raw
 * @returns {object} Null-prototype object; empty when the content is not a JSON object.
 */
function parse(raw) {
  const data = Object.create(null)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return data
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return data
  for (const key of Object.keys(parsed)) {
    const value = parsed[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const variants = Object.create(null)
      for (const context of Object.keys(value)) variants[context] = typeof value[context] === 'string' ? value[context] : ''
      data[key] = variants
    } else {
      data[key] = typeof value === 'string' ? value : ''
    }
  }
  return data
}

/**
 * Replaces `%s` (sequential) or `%s1`, `%s2` (numbered) placeholders.
 * Why: a single pass, so an argument value containing `%s2` or `$&` is inserted literally and
 * never expanded again; `%s1` does not match the start of `%s10`.
 * @param {string} str
 * @param {Array<*>} args
 * @returns {string}
 */
function format(str, args) {
  if (args.length === 0) return str
  if (/%s\d/.test(str)) {
    return str.replace(/%s(\d+)/g, (match, index) => (index > 0 && index <= args.length ? String(args[index - 1]) : match))
  }
  let next = 0
  return str.replace(/%s/g, match => (next < args.length ? String(args[next++]) : match))
}

module.exports = {
  addEntry,
  build,
  configuredLanguages,
  defaultLanguage,
  entries,
  entryId,
  format,
  has,
  isLanguageCode,
  lookup,
  normalizeContext,
  parse,
  serialize,
  stored
}
