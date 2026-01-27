const fs = require('fs')
const cluster = require('node:cluster')

class Cron {
  #interval = null
  #jobs = []

  init() {
    if (this.#interval) return
    if (cluster.isPrimary) {
      this.#interval = setInterval(this.check.bind(this), 60 * 1000) // Check every minute
    }
  }

  check() {
    const now = new Date()
    const minute = now.getMinutes()
    const hour = now.getHours()
    const day = now.getDate()
    const weekDay = now.getDay()
    const month = now.getMonth() + 1
    const year = now.getFullYear()
    const yearDay = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 1000 / 60 / 60 / 24)
    const unix = Math.floor(now.getTime() / 1000)

    for (const job of this.#jobs) {
      if (job.updated.getTime() + 60 * 1000 > now.getTime()) continue // Skip jobs updated in the last minute
      let shouldRun = true
      for (const condition of job.condition) {
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
          case 'everyMinute':
            if (job.lastRun && Math.floor(unix / 60) % condition.value !== 0) shouldRun = false
            break
          case 'everyHour':
            if (job.lastRun && Math.floor(unix / 3600) % condition.value !== 0) shouldRun = false
            break
          case 'everyDay':
            if (job.lastRun && Math.floor(unix / 86400) % condition.value !== 0) shouldRun = false
            break
          case 'everyWeekDay':
            if (condition.value !== weekDay) shouldRun = false
            break
          case 'everyMonth':
            if (job.lastRun && (year * 12 + month) % condition.value !== 0) shouldRun = false
            break
          case 'everyYear':
            if (job.lastRun && year % condition.value !== 0) shouldRun = false
            break
          case 'everyYearDay':
            if (job.lastRun && condition.value !== yearDay) shouldRun = false
            break
        }
        if (!shouldRun) break
      }

      if (shouldRun) {
        job.lastRun = now
        try {
          if (job.function || fs.existsSync(job.path)) {
            if (!job.function) job.function = require(job.path)
            if (job.function && typeof job.function === 'function') {
              const _odac = global.Odac.instance(null, 'cron')
              job.function(_odac)
              if (_odac.cleanup) _odac.cleanup()
            }
          }
        } catch (error) {
          console.error(`Error executing job ${job.controller}:`, error)
        }
      }
    }
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
        const parts = pattern.split(' ').filter(p => p.trim() !== '')
        if (parts.length !== 5) throw new Error('Invalid cron expression. Expected 5 fields (min hour day month weekDay)')

        const [min, hour, day, month, weekDay] = parts
        const parse = (val, type, everyType) => {
          if (val === '*') return
          if (val.startsWith('*/') && everyType) {
            addCondition(everyType, parseInt(val.split('/')[1]))
            return
          }
          if (!isNaN(val)) {
            addCondition(type, parseInt(val))
            return
          }
          throw new Error(`Unsupported cron value '${val}' for ${type}`)
        }

        parse(min, 'minute', 'everyMinute')
        parse(hour, 'hour', 'everyHour')
        parse(day, 'day', 'everyDay')
        parse(month, 'month', 'everyMonth')
        parse(weekDay, 'weekDay', null)

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
