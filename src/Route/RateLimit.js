const nodeCrypto = require('crypto')

const KEY_PREFIX = 'odac:ratelimit:'

let anonymousLimiters = 0

/**
 * Validates and freezes a rate-limit declaration.
 *
 * Why: limits are declared in route files at boot. A typo (`max: '10'`,
 * `window: 0`) would otherwise silently disable the limit or divide by zero on
 * the first request, so the declaration fails at load time instead.
 *
 * @param {{max: number, window?: number, key?: function, name?: string}} options
 *   `max` requests per `window` milliseconds (default 60000), counted per key.
 *   `key(Odac)` returns the client identity (default: client IP); returning
 *   null, undefined or '' exempts that request.
 * @param {string} scope Bucket name shared by every route using this limit.
 * @returns {{max: number, window: number, key: function|null, scope: string}}
 */
function normalize(options, scope) {
  if (!options || typeof options !== 'object') throw new TypeError('rateLimit must be an object such as {max: 60, window: 60000}.')
  const {max, window = 60000, key = null} = options
  if (!Number.isInteger(max) || max < 1) throw new TypeError(`rateLimit.max must be a positive integer, got ${max}.`)
  if (!Number.isInteger(window) || window < 1) throw new TypeError(`rateLimit.window must be a positive integer (ms), got ${window}.`)
  if (key !== null && typeof key !== 'function') throw new TypeError('rateLimit.key must be a function (Odac) => string.')
  return Object.freeze({max, window, key, scope})
}

function identity(Odac, limit) {
  if (!limit.key) return Odac.Request.ip ?? ''
  const value = limit.key(Odac)
  return value === null || value === undefined || value === '' ? null : String(value)
}

/**
 * Counts one request against a limit and rejects it with 429 once the limit is exceeded.
 *
 * Why: HTTP routes had no throttle, so expensive endpoints and form targets
 * could be flooded. Counting goes through Odac.Ipc, so the limit holds across
 * every worker (memory driver) or every host (Redis driver). Fixed windows
 * aligned to `window` give every worker the same bucket and reset time
 * without coordination; the trade-off is a possible 2× burst across a
 * window boundary.
 *
 * The limiter fails open: when the counter store is unreachable or the key
 * function throws, the request proceeds and the failure is logged. A
 * throttle must not turn an IPC outage into a full outage.
 *
 * @param {object} Odac Request-scoped instance.
 * @param {{max: number, window: number, key: function|null, scope: string}} limit From normalize().
 * @returns {Promise<boolean>} true when the request may proceed; false when it was answered with 429.
 */
async function consume(Odac, limit) {
  let id
  try {
    id = identity(Odac, limit)
  } catch (err) {
    console.error(JSON.stringify({level: 'ERROR', message: 'rateLimit key function failed', scope: limit.scope, error: err?.message}))
    return true
  }
  if (id === null) return true

  const now = Date.now()
  const bucket = Math.floor(now / limit.window)
  const resetIn = Math.ceil(((bucket + 1) * limit.window - now) / 1000)
  // Hashed so a client-controlled key (header, email) cannot grow store keys without bound.
  const digest = nodeCrypto.createHash('sha256').update(`${limit.scope}\0${id}`).digest('base64url')

  let count
  try {
    count = await Odac.Ipc.incrBy(`${KEY_PREFIX}${digest}:${bucket}`, 1, Math.ceil(limit.window / 1000))
  } catch (err) {
    console.error(
      JSON.stringify({level: 'WARN', message: 'rateLimit counter unavailable, request allowed', scope: limit.scope, error: err?.message})
    )
    return true
  }

  Odac.Request.header('RateLimit-Limit', String(limit.max))
  Odac.Request.header('RateLimit-Remaining', String(Math.max(0, limit.max - count)))
  Odac.Request.header('RateLimit-Reset', String(resetIn))
  if (count <= limit.max) return true

  Odac.Request.header('Retry-After', String(resetIn))
  await Odac.Request.abort(429)
  return false
}

/**
 * Builds a middleware that applies one shared limit to every route it wraps.
 *
 * Why: the per-route `rateLimit` option gives each route its own bucket; a
 * group of routes (an API surface, every upload endpoint) often needs one
 * budget instead. Pass `name` to keep the bucket stable when route files are
 * reordered or limiters are added conditionally; without it the bucket is
 * named by creation order, which is identical across workers loading the
 * same route files.
 *
 * @param {{max: number, window?: number, key?: function, name?: string}} options
 * @returns {function(object): Promise<false|undefined>} Middleware for Odac.Route.use().
 */
function middleware(options) {
  const name = options?.name
  if (name !== undefined && (typeof name !== 'string' || name === '')) throw new TypeError('rateLimit.name must be a non-empty string.')
  const limit = normalize(options, `mw:${name ?? ++anonymousLimiters}`)
  return async Odac => {
    if (await consume(Odac, limit)) return undefined
    return false
  }
}

module.exports = {normalize, consume, middleware}
