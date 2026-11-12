'use strict'

const fsPromises = require('node:fs').promises
const path = require('node:path')
const Catalog = require('./Catalog.js')
const Files = require('./Files.js')

/**
 * Record of the translation entries the application looked up while it ran.
 * Why: a key built at runtime (`__(`status.${code}`)`) cannot be found in the source, so
 * `odac lang:prune` would take it for unused and delete its translations. While key
 * collection is on (debug mode by default), every entry looked up is recorded with the day
 * it was last used, and prune keeps the recorded entries unless asked otherwise.
 *
 * The record is kept in storage/.cache/, which git ignores: it reflects what one
 * developer's runs exercised, and its dates would change a tracked file every day. It has
 * the language file layout, with the last-used day (YYYY-MM-DD, UTC) as each value.
 */

const FILE = path.join('storage', '.cache', 'lang-runtime.json')
const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * @param {string} root Project directory.
 * @returns {string} Path of the record.
 */
function file(root) {
  return path.join(root, FILE)
}

/** @returns {string} The current UTC day, the record's resolution. */
function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Reads the record.
 * @param {string} root
 * @returns {Promise<Map<string, {key: string, context: string, seen: string}>>} By entry id;
 *   empty when there is no record or it is not valid JSON.
 */
async function read(root) {
  const recorded = new Map()
  let raw
  try {
    raw = await fsPromises.readFile(file(root), 'utf8')
  } catch {
    return recorded
  }
  const data = Catalog.parse(raw)
  for (const {key, context} of Catalog.entries(data)) {
    const seen = Catalog.stored(data, key, context)
    if (DAY.test(seen)) recorded.set(Catalog.entryId(key, context), {key, context, seen})
  }
  return recorded
}

async function write(root, recorded) {
  const data = Catalog.build(recorded.values(), (key, context) => recorded.get(Catalog.entryId(key, context)).seen)
  await fsPromises.mkdir(path.dirname(file(root)), {recursive: true})
  await Files.writeAtomic(file(root), Catalog.serialize(data))
}

/**
 * Adds entries to the record, keeping the later day of an entry recorded before.
 * Merged with the file's current content, so workers and restarts add to it.
 * @param {string} root
 * @param {Iterable<{key: string, context: string, seen: string}>} items
 * @returns {Promise<void>}
 */
async function record(root, items) {
  const recorded = await read(root)
  for (const item of items) {
    const id = Catalog.entryId(item.key, item.context)
    const previous = recorded.get(id)
    if (!previous || previous.seen < item.seen) recorded.set(id, {key: item.key, context: item.context, seen: item.seen})
  }
  await write(root, recorded)
}

/**
 * Removes entries from the record, after `odac lang:prune` removed them from the language
 * files.
 * @param {string} root
 * @param {Iterable<{key: string, context: string}>} items
 * @returns {Promise<void>}
 */
async function forget(root, items) {
  const recorded = await read(root)
  let changed = false
  for (const {key, context} of items) if (recorded.delete(Catalog.entryId(key, context))) changed = true
  if (changed) await write(root, recorded)
}

module.exports = {FILE, file, forget, read, record, today}
