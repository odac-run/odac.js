const nodeCrypto = require('crypto')
const fsPromises = require('fs').promises
const path = require('path')
const v8 = require('v8')
const Var = require('../Var')

/**
 * Tokens for lazy components (`<c:name lazy>`) and the `/_odac/lazy` request that renders them.
 *
 * Why: a lazy component renders in a second request, after the page reached the browser. That
 * request must render exactly the component and props the page asked for, so the page carries
 * them in a token the browser sends back. The token is encrypted and authenticated
 * (AES-256-GCM): the browser can neither read props the server computed nor change them (props
 * are trusted, e.g. a record id). It is bound to the signed-in user who received the page, so a
 * leaked token does not render that user's data for someone else, and expires after MAX_AGE.
 * Nothing is stored on the server, so pages cached with `Odac.cache()` keep working.
 *
 * Key: derived from `encrypt.key` when it is configured (the same on every server), otherwise
 * from a random key generated once in `storage/.key` (shared by the workers of one server).
 */

const VERSION = 1
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_INFO = 'odac:view:lazy:v1'
const KEY_FILE = 'storage/.key'
// Serialized props larger than this would make the request URL unreliable (proxies and servers
// commonly limit URLs to 8 KB). Lazy components take ids, not records.
const MAX_PAYLOAD = 3072
const MAX_TOKEN = Math.ceil(((1 + IV_LENGTH + MAX_PAYLOAD + TAG_LENGTH) * 4) / 3)
const MAX_AGE = 7 * 24 * 60 * 60 * 1000
// Tolerated clock difference between servers for a token issued "in the future".
const CLOCK_SKEW = 60 * 1000
const TOKEN = /^[A-Za-z0-9_-]+$/
const KEY_HEX = /^[0-9a-f]{64}$/

let derived = null
let generated = null

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// The generated key, created by the first process that needs it. `wx` makes creation exclusive
// across workers; a worker that loses the race may read the file before its content is written,
// so it retries briefly instead of creating a second key.
async function readOrCreate(file) {
  try {
    await fsPromises.mkdir(path.dirname(file), {recursive: true})
    await fsPromises.writeFile(file, `${nodeCrypto.randomBytes(32).toString('hex')}\n`, {flag: 'wx', mode: 0o600})
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    const text = (await fsPromises.readFile(file, 'utf8')).trim()
    if (KEY_HEX.test(text)) return Buffer.from(text, 'hex')
    if (text) break
    await wait(25)
  }
  throw new Error(`${KEY_FILE} does not hold a valid ODAC key; delete it to generate a new one`)
}

function generatedKey() {
  const file = path.join(__dir, KEY_FILE)
  if (generated?.file !== file) {
    const key = readOrCreate(file).catch(e => {
      if (generated?.key === key) generated = null
      throw e
    })
    generated = {file, key}
  }
  return generated.key
}

async function secret(odac) {
  const configured = odac.Config?.encrypt?.key
  const material = configured && !Var.isDefaultKey(configured) ? Buffer.from(configured) : await generatedKey()
  if (!derived?.material.equals(material)) {
    derived = {material, key: Buffer.from(nodeCrypto.hkdfSync('sha256', material, Buffer.alloc(0), KEY_INFO, 32))}
  }
  return derived.key
}

/**
 * The signed-in user a lazy token is bound to: the auth primary key, or null for a guest.
 * @param {object} odac Request context.
 * @returns {string|null}
 */
function user(odac) {
  const id = odac.Auth?.user?.(odac.Config?.auth?.key || 'id')
  return id === false || id === null || id === undefined ? null : String(id)
}

/**
 * Encrypts what a lazy request needs to render the component.
 * @param {object} odac Request context (config for the key).
 * @param {object} data
 * @param {string} data.name Component name.
 * @param {Array<[string, *]>} data.attributes Attributes as evaluated on the tag.
 * @param {string|null} data.user See user().
 * @param {string|null} data.lang Language the page is served in.
 * @returns {Promise<string>} base64url token.
 * @throws {Error} When a value cannot be serialized or the props are too large.
 */
async function seal(odac, {name, attributes, user, lang}) {
  let plain
  try {
    plain = v8.serialize([name, attributes, user, lang, Date.now()])
  } catch (e) {
    throw new Error(`Lazy component "${name}" has a prop that cannot be sent to the browser (${e.message})`)
  }
  if (plain.length > MAX_PAYLOAD) {
    throw new Error(
      `Lazy component "${name}" props are ${plain.length} bytes, more than ${MAX_PAYLOAD}; pass ids and load the data in the component`
    )
  }
  const header = Buffer.from([VERSION])
  const iv = nodeCrypto.randomBytes(IV_LENGTH)
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', await secret(odac), iv, {authTagLength: TAG_LENGTH})
  cipher.setAAD(header)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([header, iv, body, cipher.getAuthTag()]).toString('base64url')
}

/**
 * Decrypts and checks a token. Only authenticated data is deserialized.
 * @param {object} odac Request context.
 * @param {*} token Value from the request.
 * @returns {Promise<{name: string, attributes: Array, user: (string|null), lang: (string|null)}|null>}
 *   null when the token is malformed, forged, from another key or expired.
 */
async function open(odac, token) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN || !TOKEN.test(token)) return null
  const raw = Buffer.from(token, 'base64url')
  if (raw.length <= 1 + IV_LENGTH + TAG_LENGTH || raw[0] !== VERSION) return null

  let plain
  try {
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', await secret(odac), raw.subarray(1, 1 + IV_LENGTH), {
      authTagLength: TAG_LENGTH
    })
    decipher.setAAD(raw.subarray(0, 1))
    decipher.setAuthTag(raw.subarray(raw.length - TAG_LENGTH))
    plain = Buffer.concat([decipher.update(raw.subarray(1 + IV_LENGTH, raw.length - TAG_LENGTH)), decipher.final()])
  } catch {
    return null
  }

  let value
  try {
    value = v8.deserialize(plain)
  } catch {
    return null
  }
  if (!Array.isArray(value) || value.length !== 5) return null
  const [name, attributes, bound, lang, issued] = value
  const age = Date.now() - issued
  if (typeof name !== 'string' || !Array.isArray(attributes) || !(age <= MAX_AGE && age >= -CLOCK_SKEW)) return null
  return {name, attributes, user: bound, lang}
}

/**
 * Handles `GET /_odac/lazy?t=<token>`: renders the component a page deferred, as JSON
 * `{html, stacks}`.
 *
 * Why: the custom `X-Odac: lazy` header keeps other sites from triggering the render (a
 * cross-origin request with it needs a CORS preflight, which is never granted), and the token
 * check below means only components a page of this application asked for are rendered.
 * @param {object} Odac Request context of the lazy request.
 * @returns {Promise<object|undefined>} The response body, or undefined after abort().
 */
async function serve(Odac) {
  const Request = Odac.Request
  Request.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  if (Request.header('X-Odac') !== 'lazy') return Request.abort(400)
  const payload = await open(Odac, Request.data?.get?.t)
  if (!payload) return Request.abort(400)
  if (payload.user !== null && payload.user !== user(Odac)) return Request.abort(403)
  if (payload.lang) Odac.Lang?.set?.(payload.lang)
  return Odac.View.lazy(payload)
}

/** Forgets cached keys. Used by tests. */
function reset() {
  derived = null
  generated = null
}

module.exports = {MAX_AGE, MAX_PAYLOAD, open, reset, seal, serve, user}
