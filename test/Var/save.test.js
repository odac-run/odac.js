const fs = require('fs')
const os = require('os')
const path = require('path')
const Var = require('../../src/Var')

// save() must create parent directories based on the target PATH, not the
// content being written — see IMPROVEMENT-PLAN 1.10.

describe('Var.save()', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-var-save-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('creates nested parent directories for the target path', () => {
    const target = path.join(tmpDir, 'a', 'b', 'c.txt')
    // Content has no slash — the old code checked the value and would skip mkdir.
    new Var('plain-content').save(target)
    expect(fs.readFileSync(target, 'utf8')).toBe('plain-content')
  })

  it('does not attempt directory creation based on slashes in the content', () => {
    // Content contains slashes but the path is flat: must not throw or mkdir wrongly.
    const target = path.join(tmpDir, 'flat.txt')
    new Var('a/b/c/value').save(target)
    expect(fs.readFileSync(target, 'utf8')).toBe('a/b/c/value')
  })
})
