'use strict'

const fsPromises = require('node:fs').promises
const path = require('node:path')
const Catalog = require('../Lang/Catalog.js')
const Extractor = require('../Lang/Extractor.js')
const Files = require('../Lang/Files.js')
const Runtime = require('../Lang/Runtime.js')

// Lists longer than this are shortened in the output.
const MAX_LISTED = 25

async function readConfig(root) {
  try {
    const parsed = JSON.parse(await fsPromises.readFile(path.join(root, 'odac.json'), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function byKey(a, b) {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1
  return a.context < b.context ? -1 : a.context > b.context ? 1 : 0
}

function label({key, context}) {
  return context ? `${JSON.stringify(key)} (context: ${JSON.stringify(context)})` : JSON.stringify(key)
}

function seenLabel(entry) {
  return `${label(entry)}  (last used ${entry.seen})`
}

function list(write, items, format = item => item) {
  for (const item of items.slice(0, MAX_LISTED)) write(`    ${format(item)}`)
  if (items.length > MAX_LISTED) write(`    … and ${items.length - MAX_LISTED} more`)
}

/**
 * Gathers what every `lang:*` command needs: the entries the code uses, the language files
 * and the entries they contain.
 * Entries no code uses are split in two: `unused`, and `seen`, those the runtime record
 * (Lang/Runtime.js) says the application looked up, e.g. keys built at runtime.
 * @param {string} root
 */
async function inspect(root) {
  const config = await readConfig(root)
  const dir = path.join(root, 'storage', 'language')
  const defaultLanguage = Catalog.defaultLanguage(config)
  const languages = [...(Catalog.configuredLanguages(config) ?? new Set([...(await Files.listLanguages(dir)), defaultLanguage]))].sort()

  const extracted = await Extractor.extract(root)
  const used = extracted.entries
  for (const key of Extractor.FRAMEWORK_KEYS) {
    const id = Catalog.entryId(key)
    if (!used.has(id)) used.set(id, {key, context: '', files: new Set(['(ODAC)']), frontend: false})
  }

  const files = new Map()
  for (const code of languages) files.set(code, await Files.readLanguage(dir, code))

  const keep = Extractor.keepMatcher(config)
  const inFiles = new Map()
  for (const {data} of files.values())
    for (const entry of Catalog.entries(data)) inFiles.set(Catalog.entryId(entry.key, entry.context), entry)

  const runtime = await Runtime.read(root)
  const unused = []
  const seen = []
  for (const [id, entry] of inFiles) {
    if (used.has(id) || keep(entry.key)) continue
    const recorded = runtime.get(id)
    if (recorded) seen.push({...entry, seen: recorded.seen})
    else unused.push(entry)
  }
  unused.sort(byKey)
  seen.sort(byKey)

  return {config, dir, defaultLanguage, languages, extracted, used, files, unused, seen}
}

function reportScanProblems(write, {extracted, files}) {
  const invalid = [...files.entries()].filter(([, file]) => !file.valid).map(([code]) => code)
  if (invalid.length > 0) {
    write(`\n❌ Not valid JSON (left untouched): ${invalid.map(code => `${code}.json`).join(', ')}`)
  }
  if (extracted.errors.length > 0) {
    write(`\n⚠️  ${extracted.errors.length} file(s) could not be scanned:`)
    list(write, extracted.errors, e => `${e.file}: ${e.message}`)
  }
  if (extracted.dynamic.length > 0) {
    write(`\n⚠️  ${extracted.dynamic.length} translation call(s) with a key that is not a string literal.`)
    write('    Their keys cannot be detected; list them in "lang.keep" in odac.json (prefixes end with *).')
    list(write, extracted.dynamic, d => `${d.file}${d.line ? `:${d.line}` : ''}  ${d.call}`)
  }
  return invalid.length
}

function reportSeen(write, seen, heading) {
  write(`\n${heading} ${seen.length} key(s) are not found in code but were used while the app ran (keys built at runtime?).`)
  write('    Add them to "lang.keep" in odac.json so every check knows they are used.')
  list(write, seen, seenLabel)
}

/**
 * `odac lang:sync`: adds every entry the code uses to every language file and brings all
 * files to the same sorted order. Never removes entries.
 */
async function sync(root, write) {
  const state = await inspect(root)
  const result = await Files.sync(state.dir, {
    languages: state.languages,
    defaultLanguage: state.defaultLanguage,
    add: [...state.used.values()]
  })
  const added = Object.entries(result.added).filter(([code]) => !result.invalid.includes(code))
  write(`✅ ${state.used.size} key(s) in use, ${state.languages.length} language(s): ${state.languages.join(', ')}`)
  for (const [code, count] of added) if (count > 0) write(`    ${code}.json: ${count} added`)
  if (result.written.length === 0 && result.invalid.length === 0) write('    All language files were already in sync.')
  const invalid = reportScanProblems(write, state)
  if (state.unused.length > 0) write(`\n💡 ${state.unused.length} unused key(s). Run "odac lang:prune" to review them.`)
  if (state.seen.length > 0) reportSeen(write, state.seen, '💡')
  return invalid > 0 ? 1 : 0
}

/**
 * `odac lang:check [--strict]`: reports entries missing from language files, unused
 * entries and untranslated entries. Exits with 1 when files are out of sync or contain
 * unused entries; with --strict also when translations are missing. Writes nothing.
 */
async function check(root, write, {strict}) {
  const state = await inspect(root)
  let failed = reportScanProblems(write, state) > 0

  const absent = []
  const untranslated = []
  for (const [code, {data, valid}] of state.files) {
    if (!valid) continue
    const missing = [...state.used.values()].filter(entry => !Catalog.has(data, entry.key, entry.context)).sort(byKey)
    if (missing.length > 0) absent.push({code, missing})
    if (code === state.defaultLanguage) continue
    const empty = Catalog.entries(data).filter(entry => Catalog.stored(data, entry.key, entry.context) === '')
    const notYetAdded = missing.length
    if (empty.length + notYetAdded > 0) untranslated.push({code, count: empty.length + notYetAdded, empty})
  }

  if (absent.length > 0) {
    failed = true
    write('\n❌ Keys used in code but missing from language files (run "odac lang:sync"):')
    for (const {code, missing} of absent) {
      write(`  ${code}.json: ${missing.length}`)
      list(write, missing, label)
    }
  }
  if (state.unused.length > 0) {
    failed = true
    write(`\n❌ ${state.unused.length} key(s) in language files are not used in code (run "odac lang:prune"):`)
    list(write, state.unused, label)
  }
  if (state.seen.length > 0) {
    // Still a failure: the runtime record is per developer, so CI cannot rely on it.
    failed = true
    reportSeen(write, state.seen, '❌')
  }
  if (untranslated.length > 0) {
    if (strict) failed = true
    write(`\n${strict ? '❌' : '⚠️ '} Missing translations:`)
    for (const {code, count, empty} of untranslated) {
      write(`  ${code}.json: ${count}`)
      list(write, empty, label)
    }
  }
  if (!failed && untranslated.length === 0)
    write(`✅ ${state.used.size} key(s), ${state.languages.join(', ')}: all in sync and translated.`)
  else if (!failed) write('\n✅ Language files are in sync.')
  return failed ? 1 : 0
}

/**
 * `odac lang:prune [--write] [--include-runtime]`: lists entries no code uses; removes them
 * from every language file only with --write.
 * Why: removal deletes translators' work, so it is never automatic and defaults to a dry run.
 * Entries the runtime record says were used (keys built at runtime) are listed apart and
 * kept unless --include-runtime is passed.
 */
async function prune(root, write, {apply, includeRuntime}) {
  const state = await inspect(root)
  const invalid = reportScanProblems(write, state)
  if (invalid > 0) {
    write('\n❌ Fix the invalid language files first; nothing was removed.')
    return 1
  }
  if (state.unused.length === 0 && state.seen.length === 0) {
    write('✅ No unused keys.')
    return 0
  }
  if (state.unused.length > 0) {
    write(`\n${state.unused.length} unused key(s):`)
    list(write, state.unused, label)
  }
  if (state.seen.length > 0) {
    write(`\n${state.seen.length} key(s) not found in code but used while the app ran (${includeRuntime ? 'included' : 'kept'}):`)
    list(write, state.seen, seenLabel)
    if (!includeRuntime) write('    Add them to "lang.keep", or pass --include-runtime to remove them too.')
  }
  if (state.extracted.dynamic.length > 0) {
    write('\n⚠️  Keys built at runtime are listed as unused unless they match "lang.keep" or the app used them in development.')
  }

  const remove = includeRuntime ? [...state.unused, ...state.seen] : state.unused
  if (remove.length === 0) {
    write('\nNothing to remove.')
    return 0
  }
  if (!apply) {
    write(
      `\nDry run: nothing was removed. Run "odac lang:prune --write${includeRuntime ? ' --include-runtime' : ''}" to remove them from every language file.`
    )
    return 0
  }
  const result = await Files.sync(state.dir, {
    languages: state.languages,
    defaultLanguage: state.defaultLanguage,
    remove
  })
  if (includeRuntime && state.seen.length > 0) await Runtime.forget(root, state.seen)
  write(`\n🗑️  Removed ${result.removed} key(s) from ${state.languages.join(', ')}.`)
  return 0
}

/**
 * Runs an `odac lang:*` command.
 * @param {string} command `lang:sync`, `lang:check` or `lang:prune`.
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.root=process.cwd()]
 * @param {(line: string) => void} [options.write] Output sink (stdout by default).
 * @returns {Promise<number>} The process exit code.
 */
async function run(command, args = [], {root = process.cwd(), write = line => process.stdout.write(`${line}\n`)} = {}) {
  if (command === 'lang:sync') return sync(root, write)
  if (command === 'lang:check') return check(root, write, {strict: args.includes('--strict')})
  if (command === 'lang:prune') {
    return prune(root, write, {apply: args.includes('--write'), includeRuntime: args.includes('--include-runtime')})
  }
  write(`Unknown command: ${command}`)
  return 1
}

module.exports = {run}
