const fs = require('fs')
const cluster = require('node:cluster')

const MINUTE = 60 * 1000
// Minutes missed while the event loop was blocked or the machine slept are evaluated late,
// up to this many; a longer gap is not replayed minute by minute.
const MAX_CATCH_UP = 5
const RAW_FIELDS = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day', 1, 31],
  ['month', 1, 12],
  ['weekDay', 0, 7]
]

// Local-time unit counters, so `everyDay` and `everyHour` follow the same clock as `hour`
// and `at()` instead of rolling over at UTC midnight.
const localMs = date => date.getTime() - date.getTimezoneOffset() * MINUTE

/**
 * Parses one field of a cron expression into the set of values it allows.
 * Supports `*`, numbers, lists (`1,15`), ranges (`1-5`) and steps (`*\/15`, `0-30/10`).
 * @returns {Set<number>|null} null for `*` (no restriction)
 */
function parseRawField(value, name, min, max) {
  if (value === '*') return null
  const allowed = new Set()
  for (const part of value.split(',')) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part)
    if (!match) throw new Error(`Unsupported cron value '${value}' for ${name}`)
    const [, startText, endText, stepText] = match
    const start = startText === '*' ? min : Number(startText)
    const end = endText !== undefined ? Number(endText) : startText === '*' || stepText ? max : start
    const step = stepText ? Number(stepText) : 1
    if (start < min || end > max || start > end || step < 1) throw new Error(`Cron value '${value}' is out of range for ${name}`)
    for (let v = start; v <= end; v += step) allowed.add(name === 'weekDay' && v === 7 ? 0 : v)
  }
  return allowed
}

class Cron {
  #timer = null
  #jobs = []
  #lastMinute = null

