// Minute-aligned scheduling with catch-up, local-time day/hour counters, full raw() syntax
// and the per-minute claim that keeps several instances from running the same job.

const flush = () => new Promise(resolve => setImmediate(resolve))
const MINUTE = 60 * 1000

describe('Cron scheduling', () => {
  let cron
  const originalTZ = process.env.TZ

  const load = () => {
    jest.resetModules()
    return require('../../../src/Route/Cron')
  }

  beforeEach(() => {
    process.env.TZ = 'Europe/Istanbul'
    jest.useFakeTimers({doNotFake: ['setImmediate']})
    global.Odac = {instance: jest.fn(() => ({cleanup: jest.fn()})), Route: {buff: null}}
    jest.spyOn(console, 'error').mockImplementation(() => {})
    cron = load()
  })

  afterEach(() => {
    cron.stop()
    jest.useRealTimers()
    jest.restoreAllMocks()
    delete global.Odac
    process.env.TZ = originalTZ
  })

  it('ticks on minute boundaries', async () => {
    jest.setSystemTime(new Date(2026, 0, 1, 2, 59, 30).getTime())
    const fn = jest.fn()
    cron.job(fn).at('03:00')
    cron.init()

    jest.advanceTimersByTime(29 * 1000)
    await flush()
    expect(fn).not.toHaveBeenCalled()
    jest.advanceTimersByTime(2 * 1000)
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('still runs a job whose minute was skipped by a late tick', async () => {
    jest.setSystemTime(new Date(2026, 0, 1, 2, 58, 50).getTime())
    const fn = jest.fn()
    cron.job(fn).at('03:00')
    cron.init()

    // The event loop is blocked across 02:59 and 03:00; the next tick lands at 03:01:20.
    jest.setSystemTime(new Date(2026, 0, 1, 3, 1, 20).getTime())
    jest.runOnlyPendingTimers()
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not evaluate the same minute twice', async () => {
    jest.setSystemTime(new Date(2026, 0, 1, 2, 59, 50).getTime())
    const fn = jest.fn()
    cron.job(fn).minute(0)
    cron.init()
    jest.advanceTimersByTime(3 * MINUTE)
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('counts everyDay in local days, like hour and at()', async () => {
    // 2026-01-02 01:00 in Istanbul is still 2026-01-01 in UTC.
    jest.setSystemTime(new Date(2025, 11, 31).getTime())
    const fn = jest.fn()
    cron.job(fn).everyDay(2).at('01:00')
    cron.check(new Date(2026, 0, 2, 1, 0)) // local day 20455 (odd)
    await flush()
    expect(fn).not.toHaveBeenCalled()
    cron.check(new Date(2026, 0, 3, 1, 0)) // local day 20456 (even)
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  describe('raw()', () => {
    const matches = async (expression, date) => {
      const instance = load()
      jest.setSystemTime(new Date(2025, 11, 1).getTime())
      const fn = jest.fn()
      instance.job(fn).raw(expression)
      instance.check(date)
      await flush()
      return fn.mock.calls.length === 1
    }

    it('supports lists, ranges and steps', async () => {
      // 2026-01-05 is a Monday.
      expect(await matches('0,30 9-17 * * 1-5', new Date(2026, 0, 5, 9, 30))).toBe(true)
      expect(await matches('0,30 9-17 * * 1-5', new Date(2026, 0, 5, 18, 0))).toBe(false)
      expect(await matches('0,30 9-17 * * 1-5', new Date(2026, 0, 10, 9, 30))).toBe(false) // Saturday
      expect(await matches('*/7 * * * *', new Date(2026, 0, 5, 9, 56))).toBe(true)
      expect(await matches('*/7 * * * *', new Date(2026, 0, 5, 10, 3))).toBe(false)
      expect(await matches('0-30/10 * * * *', new Date(2026, 0, 5, 9, 20))).toBe(true)
      expect(await matches('0 0 * * 7', new Date(2026, 0, 4, 0, 0))).toBe(true) // 7 is Sunday
    })

    it('ORs day-of-month and day-of-week when both are set', async () => {
      expect(await matches('0 0 1 * 1', new Date(2026, 0, 5, 0, 0))).toBe(true) // Monday, not the 1st
      expect(await matches('0 0 1 * 1', new Date(2026, 0, 1, 0, 0))).toBe(true) // the 1st, a Thursday
      expect(await matches('0 0 1 * 1', new Date(2026, 0, 6, 0, 0))).toBe(false)
    })

    it('rejects malformed and out-of-range fields', () => {
      expect(() => cron.job(jest.fn()).raw('61 * * * *')).toThrow()
      expect(() => cron.job(jest.fn()).raw('5-1 * * * *')).toThrow()
      expect(() => cron.job(jest.fn()).raw('MON * * * *')).toThrow()
    })
  })

  it('lets only one instance run a job per minute with the Redis Ipc', async () => {
    const claims = new Set()
    global.Odac.Ipc = {
      config: {driver: 'redis'},
      lock: jest.fn(async key => {
        if (claims.has(key)) return false
        claims.add(key)
        return true
      })
    }
    jest.setSystemTime(new Date(2026, 0, 1, 3, 0, 30).getTime())
    const fn = jest.fn()
    const first = load()
    first.job(fn).everyMinute(1)
    const second = load()
    second.job(fn).everyMinute(1)

    jest.setSystemTime(new Date(2026, 0, 1, 3, 0, 30).getTime())
    const minute = new Date(2026, 0, 1, 3, 1)
    first.check(minute)
    second.check(minute)
    await flush()
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
