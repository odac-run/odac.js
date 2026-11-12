'use strict'

const fsPromises = require('node:fs').promises
const path = require('node:path')
const Catalog = require('./Catalog.js')

/**
 * Reads one language file.
 * @param {string} dir The language directory.
 * @param {string} code Validated language code.
 * @returns {Promise<{data: object, raw: string|null, valid: boolean}>} raw is null when the
 *   file does not exist; valid is false when it exists but is not a JSON object.
 */
async function readLanguage(dir, code) {
  let raw
  try {
    raw = await fsPromises.readFile(path.join(dir, `${code}.json`), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return {data: Object.create(null), raw: null, valid: true}
    throw e
  }
  let valid
  try {
    const parsed = JSON.parse(raw)
    valid = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    valid = false
  }
  return {data: Catalog.parse(raw), raw, valid}
}

/**
 * Lists the language codes that have a file in a directory.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listLanguages(dir) {
  let names
  try {
    names = await fsPromises.readdir(dir)
  } catch {
    return []
  }
  return names
    .filter(name => name.endsWith('.json') && Catalog.isLanguageCode(name.slice(0, -5)))
    .map(name => name.slice(0, -5))
    .sort()
}

/**
 * Writes a file atomically: a reader or another worker never sees half a file.
 * @param {string} target
 * @param {string} content
 * @returns {Promise<void>}
 */
async function writeAtomic(target, content) {
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await fsPromises.writeFile(tmp, content)
    await fsPromises.rename(tmp, target)
  } catch (e) {
    await fsPromises.unlink(tmp).catch(() => {})
    throw e
  }
}

/**
 * Writes a language file atomically.
 * @param {string} dir
 * @param {string} code
 * @param {string} content
 * @returns {Promise<void>}
 */
function writeLanguage(dir, code, content) {
  return writeAtomic(path.join(dir, `${code}.json`), content)
}

/**
 * Brings every language file to the same set of entries, in the same order.
 * Why: keys used to be added only to the file of the language a request happened to be
 * served in, in whatever order workers saved them, so files drifted apart in size and
 * order and nobody could see which translations were missing. Every file now lists every
 * entry: the default language gets the key as its value, other languages get `""`
 * ("not translated yet"). Existing values are never changed.
 *
 * The entry set is the union of all files plus `add`, minus `remove`; removal is therefore
 * explicit (`odac lang:prune`), deleting a key from one file by hand does not remove it.
 * A file that is not valid JSON (e.g. saved mid-edit) is reported in `invalid` and left
 * untouched, so a sync never overwrites a translator's work with an empty file.
 *
 * @param {string} dir The language directory.
 * @param {object} options
 * @param {Iterable<string>} options.languages Language codes to keep in sync.
 * @param {string} options.defaultLanguage
 * @param {Iterable<{key: string, context: string}>} [options.add] Entries to add.
 * @param {Iterable<{key: string, context: string}>} [options.remove] Entries to remove.
 * @returns {Promise<{written: string[], invalid: string[], added: Object<string, number>, removed: number}>}
 */
async function sync(dir, {languages, defaultLanguage, add = [], remove = []}) {
  const codes = [...new Set(languages)].filter(Catalog.isLanguageCode).sort()
  const files = await Promise.all(codes.map(code => readLanguage(dir, code)))

  const union = new Map()
  for (const {data} of files) for (const entry of Catalog.entries(data)) union.set(Catalog.entryId(entry.key, entry.context), entry)
  for (const {key, context} of add) union.set(Catalog.entryId(key, context), {key, context})
  let removed = 0
  for (const {key, context} of remove) if (union.delete(Catalog.entryId(key, context))) removed++

  const written = []
  const invalid = codes.filter((code, i) => !files[i].valid)
  const added = {}
  await fsPromises.mkdir(dir, {recursive: true})
  await Promise.all(
    codes.map(async (code, i) => {
      const {data, raw, valid} = files[i]
      if (!valid) return
      let count = 0
      const next = Catalog.build(union.values(), (key, context) => {
        const value = Catalog.stored(data, key, context)
        if (value !== undefined) return value
        count++
        return code === defaultLanguage ? key : ''
      })
      added[code] = count
      const content = Catalog.serialize(next)
      if (content === raw) return
      await writeLanguage(dir, code, content)
      written.push(code)
    })
  )
  written.sort()
  return {written, invalid, added, removed}
}

module.exports = {listLanguages, readLanguage, sync, writeAtomic, writeLanguage}
