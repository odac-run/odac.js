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
            if (job.lastRun && weekDay % condition.value !== 0) shouldRun = false
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
              job.function()
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
