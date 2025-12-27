const fs = require('fs')
const path = require('path')

class Storage {
  constructor() {
    this.db = null
    this.ready = false
  }

  init() {
    const { open } = require('lmdb')
    
    const storagePath = path.join(global.__dir, 'storage')
    const dbPath = path.join(storagePath, 'sessions.db')
    
    try {
      // Ensure storage directory exists
      if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true })
      }
      
      this.db = open({
        path: dbPath,
        compression: true,
      })
      this.ready = true
    } catch (error) {
      console.error('\x1b[31m[Storage Error]\x1b[0m Failed to initialize LMDB:', error.message)
      console.error('\x1b[33m[Storage]\x1b[0m Path:', dbPath)
      this.ready = false
    }
  }

  // --- Basic KV Operations ---
  
  get(key) {
    if (!this.ready) return null
    return this.db.get(key) ?? null
  }

  put(key, value) {
    if (!this.ready) return false
    return this.db.put(key, value)
  }

  remove(key) {
    if (!this.ready) return false
    return this.db.remove(key)
  }

  // --- Range Operations ---
  
  getRange(options = {}) {
    if (!this.ready) return []
    return this.db.getRange(options)
  }

  getKeys(options = {}) {
    if (!this.ready) return []
    return this.db.getKeys(options)
  }

  // --- Session Garbage Collector ---
  
  startSessionGC(intervalMs = 60 * 60 * 1000, expirationMs = 7 * 24 * 60 * 60 * 1000) {
    if (!this.ready) {
      console.warn('[Storage] GC not started: Storage not ready')
      return null
    }

    return setInterval(() => {
      const now = Date.now()
      let count = 0
      
      try {
        for (const { key, value } of this.db.getRange({ start: 'sess:', end: 'sess:~', snapshot: false })) {
          if (key.endsWith(':_created')) {
            if (now - value > expirationMs) {
              const prefix = key.replace(':_created', '')
              for (const subKey of this.db.getKeys({ start: prefix, end: prefix + '~' })) {
                this.db.remove(subKey)
              }
              count++
            }
          }
        }
        if (count > 0) {
          console.log(`\x1b[36m[Storage GC]\x1b[0m Cleaned ${count} expired sessions.`)
        }
      } catch (error) {
        console.error('\x1b[31m[Storage GC Error]\x1b[0m', error.message)
      }
    }, intervalMs)
  }

  // --- Utility ---
  
  close() {
    if (this.db) {
      this.db.close()
      this.ready = false
    }
  }

  isReady() {
    return this.ready
  }
}

module.exports = new Storage()
