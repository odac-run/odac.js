const Validator = require('../../src/Validator')

// brute() rate-limits failed form submissions per ip+page+hour. It must:
//  - use an ATOMIC counter (Ipc.incrBy) so concurrent workers don't lose
//    updates via a get→modify→put race, and
//  - bound storage growth (no ever-accumulating hour buckets under one key).
// See IMPROVEMENT-PLAN 2.6.

function makeIpc(counterValue) {
  return {
    incrBy: jest.fn().mockResolvedValue(counterValue),
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
  it('atomically increments an hour-bucketed key for a failed attempt', async () => {
    const ipc = makeIpc(1)
    const v = await failedValidator(makeOdac(ipc))
    await v.brute(5)

    expect(ipc.incrBy).toHaveBeenCalledTimes(1)
    const [key, delta] = ipc.incrBy.mock.calls[0]
    // brute:<page>:<ip>:<YYYY-MM-DDTHH>
    expect(key).toMatch(/^brute:\/login:9\.9\.9\.9:\d{4}-\d{2}-\d{2}T\d{2}$/)
    expect(delta).toBe(1)
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
  })

  it('bounds growth by clearing the previous hour bucket on a fresh bucket', async () => {
    const ipc = makeIpc(1) // count === 1 means a brand-new hour bucket
    const v = await failedValidator(makeOdac(ipc))
    await v.brute(5)

    expect(ipc.del).toHaveBeenCalledTimes(1)
    expect(ipc.del.mock.calls[0][0]).toMatch(/^brute:\/login:9\.9\.9\.9:\d{4}-\d{2}-\d{2}T\d{2}$/)
  })
})
