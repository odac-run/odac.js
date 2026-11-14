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

// A BCP 47 subset in canonical case: language[-Script][-REGION], e.g. `tr`, `pt-BR`,
// `zh-Hant`, `zh-Hant-TW`, `es-419`. Variants, extensions and private-use subtags are not
// accepted: a code is a file name, so it only ever holds ASCII letters, digits and `-`.
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/
// The same shape in any case, with `-` or `_` between subtags (`pt_br`, `ZH-hant`).
const LANGUAGE_TAG = /^([a-z]{2,3})(?:[-_]([a-z]{4}))?(?:[-_]([a-z]{2}|\d{3}))?$/i
// Longest code LANGUAGE_CODE accepts (`zho-Hant-419`); longer input is rejected unparsed.
const MAX_LANGUAGE_CODE_LENGTH = 12
// A context is part of an entry's identity and becomes a JSON key; bounded so a template
// typo cannot produce unbounded keys.
const MAX_CONTEXT_LENGTH = 100
// Languages written right to left when no script subtag says otherwise.
const RTL_LANGUAGES = new Set(['ar', 'ckb', 'dv', 'fa', 'he', 'ps', 'sd', 'syr', 'ug', 'ur', 'yi'])
// ISO 15924 scripts written right to left; a script subtag decides over the language
// (`pa-Arab` is right to left, `uz-Latn` left to right).
const RTL_SCRIPTS = new Set(['Adlm', 'Arab', 'Hebr', 'Mand', 'Nkoo', 'Rohg', 'Syrc', 'Thaa'])
// Likely-subtag expansions memoized by language matching; candidates come from
// Accept-Language, so the cache is bounded.
const MAX_LIKELY_CACHE = 1000
const likelyCache = new Map()

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

/**
 * Validates a language code in canonical form.
 * Why: codes become filesystem paths; only `language[-Script][-REGION]` in canonical case
 * is ever accepted, so one language always maps to exactly one file name.
 * @param {*} code
 * @returns {boolean}
 */
function isLanguageCode(code) {
  return typeof code === 'string' && LANGUAGE_CODE.test(code)
}

/**
 * Converts a language tag to its canonical code, or returns null when it is not one.
 * Why: URLs, sessions, user records and config spell tags in any case (`pt-br`, `PT_BR`);
 * file names, `<html lang>` and comparisons need one spelling (`pt-BR`).
 * @param {*} tag
 * @returns {string|null}
 */
function normalizeLanguage(tag) {
  if (typeof tag !== 'string' || tag.length > MAX_LANGUAGE_CODE_LENGTH) return null
  const match = LANGUAGE_TAG.exec(tag)
  if (!match) return null
  const [, language, script, region] = match
  let code = language.toLowerCase()
  if (script) code += `-${script[0].toUpperCase()}${script.slice(1).toLowerCase()}`
  if (region) code += `-${region.toUpperCase()}`
  return code
}

/**
 * Returns the more general codes a code falls back to, most specific first:
 * `zh-Hant-TW` -> `['zh-Hant', 'zh']`, `pt-BR` -> `['pt']`, `tr` -> `[]`.
 * Why: a regional file holds only what differs from its language; everything else is served
 * from the more general file (RFC 4647 lookup).
 * @param {string} code Canonical code.
 * @returns {string[]}
 */
function parentLanguages(code) {
  const parents = []
  for (let i = code.lastIndexOf('-'); i > 0; i = code.lastIndexOf('-', i - 1)) parents.push(code.slice(0, i))
  return parents
}

// The codes a candidate likely means once its implied script and region are added
// (`zh-TW` -> `zh-Hant-TW`, `zh-Hant`; `pt` -> `pt-Latn-BR`, `pt-Latn`, `pt-BR`), so a
// browser's `zh-TW` finds `zh-Hant` and a bare `en` prefers `en-US` over `en-GB`.
function likelyLanguages(code) {
  let likely = likelyCache.get(code)
  if (likely) return likely
  likely = []
  try {
    const {language, script, region} = new Intl.Locale(code).maximize()
    const forms = script && region ? [`${language}-${script}-${region}`, `${language}-${script}`, `${language}-${region}`] : []
    for (const candidate of forms) {
      const normalized = normalizeLanguage(candidate)
      if (normalized && normalized !== code && !likely.includes(normalized)) likely.push(normalized)
    }
  } catch {
    // An ICU build without likely-subtag data: exact and parent matching still apply.
  }
  if (likelyCache.size >= MAX_LIKELY_CACHE) likelyCache.clear()
  likelyCache.set(code, likely)
  return likely
}

/**
 * Picks the supported language that best serves a list of requested codes.
 * Why: requests name languages more or less specifically than the files an application has
 * (`tr-TR` for `tr.json`, `zh-TW` for `zh-Hant.json`, `pt` for `pt-BR.json`). Candidates are
 * tried in order of preference; for each one: the exact code, its parents, its likely
 * script/region forms, then the first supported code that specializes it. A less preferred
 * candidate never wins over a usable match for a more preferred one.
 * @param {Iterable<string>} candidates Canonical codes, most preferred first.
 * @param {Set<string>} supported
 * @returns {string|null}
 */
function matchLanguage(candidates, supported) {
  for (const code of candidates) {
    if (supported.has(code)) return code
    for (const parent of parentLanguages(code)) if (supported.has(parent)) return parent
    for (const likely of likelyLanguages(code)) if (supported.has(likely)) return likely
    const prefix = `${code}-`
    let specific = null
    for (const option of supported) if (option.startsWith(prefix) && (specific === null || option < specific)) specific = option
    if (specific) return specific
  }
  return null
}

/**
 * Returns the writing direction of a language.
 * Why: `<html dir>` has to follow the served language, or an Arabic or Hebrew page renders
 * left to right. A script subtag decides over the language.
 * @param {string} code Canonical code.
 * @returns {'ltr'|'rtl'}
 */
function direction(code) {
  if (typeof code !== 'string') return 'ltr'
  const [language, second] = code.split('-', 2)
  if (second?.length === 4) return RTL_SCRIPTS.has(second) ? 'rtl' : 'ltr'
  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr'
}

/**
 * Resolves the configured default language.
 * Why: one rule for the runtime and the CLI; an invalid `lang.default` falls back to `en`.
 * @param {object} [config] The application config (`Odac.Config` or parsed odac.json).
 * @returns {string}
 */
function defaultLanguage(config) {
  return normalizeLanguage(String(config?.lang?.default ?? 'en')) ?? 'en'
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
    const normalized = normalizeLanguage(code)
    if (normalized) codes.add(normalized)
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
  direction,
  entries,
  entryId,
  format,
  has,
  isLanguageCode,
  lookup,
  matchLanguage,
  normalizeContext,
  normalizeLanguage,
  parentLanguages,
  parse,
  serialize,
  stored
}
