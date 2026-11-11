const Validator = require('../../src/Validator')

// brute() rate-limits failed form submissions per ip+page. It must:
//  - use an ATOMIC counter (Ipc.incrBy) so concurrent workers don't lose
//    updates via a get→modify→put race,
//  - give the counter a TTL so idle clients leave no keys behind, and
//  - keep rejecting submissions, valid or not, once the limit is reached.

function makeIpc(counterValue) {
  return {
    incrBy: jest.fn().mockResolvedValue(counterValue),
    get: jest.fn().mockResolvedValue(counterValue),
    del: jest.fn().mockResolvedValue(true)
  }
}

function makeReq() {
  return {
    ip: '9.9.9.9',
    url: '/login?next=/home',
    request: async () => undefined
  }
}

function makeOdac(ipc) {
  return {
    Var: () => ({is: () => false}),
    // Kept to prove the fix no longer routes through the monolithic Storage blob.
    Storage: {get: jest.fn(() => ({})), put: jest.fn(() => true)},
    Ipc: ipc
  }
}

// Produces a validator that already has a validation error recorded, so brute()
// actually counts the attempt.
async function failedValidator(odac) {
  const v = new Validator(makeReq(), odac)
  v.var('field', '').check('required').message('required')
  await v.error()
  return v
}

describe('Validator.brute()', () => {
  it('atomically increments a windowed key for a failed attempt', async () => {
    const ipc = makeIpc(1)
    const v = await failedValidator(makeOdac(ipc))
    await v.brute(5)

    expect(ipc.incrBy).toHaveBeenCalledTimes(1)
    expect(ipc.incrBy).toHaveBeenCalledWith('brute:/login:9.9.9.9', 1, 3600)
  })

  it('uses a custom window length as the counter TTL', async () => {
    const ipc = makeIpc(1)
    const v = await failedValidator(makeOdac(ipc))
    await v.brute(5, 600)

    expect(ipc.incrBy).toHaveBeenCalledWith('brute:/login:9.9.9.9', 1, 600)
  })

  it('blocks once the counter reaches maxAttempts', async () => {
    const ipc = makeIpc(5)
    const v = await failedValidator(makeOdac(ipc))
    await v.brute(5)

    const out = await v.result()
    expect(out.errors._odac_form).toMatch(/Too many failed attempts/)
  })

  it('does not block below maxAttempts', async () => {
    const ipc = makeIpc(2)
    const v = await failedValidator(makeOdac(ipc))
    await v.brute(5)

    const out = await v.result()
    expect(out.errors._odac_form).toBeUndefined()
  })

  it('does not count when there is no validation error', async () => {
    const ipc = makeIpc(1)
    const v = new Validator(makeReq(), makeOdac(ipc))
    v.var('field', 'ok').check('required')
    await v.error()
    await v.brute(5)

    expect(ipc.incrBy).not.toHaveBeenCalled()
    expect((await v.result()).result.success).toBe(true)
  })

  it('rejects a valid submission while the limit is reached', async () => {
    const ipc = makeIpc(5)
    const v = new Validator(makeReq(), makeOdac(ipc))
    v.var('field', 'ok').check('required')
    await v.brute(5)

    expect(ipc.incrBy).not.toHaveBeenCalled()
    expect(await v.error()).toBe(true)
    expect((await v.result()).errors._odac_form).toMatch(/Too many failed attempts/)
  })

  it('counts a failure when called before error()', async () => {
    const ipc = makeIpc(1)
    const v = new Validator(makeReq(), makeOdac(ipc))
    v.var('field', '').check('required').message('required')
    await v.brute(5)

    expect(ipc.incrBy).toHaveBeenCalledTimes(1)
    expect(await v.error()).toBe(true)
  })
})
