const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {copyTemplate} = require('../../../src/Cli/Scaffold')

// npm drops `.gitignore` from published packages, so the template keeps it as `gitignore`
// and init must restore the dot.

describe('copyTemplate()', () => {
  const templateDir = path.resolve(__dirname, '../../../template')
  let target

  beforeEach(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-init-'))
  })

  afterEach(() => {
    fs.rmSync(target, {recursive: true, force: true})
  })

  it('ships the template ignore file under a name npm publishes', () => {
    expect(fs.existsSync(path.join(templateDir, 'gitignore'))).toBe(true)
    expect(fs.existsSync(path.join(templateDir, '.gitignore'))).toBe(false)
  })

  it('restores .gitignore in the new project', async () => {
    await copyTemplate(templateDir, target)

    const ignore = fs.readFileSync(path.join(target, '.gitignore'), 'utf8')
    expect(ignore).toMatch(/^\.env$/m)
    // Translations live in lang/, outside the ignored runtime data.
    expect(ignore).toMatch(/^storage\/$/m)
    expect(ignore).not.toMatch(/^!storage/m)
    expect(fs.existsSync(path.join(target, 'gitignore'))).toBe(false)
    expect(fs.existsSync(path.join(target, 'odac.json'))).toBe(true)
  })

  it('keeps an existing .gitignore', async () => {
    fs.writeFileSync(path.join(target, '.gitignore'), 'custom\n')

    await copyTemplate(templateDir, target)

    expect(fs.readFileSync(path.join(target, '.gitignore'), 'utf8')).toBe('custom\n')
    expect(fs.existsSync(path.join(target, 'gitignore'))).toBe(false)
  })
})