  /**
   * Starts the scheduler on the primary process.
   * Why: a 60 s setInterval was not aligned to the minute and drifted; once the drift crossed
   * a minute boundary that minute was never checked and a daily `at('03:00')` job did not run.
   * Ticks are scheduled for each minute boundary and every minute since the last tick is
   * evaluated exactly once.
   */
  init() {
    if (this.#timer) return
    if (cluster.isPrimary) {
      this.#lastMinute = Math.floor(Date.now() / MINUTE)
      this.#schedule()
    }
  }

  #schedule() {
    const delay = MINUTE - (Date.now() % MINUTE) + 5
    this.#timer = setTimeout(() => {
      this.#tick()
      if (this.#timer) this.#schedule()
    }, delay)
    this.#timer.unref?.()
  }

  #tick() {
    const current = Math.floor(Date.now() / MINUTE)
    const from = Math.max(this.#lastMinute + 1, current - MAX_CATCH_UP + 1)
    this.#lastMinute = current
    for (let minute = from; minute <= current; minute++) this.check(new Date(minute * MINUTE))
  }

  /**
   * Stops the cron scheduler. Called during graceful shutdown to prevent
   * new cron jobs from firing while the process is terminating.
   */
  stop() {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  /**
   * Runs the jobs due in the minute containing `now`.
   * @param {Date} [now] Any instant within the minute to evaluate.
   */
  check(now = new Date()) {
    const minuteStart = Math.floor(now.getTime() / MINUTE) * MINUTE
    const minute = now.getMinutes()
    const hour = now.getHours()
    const day = now.getDate()
    const weekDay = now.getDay()
    const month = now.getMonth() + 1
    const year = now.getFullYear()
    const yearDay = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 1000 / 60 / 60 / 24)
    const local = localMs(now)
    const values = {minute, hour, day, month, weekDay}

    for (const [index, job] of this.#jobs.entries()) {
      // A job registered (or hot-reloaded) during a minute is first considered for the next one.
      if (minuteStart < Math.floor(job.updated.getTime() / MINUTE) * MINUTE) continue
      let shouldRun = true
      for (const condition of job.condition) {
        if (condition.type === 'raw') {
          shouldRun = this.#matchesRaw(condition.fields, values)
          if (!shouldRun) break
          continue
        }
        condition.value = parseInt(condition.value)
        switch (condition.type) {
          case 'minute':
            if (condition.value !== minute) shouldRun = false
            break
          case 'hour':
            if (condition.value !== hour) shouldRun = false
            break
          case 'day':
            if (condition.value !== day) shouldRun = false
            break
          case 'weekDay':
            if (condition.value !== weekDay) shouldRun = false
            break
          case 'month':
            if (condition.value !== month) shouldRun = false
            break
          case 'year':
            if (condition.value !== year) shouldRun = false
            break
          case 'yearDay':
            if (condition.value !== yearDay) shouldRun = false
            break
          // everyX conditions apply from the very first check: without the
          // (previously present) `job.lastRun &&` guard, a fresh deploy no
          // longer fires every interval job unconditionally on the first tick.
          case 'everyMinute':
            if (Math.floor(local / MINUTE) % condition.value !== 0) shouldRun = false
            break
          case 'everyHour':
            if (Math.floor(local / (60 * MINUTE)) % condition.value !== 0) shouldRun = false
            break
          case 'everyDay':
            if (Math.floor(local / (24 * 60 * MINUTE)) % condition.value !== 0) shouldRun = false
            break
          case 'everyWeekDay':
            if (condition.value !== weekDay) shouldRun = false
            break
          case 'everyMonth':
            if ((year * 12 + month) % condition.value !== 0) shouldRun = false
            break
          case 'everyYear':
            if (year % condition.value !== 0) shouldRun = false
            break
          case 'everyYearDay':
            if (condition.value !== yearDay) shouldRun = false
            break
        }
        if (!shouldRun) break
      }

      // Overlap protection: never re-trigger a job whose previous (async) run
      // has not settled yet.
      if (shouldRun && !job.running) this.#run(job, index, minuteStart)
    }
  }

  // Cron fields: day-of-month and day-of-week are OR-ed when both are restricted (POSIX cron).
  #matchesRaw(fields, values) {
    for (const name of ['minute', 'hour', 'month']) {
      if (fields[name] && !fields[name].has(values[name])) return false
    }
    const {day, weekDay} = fields
    if (day && weekDay) return day.has(values.day) || weekDay.has(values.weekDay)
    if (day) return day.has(values.day)
    if (weekDay) return weekDay.has(values.weekDay)
    return true
  }

  async #run(job, index, minuteStart) {
    // With a shared Redis Ipc several instances schedule the same jobs; the first to claim the
    // minute runs it. The claim is left to expire so instances checking later skip it too.
    const ipc = global.Odac?.Ipc
    if (ipc?.config?.driver === 'redis') {
      const id = `${job.route ?? ''}:${job.controller ?? index}`
      job.running = true
      let claimed = false
      try {
        claimed = await ipc.lock(`odac:cron:${id}:${minuteStart}`, 120, `${process.pid}`)
      } catch (error) {
        console.error(`Cron lock for ${id} failed:`, error.message)
      }
      job.running = false
      if (!claimed) return
    }
    this.#execute(job, minuteStart)
  }

  #execute(job, minuteStart) {
    job.lastRun = new Date(minuteStart)
    try {
      if (!job.function && !fs.existsSync(job.path)) return
      if (!job.function) job.function = require(job.path)
      if (typeof job.function !== 'function') return
      const _odac = global.Odac.instance(null, 'cron')
      job.running = true
      // Wrap so both synchronous throws and async rejections are caught
      // (an unhandled rejection can crash the primary process), and so
      // cleanup runs only after the job has actually finished.
      Promise.resolve()
        .then(() => job.function(_odac))
        .catch(error => console.error(`Error executing job ${job.controller}:`, error))
        .finally(() => {
          job.running = false
          if (_odac.cleanup) _odac.cleanup()
        })
    } catch (error) {
      console.error(`Error executing job ${job.controller}:`, error)
    }
  }

  /**
   * Removes all cron jobs registered from a given route file.
   * Called before hot-reloading a route file to prevent duplicate cron registrations.
   */
  clear(route) {
    if (!route) return
    this.#jobs = this.#jobs.filter(job => job.route !== route)
  }

  job(controller) {
    let path
    if (typeof controller !== 'function') {
      path = `${__dir}/controller/cron/${controller}.js`
      if (controller.includes('.')) {
        let arr = controller.split('.')
        path = `${__dir}/controller/${arr[0]}/cron/${arr.slice(1).join('.')}.js`
      }
    }
    this.#jobs.push({
      route: global.Odac?.Route?.buff || null,
      controller: typeof controller === 'function' ? null : controller,
      lastRun: null,
      condition: [],
      function: typeof controller === 'function' ? controller : null,
      path,
      updated: new Date()
    })
    let id = this.#jobs.length - 1
    const addCondition = (type, value) => {
      this.#jobs[id].condition.push({type, value})
      return chain
    }

    const chain = {
      minute: value => addCondition('minute', value),
      hour: value => addCondition('hour', value),
      day: value => addCondition('day', value),
      at: time => {
        if (!/^\d{1,2}:\d{1,2}$/.test(time)) throw new Error('Invalid time format for .at(). Use HH:MM')
        const [h, m] = time.split(':')
        addCondition('hour', parseInt(h))
        addCondition('minute', parseInt(m))
        return chain
      },
      raw: pattern => {
        const parts = pattern.split(/\s+/).filter(Boolean)
        if (parts.length !== 5) throw new Error('Invalid cron expression. Expected 5 fields (min hour day month weekDay)')
        const fields = {}
        RAW_FIELDS.forEach(([name, min, max], i) => {
          fields[name] = parseRawField(parts[i], name, min, max)
        })
        this.#jobs[id].condition.push({type: 'raw', fields})
        return chain
      },
      weekDay: value => addCondition('weekDay', value),
      month: value => addCondition('month', value),
      year: value => addCondition('year', value),
      yearDay: value => addCondition('yearDay', value),
      everyMinute: value => addCondition('everyMinute', value),
      everyHour: value => addCondition('everyHour', value),
      everyDay: value => addCondition('everyDay', value),
      everyWeekDay: value => addCondition('everyWeekDay', value),
      everyMonth: value => addCondition('everyMonth', value),
      everyYear: value => addCondition('everyYear', value),
      everyYearDay: value => addCondition('everyYearDay', value)
    }
    return chain
  }
}

module.exports = new Cron()
