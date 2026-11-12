const {execFile} = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// `odac build` compiles view/css/*.css with Tailwind. File names and the project path are
// passed as arguments, never through a shell: a file named `a$(touch PWNED).css` used to run
// the embedded command.

const BIN = path.resolve(__dirname, '../../bin/odac.js')
const NODE_MODULES = path.resolve(__dirname, '../../node_modules')

describe('odac build', () => {
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac build '))
    fs.mkdirSync(path.join(dir, 'view/css'), {recursive: true})
    fs.symlinkSync(NODE_MODULES, path.join(dir, 'node_modules'), 'dir')
  })

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('compiles CSS whose name contains shell syntax without running it', async () => {
    const name = 'a$(touch PWNED)`touch PWNED2`.css'
    fs.writeFileSync(path.join(dir, 'view/css', name), '@import "tailwindcss";\n')

    await new Promise((resolve, reject) =>
      execFile(process.execPath, [BIN, 'build'], {cwd: dir, timeout: 60000}, (err, stdout, stderr) =>
        err ? reject(new Error(stderr || err.message)) : resolve(stdout)
      )
    )

    expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'PWNED2'))).toBe(false)
    expect(fs.statSync(path.join(dir, 'public/assets/css', name)).size).toBeGreaterThan(0)
  }, 70000)
})
