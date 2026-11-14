const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const CliLang = require('../../../src/Cli/Lang')
const Runtime = require('../../../src/Lang/Runtime')

describe('odac lang:* commands', () => {
  let root
  let output

  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true})
    fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content))
  }
  const readLang = code => JSON.parse(fs.readFileSync(path.join(root, 'lang', `${code}.json`), 'utf8'))
  const run = (command, ...args) => CliLang.run(command, args, {root, write: line => output.push(line)})
  const text = () => output.join('\n')

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-cli-lang-'))
    output = []
    write('odac.json', {lang: {default: 'en', keep: ['status.*']}})
    write('view/content/home.html', '<odac translate>Hello</odac><odac translate context="verb">Gül</odac>')
    write('controller/home.js', "Odac.__('Saved'); Odac.__(`status.${code}`)")
    write('lang/en.json', {Hello: 'Hello', Old: 'Old', 'status.ok': 'OK'})
    write('lang/tr.json', {Hello: 'Merhaba'})
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  describe('lang:sync', () => {
    it('adds every used key to every language file without removing any', async () => {
      expect(await run('lang:sync')).toBe(0)
      const framework = 'Too many failed attempts. Please try again later.'
      expect(readLang('en')).toEqual({
        Gül: {verb: 'Gül'},
        Hello: 'Hello',
        Old: 'Old',
        Saved: 'Saved',
        'status.ok': 'OK',
        [framework]: framework
      })
      expect(readLang('tr')).toEqual({Gül: {verb: ''}, Hello: 'Merhaba', Old: '', Saved: '', 'status.ok': '', [framework]: ''})
      expect(text()).toContain('1 unused key(s)')
      expect(text()).toContain('`status.${code}`')
    })

    it('fails without touching a language file that is not valid JSON', async () => {
      write('lang/tr.json', '{"Hello": ')
      expect(await run('lang:sync')).toBe(1)
      expect(fs.readFileSync(path.join(root, 'lang/tr.json'), 'utf8')).toBe('{"Hello": ')
      expect(text()).toContain('tr.json')
    })

    it('creates the files of the languages in lang.supported', async () => {
      write('odac.json', {lang: {supported: ['de']}})
      await run('lang:sync')
      expect(readLang('de').Hello).toBe('')
    })
  })

  describe('lang:check', () => {
    it('fails when keys are missing from files or unused, and writes nothing', async () => {
      const before = fs.readFileSync(path.join(root, 'lang/en.json'), 'utf8')
      expect(await run('lang:check')).toBe(1)
      expect(text()).toContain('missing from language files')
      expect(text()).toContain('"Gül" (context: "verb")')
      expect(text()).toMatch(/1 key\(s\) in language files are not used[\s\S]*"Old"/)
      expect(fs.readFileSync(path.join(root, 'lang/en.json'), 'utf8')).toBe(before)
    })

    it('passes once files are synced and pruned, failing on missing translations only with --strict', async () => {
      await run('lang:sync')
      await run('lang:prune', '--write')
      output = []
      expect(await run('lang:check')).toBe(0)
      expect(text()).toContain('Missing translations')
      expect(text()).toContain('"Saved"')
      expect(await run('lang:check', '--strict')).toBe(1)
    })

    it('passes --strict when everything is translated', async () => {
      write('controller/home.js', "Odac.__('Hello')")
      write('view/content/home.html', '')
      const framework = 'Too many failed attempts. Please try again later.'
      write('lang/en.json', {Hello: 'Hello', [framework]: framework})
      write('lang/tr.json', {Hello: 'Merhaba', [framework]: 'Çok fazla deneme.'})
      expect(await run('lang:check', '--strict')).toBe(0)
      expect(text()).toContain('all in sync and translated')
    })
  })

  describe('lang:prune', () => {
    it('lists unused keys without removing them by default', async () => {
      expect(await run('lang:prune')).toBe(0)
      expect(text()).toContain('"Old"')
      expect(text()).not.toContain('"status.ok"')
      expect(text()).toContain('Dry run')
      expect(readLang('en').Old).toBe('Old')
    })

    it('removes unused keys from every language file with --write', async () => {
      write('lang/tr.json', {Hello: 'Merhaba', Old: 'Eski'})
      expect(await run('lang:prune', '--write')).toBe(0)
      expect(readLang('en').Old).toBeUndefined()
      expect(readLang('tr').Old).toBeUndefined()
      expect(readLang('en')['status.ok']).toBe('OK')
      expect(readLang('tr').Hello).toBe('Merhaba')
    })

    it('removes only the unused context of a key', async () => {
      write('lang/en.json', {Gül: {verb: 'Smile', flower: 'Rose'}})
      await run('lang:prune', '--write')
      expect(readLang('en').Gül).toEqual({verb: 'Smile'})
    })

    it('refuses to prune while a language file is invalid', async () => {
      write('lang/tr.json', 'nope')
      expect(await run('lang:prune', '--write')).toBe(1)
      expect(readLang('en').Old).toBe('Old')
    })

    it('says so when there is nothing to prune', async () => {
      write('lang/en.json', {Hello: 'Hello'})
      write('lang/tr.json', {})
      expect(await run('lang:prune')).toBe(0)
      expect(text()).toContain('No unused keys')
    })
  })

  describe('keys the app used at runtime', () => {
    // "Old" is in no source file, but the app looked it up (e.g. a key built at runtime).
    beforeEach(async () => {
      await Runtime.record(root, [{key: 'Old', context: '', seen: '2026-11-10'}])
      write('lang/tr.json', {Hello: 'Merhaba', Old: 'Eski', Gone: 'Gitti'})
    })

    it('are kept by prune --write and listed apart', async () => {
      expect(await run('lang:prune', '--write')).toBe(0)
      expect(readLang('tr').Old).toBe('Eski')
      expect(readLang('tr').Gone).toBeUndefined()
      expect(text()).toMatch(/1 unused key\(s\):\n {4}"Gone"/)
      expect(text()).toContain('used while the app ran (kept)')
      expect(text()).toContain('"Old"  (last used 2026-11-10)')
      expect(text()).toContain('--include-runtime')
    })

    it('are removed, along with their record, only with --include-runtime', async () => {
      expect(await run('lang:prune', '--include-runtime')).toBe(0)
      expect(readLang('tr').Old).toBe('Eski')
      expect(text()).toContain('lang:prune --write --include-runtime')

      expect(await run('lang:prune', '--write', '--include-runtime')).toBe(0)
      expect(readLang('en').Old).toBeUndefined()
      expect(readLang('tr').Old).toBeUndefined()
      expect((await Runtime.read(root)).size).toBe(0)
    })

    it('leave nothing to remove when they are the only unused keys', async () => {
      write('lang/tr.json', {Hello: 'Merhaba'})
      write('lang/en.json', {Hello: 'Hello', Old: 'Old'})
      expect(await run('lang:prune', '--write')).toBe(0)
      expect(text()).toContain('Nothing to remove')
      expect(readLang('en').Old).toBe('Old')
    })

    it('still fail lang:check, pointing to lang.keep', async () => {
      await run('lang:sync')
      await run('lang:prune', '--write')
      output = []
      expect(await run('lang:check')).toBe(1)
      expect(text()).not.toContain('not used in code')
      expect(text()).toMatch(/1 key\(s\) are not found in code but were used while the app ran[\s\S]*lang\.keep[\s\S]*"Old"/)

      write('odac.json', {lang: {default: 'en', keep: ['status.*', 'Old']}})
      output = []
      expect(await run('lang:check')).toBe(0)
    })

    it('are mentioned by lang:sync', async () => {
      await run('lang:sync')
      expect(text()).toContain('1 unused key(s)')
      expect(text()).toContain('1 key(s) are not found in code but were used while the app ran')
    })
  })

  it('rejects unknown commands', async () => {
    expect(await run('lang:nope')).toBe(1)
  })

  describe('language directory', () => {
    it('edits the files in lang.path', async () => {
      write('odac.json', {lang: {default: 'en', path: 'resources/i18n', keep: ['status.*']}})
      write('resources/i18n/en.json', {Hello: 'Hello'})
      expect(await run('lang:sync')).toBe(0)
      const synced = JSON.parse(fs.readFileSync(path.join(root, 'resources/i18n/en.json'), 'utf8'))
      expect(synced.Saved).toBe('Saved')
      expect(readLang('en').Saved).toBeUndefined()
    })

    it('still edits storage/language/ when lang/ does not exist, pointing to the move', async () => {
      fs.renameSync(path.join(root, 'lang'), path.join(root, 'storage-language'))
      fs.mkdirSync(path.join(root, 'storage'))
      fs.renameSync(path.join(root, 'storage-language'), path.join(root, 'storage', 'language'))
      expect(await run('lang:sync')).toBe(0)
      expect(text()).toContain('storage/language/, which is deprecated')
      expect(text()).toContain('git mv storage/language lang')
      const synced = JSON.parse(fs.readFileSync(path.join(root, 'storage/language/tr.json'), 'utf8'))
      expect(synced.Saved).toBe('')
      expect(fs.existsSync(path.join(root, 'lang'))).toBe(false)
    })

    it('does not warn when lang/ is in use', async () => {
      await run('lang:sync')
      expect(text()).not.toContain('deprecated')
    })
  })

  describe('regional languages', () => {
    const framework = 'Too many failed attempts. Please try again later.'

    beforeEach(() => {
      write('controller/home.js', "Odac.__('Hello'); Odac.__('Bus')")
      write('view/content/home.html', '')
      write('lang/en.json', {Hello: 'Hello', Bus: 'Bus', [framework]: framework})
      write('lang/pt.json', {Hello: 'Olá', Bus: 'Autocarro', [framework]: 'Demasiadas tentativas.'})
      fs.rmSync(path.join(root, 'lang/tr.json'))
    })

    it('does not report entries a regional file leaves to its language as missing', async () => {
      write('lang/pt-BR.json', {Hello: '', Bus: 'Ônibus', [framework]: ''})
      expect(await run('lang:check', '--strict')).toBe(0)
    })

    it('reports entries neither the regional file nor its language translates', async () => {
      write('lang/pt.json', {Hello: 'Olá', Bus: '', [framework]: 'Demasiadas tentativas.'})
      write('lang/pt-BR.json', {Hello: '', Bus: '', [framework]: ''})
      expect(await run('lang:check', '--strict')).toBe(1)
      expect(text()).toMatch(/pt-BR\.json: 1\n {4}"Bus"/)
    })

    it('adds new keys to regional files as untranslated', async () => {
      write('lang/pt-BR.json', {})
      expect(await run('lang:sync')).toBe(0)
      expect(readLang('pt-BR')).toEqual({Bus: '', Hello: '', [framework]: ''})
    })
  })

  it('works without odac.json or a language directory', async () => {
    fs.rmSync(path.join(root, 'odac.json'))
    fs.rmSync(path.join(root, 'lang'), {recursive: true})
    expect(await run('lang:sync')).toBe(0)
    expect(readLang('en').Hello).toBe('Hello')
  })
})
