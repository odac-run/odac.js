// Cron is exported as a singleton instance; reset the module registry per test
// so each gets a fresh, empty job list.

// check() fires due cron jobs. See IMPROVEMENT-PLAN 1.7: job.function() was
// invoked without awaiting, so an async job that rejected escaped the sync
// try/catch as an unhandled rejection (which can crash the primary process),
// and cleanup() ran before the async job finished. A still-running job could
// also be re-triggered on the next tick.

const T0 = new Date('2026-01-01T00:00:00Z').getTime()
// setImmediate is left real so we can drain the promise microtask queue.
const flush = () => new Promise(resolve => setImmediate(resolve))

describe('Cron.check()', () => {
  let cron
  let cleanup

  beforeEach(() => {
    jest.resetModules()
    cron = require('../../../src/Route/Cron')
    jest.useFakeTimers({doNotFake: ['setImmediate']})
    jest.setSystemTime(T0)
    cleanup = jest.fn()
    global.Odac = {
      instance: jest.fn(() => ({cleanup})),
      Route: {buff: null}
    }
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    delete global.Odac
  })

  // Advance past the 60s "recently updated" guard so a freshly registered job runs.
  const advancePastGuard = (seconds = 61) => jest.setSystemTime(T0 + seconds * 1000)

  it('catches an async job rejection instead of letting it go unhandled', async () => {
    cron.job(async () => {
      throw new Error('async boom')
    })
    advancePastGuard()
    cron.check()
    await flush()

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error executing job'), expect.any(Error))
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('runs cleanup only after an async job settles', async () => {
    let order = []
    cron.job(async () => {
      await Promise.resolve()
      order.push('job')
    })
    cleanup.mockImplementation(() => order.push('cleanup'))
    advancePastGuard()
    cron.check()
    await flush()

    expect(order).toEqual(['job', 'cleanup'])
  })

  it('does not re-trigger a job that is still running (overlap protection)', async () => {
    let calls = 0
    cron.job(() => {
      calls++
      return new Promise(() => {}) // never resolves → stays "running"
    })
    advancePastGuard(61)
    cron.check()
    advancePastGuard(122)
    cron.check()
    await flush()

    expect(calls).toBe(1)
  })
})
