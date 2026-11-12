const fs = require('fs')
const os = require('os')
const path = require('path')
const Env = require('../../src/Env')

describe('Env.init()', () => {
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-env-'))
  })

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
    delete process.env.ODAC_ENV_TEST_A
    delete process.env.ODAC_ENV_TEST_B
  })

  it('loads variables without overriding existing ones', async () => {
    process.env.ODAC_ENV_TEST_B = 'host'
    fs.writeFileSync(path.join(dir, '.env'), 'ODAC_ENV_TEST_A=file\nODAC_ENV_TEST_B=file\n')
    await Env.init(dir)
    expect(process.env.ODAC_ENV_TEST_A).toBe('file')
    expect(process.env.ODAC_ENV_TEST_B).toBe('host')
  })

  it('does nothing when .env is missing', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await expect(Env.init(dir)).resolves.toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
