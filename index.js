'use strict'

global.__dir = process.cwd()

// Surface startup failures loudly. init() is async; without a .catch() any
// rejection (migration, DB connection, config parse) becomes an UnhandledPromiseRejection
// that the structured logger never sees — making a broken boot look like a clean start.
require('./src/Odac.js')
  .init()
  .catch(err => {
    console.error('\x1b[31m[ODAC Fatal]\x1b[0m Startup failed:', err.message)
    if (err.cause) console.error('\x1b[31m[ODAC Fatal]\x1b[0m Cause:', err.cause.message || err.cause)
    process.exit(1)
  })
