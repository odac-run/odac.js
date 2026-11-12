const {execFile} = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const Hook = require('../../src/Hook.js')

const HOOK = path.resolve(__dirname, '../../src/Hook.js')

describe('Hook', () => {
  let dirs
  let errors
  let errorSpy

  const write = files => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-hook-'))
    dirs.push(dir)
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
    return dir
  }

  beforeEach(() => {
    dirs = []
    errors = []
    errorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.map(String).join(' ')))
  })

  afterEach(async () => {
    await Hook.load(path.join(os.tmpdir(), 'odac-hook-missing'))
    errorSpy.mockRestore()
    for (const dir of dirs) fs.rmSync(dir, {recursive: true, force: true})
  })

  it('loads the known events of a known hook file', async () => {
    await Hook.load(write({'auth.js': 'module.exports = {login: () => 1, beforeLogin: async () => false}'}))

    expect(Hook.has('auth', 'login')).toBe(true)
    expect(Hook.has('auth', 'beforeLogin')).toBe(true)
    expect(Hook.has('auth', 'loginFailed')).toBe(false)
    await expect(Hook.run('auth', 'login')).resolves.toEqual({ran: true, value: 1})
    await expect(Hook.run('auth', 'beforeLogin')).resolves.toEqual({ran: true, value: false})
  })

  it('passes the arguments through', async () => {
    await Hook.load(write({'auth.js': 'module.exports = {login: (Odac, payload) => [Odac.tag, payload.method]}'}))
    await expect(Hook.run('auth', 'login', {tag: 'ctx'}, {method: 'password'})).resolves.toEqual({ran: true, value: ['ctx', 'password']})
  })

  it('reports nothing ran when no hook is defined', async () => {
    await Hook.load(path.join(os.tmpdir(), 'odac-hook-missing'))
    expect(Hook.has('auth', 'login')).toBe(false)
    await expect(Hook.run('auth', 'login')).resolves.toEqual({ran: false})
  })

  it('returns a thrown error instead of raising it', async () => {
    await Hook.load(write({'auth.js': "module.exports = {login: async () => { throw new Error('boom') }}"}))

    const result = await Hook.run('auth', 'login')
    expect(result.ran).toBe(true)
    expect(result.error.message).toBe('boom')
    expect(errors.some(e => e.includes('"login" failed'))).toBe(true)
  })

  it('reports unknown files and unknown events instead of ignoring them silently', async () => {
    await Hook.load(write({'mail.js': 'module.exports = {}', 'auth.js': 'module.exports = {logn: () => 1, login: () => 2}'}))

    expect(Hook.has('auth', 'logn')).toBe(false)
    expect(Hook.has('auth', 'login')).toBe(true)
    expect(errors.some(e => e.includes('Unknown hook file') && e.includes('mail.js'))).toBe(true)
    expect(errors.some(e => e.includes('Unknown auth hook "logn"'))).toBe(true)
  })

  it('rejects a file whose export is not an object of functions', async () => {
    await Hook.load(write({'auth.js': "module.exports = {login: 'yes'}"}))

    expect(Hook.has('auth', 'login')).toBe(false)
    expect(errors.some(e => e.includes('Failed to load hook'))).toBe(true)
    expect(errors.some(e => e.includes('is not a function'))).toBe(true)
  })

  it('ignores files that are not JavaScript', async () => {
    await Hook.load(write({'auth.js.bak': 'module.exports = {login: () => 1}', 'README.md': '# hooks'}))
    expect(Hook.has('auth', 'login')).toBe(false)
    expect(errors).toEqual([])
  })
})

// Hot reload relies on require.cache, which Jest's module registry ignores, so these steps run
// in a plain Node process (see test/Route/init.test.js).
describe('Hook.load() hot reload', () => {
  const HARNESS = `
const fs = require('fs')
const path = require('path')
const Hook = require(${JSON.stringify(HOOK)})
const dir = process.argv[2]
const hookDir = path.join(dir, 'hook')
const steps = require(path.join(dir, 'steps.js'))
const errors = []
console.error = (...args) => errors.push(args.map(String).join(' '))
let offset = 0
;(async () => {
  const results = []
  for (const step of steps) {
    for (const [name, content] of step.files) {
      const file = path.join(hookDir, name)
      fs.mkdirSync(hookDir, {recursive: true})
      if (content === null) fs.rmSync(file)
      else {
        fs.writeFileSync(file, content)
        const time = new Date(Date.now() + offset * 1000)
        fs.utimesSync(file, time, time)
      }
    }
    await Hook.load(hookDir)
    results.push({has: Hook.has('auth', 'login'), value: (await Hook.run('auth', 'login')).value ?? null})
    offset += 5
  }
  process.stdout.write(JSON.stringify({results, errors}))
})()
`

  const run = steps => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-hook-reload-'))
    fs.writeFileSync(path.join(dir, 'harness.js'), HARNESS)
    fs.writeFileSync(path.join(dir, 'steps.js'), `module.exports = ${JSON.stringify(steps)}`)
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [path.join(dir, 'harness.js'), dir], {timeout: 20000}, (err, stdout, stderr) => {
        fs.rmSync(dir, {recursive: true, force: true})
        if (err) return reject(new Error(stderr || err.message))
        resolve(JSON.parse(stdout))
      })
    })
  }

  it('reloads a changed file, keeps the last good version on a broken save and drops a removed file', async () => {
    const {results, errors} = await run([
      {files: [['auth.js', "module.exports = {login: () => 'v1'}"]]},
      {files: [['auth.js', "module.exports = {login: () => 'v2'}"]]},
      {files: [['auth.js', 'module.exports = {login: (']]},
      {files: []},
      {files: [['auth.js', null]]}
    ])

    expect(results).toEqual([
      {has: true, value: 'v1'},
      {has: true, value: 'v2'},
      {has: true, value: 'v2'},
      {has: true, value: 'v2'},
      {has: false, value: null}
    ])
    // The broken save is reported once, not on every reload cycle.
    expect(errors.filter(e => e.includes('Failed to load hook'))).toHaveLength(1)
  })
})
