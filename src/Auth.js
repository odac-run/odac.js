const nodeCrypto = require('crypto')
const ROTATED_TOKEN_EPOCH_THRESHOLD_MS = 31536000000
// Window after rotation during which the old token can still recover a lost
// rotation response (one-shot). Shorter = smaller replay surface; too short
// breaks legitimate retries on flaky mobile networks (stall + retry ≈ 10-20s).
const TOKEN_ROTATION_GRACE_PERIOD_MS = 30 * 1000
const TOKEN_SWEEP_INTERVAL_MS = 60 * 60 * 1000
const TOKEN_SWEEP_BOOT_DELAY_MS = 5 * 60 * 1000
class Auth {
  #request = null
  #table = null
  #token = null
  // True once the cookie-token lookup ran for this request. Cookies are
  // immutable for a request's lifetime, so a failed lookup cannot change
  // outcome and must not be repeated at every check() call site.
  #tokenChecked = false
  #user = null
  static #migrationCache = new Set()
  // First sweep fires ~5 minutes after boot, then once per interval, driven by
  // live traffic. The boot delay keeps short-lived processes (tests, scripts)
  // from sweeping, while frequently-restarted servers (dev sync) still get a
  // sweep instead of resetting a full interval on every restart.
  static #lastTokenSweep = Date.now() - TOKEN_SWEEP_INTERVAL_MS + TOKEN_SWEEP_BOOT_DELAY_MS

  constructor(request) {
    this.#request = request
  }

  #validateInput(where) {
    if (!where || typeof where !== 'object') return false
    for (const key in where) {
      const value = where[key]
      if (value instanceof Promise) continue
      if (typeof value !== 'string' && typeof value !== 'number') return false
    }
    return true
  }

  async check(where) {
    if (!Odac.Config.auth) Odac.Config.auth = {}
    this.#table = Odac.Config.auth.table || 'users'
    if (!this.#table) return false
    if (where) {
      if (!this.#validateInput(where)) return false

      // Using new DB API
      let query = Odac.DB[this.#table]

      if (!query) {
        console.error('Odac Auth Error: Database not configured.')
        return false
      }

      // Knex build queries differently than previous builder
      // Need to chain where clauses
      // Resolve input promises upfront to avoid side effects and race conditions
      const criteria = {}
      const keys = Object.keys(where)

      if (keys.length === 0) return false

      for (const key of keys) {
        criteria[key] = where[key] instanceof Promise ? await where[key] : where[key]
      }

      // Chain where clauses
      for (const key in criteria) {
        query = query.orWhere(key, criteria[key])
      }

      // Execute query
      const candidates = await query

      if (!candidates || candidates.length === 0) return false

      // Iterate candidates to find the exact match
      candidateLoop: for (const user of candidates) {
        for (const key of keys) {
          const userValue = user[key]
          const targetValue = criteria[key]

          if (!userValue) continue candidateLoop

          // Strict equality check
          if (userValue === targetValue) continue

          // Security: Check hashed fields (Bcrypt/MD5)
          const valueHandler = Odac.Var(userValue)
          let hashMatch = false

          if (valueHandler.is('hash')) {
            hashMatch = valueHandler.hashCheck(targetValue)
          } else if (valueHandler.is('md5')) {
            hashMatch = Odac.Var(targetValue).md5() === userValue
          }

          if (!hashMatch) continue candidateLoop
        }

        return user
      }

      return false
    } else if (this.#user) {
      return true
    } else {
      // Negative cache: a failed token lookup is final for this request.
      // (A mid-request login sets #user, which the branch above serves.)
      if (this.#tokenChecked) return false
      this.#tokenChecked = true

      // Checking for token
      let odac_x = this.#request.cookie('odac_x')
      let odac_y = this.#request.cookie('odac_y')
      let browser = this.#request.header('user-agent')

      if (!odac_x || !odac_y || !browser) return false

      const tokenTable = Odac.Config.auth.token || 'odac_auth'
      const primaryKey = Odac.Config.auth.key || 'id'

      // Code First Migration: Ensure token table exists and clean up old tokens
      try {
        if (!Auth.#migrationCache.has(tokenTable)) {
          await this.#ensureTokenTableV2(tokenTable)
          Auth.#migrationCache.add(tokenTable)
        }
      } catch (e) {
        console.error('Odac Auth Error: Failed to ensure token table exists:', e.message)
      }

      // Query token by its unique public identifier only.
      // User-Agent is validated as a heuristic signal below (see #detectAnomaly),
      // not as a hard WHERE key, so that a legitimate browser update doesn't
      // silently orphan the row.
      let sql_token = await Odac.DB[tokenTable].where('token_x', odac_x)

      if (!sql_token || sql_token.length !== 1) return false

      // Verify the secret. New tokens are SHA-256 (fast, high-entropy);
      // legacy scrypt tokens are still accepted and upgraded on next rotation.
      if (!this.#verifyToken(sql_token[0].token_y, odac_y)) return false

      // Session hijack / stale-session heuristics.
      // On a strong anomaly (OS/browser change, version downgrade or implausible
      // jump, or a moved IP paired with a UA/language mismatch) drop the token.
      const acceptLanguage = this.#request.header('accept-language')
      const anomaly = this.#detectAnomaly(sql_token[0], browser, this.#request.ip, acceptLanguage)
      if (anomaly) {
        await Odac.DB[tokenTable].where('id', sql_token[0].id).delete()
        return false
      }

      // In-place hash upgrade: once a legacy scrypt token verifies, rehash the
      // same secret with SHA-256 so every subsequent request skips the
      // expensive scrypt path — including setups where rotation never fires
      // (rotation disabled, WebSocket-only clients). The cookie value is
      // unchanged, so no new cookies are needed.
      if (sql_token[0].token_y.startsWith('$scrypt$')) {
        Odac.DB[tokenTable]
          .where('id', sql_token[0].id)
          .update({token_y: this.#hashToken(odac_y)})
          .catch(() => {})
      }

      // One-time backfill for rows created before the accept_language column
      // existed, so the IP+language rule gains its baseline without waiting
      // for a rotation or activity update.
      if (sql_token[0].accept_language == null && acceptLanguage) {
        Odac.DB[tokenTable]
          .where('id', sql_token[0].id)
          .update({accept_language: acceptLanguage})
          .catch(() => {})
      }

      const maxAge = Odac.Config.auth?.maxAge || 30 * 24 * 60 * 60 * 1000
      const updateAge = Odac.Config.auth?.updateAge || 24 * 60 * 60 * 1000
      const rotationAge = Odac.Config.auth?.rotationAge || 15 * 60 * 1000 // Default 15 mins for rotation
      const rotationGrace = Odac.Config.auth?.rotationGrace || TOKEN_ROTATION_GRACE_PERIOD_MS
      const shouldRotate = Odac.Config.auth?.rotation !== false // Allow disabling rotation
      const now = Date.now()

      // Active comes as Date object usually from drivers
      const lastActive = new Date(sql_token[0].active).getTime()
      const tokenDate = new Date(sql_token[0].date).getTime()
      const inactiveAge = now - lastActive
      const tokenAge = now - tokenDate

      // If date is before 1971, it's a marker for a rotated (grace period) token
      const isRotated = tokenDate < ROTATED_TOKEN_EPOCH_THRESHOLD_MS

      if (inactiveAge > maxAge) {
        // Naturally cleans up expired tokens and rotated tokens after grace period
        await Odac.DB[tokenTable].where('id', sql_token[0].id).delete()
        return false
      }

      this.#user = await Odac.DB[this.#table].where(primaryKey, sql_token[0].user).first()
      if (!this.#user) return false

      this.#token = sql_token[0]

      // Periodic sweep of expired tokens and rotated (grace-elapsed) epoch-marker
      // rows, driven by live traffic. Why: cleanup used to run only on login(),
      // but token-based sessions rarely log in again, so rotation leftovers
      // accumulated indefinitely.
      const sweepInterval = Odac.Config.auth?.sweepInterval || TOKEN_SWEEP_INTERVAL_MS
      if (now - Auth.#lastTokenSweep > sweepInterval) {
        Auth.#lastTokenSweep = now
        this.#cleanupExpiredTokens(tokenTable)
      }

      let triggerRotation = false
      let isRecoveryRotation = false

      // WebSocket connections (res === null) cannot deliver Set-Cookie headers.
      // Rotating a token during a WS upgrade would invalidate the browser's cookies
      // with no way to deliver replacements, causing silent logout on the next HTTP request.
      const canDeliverCookies = !!this.#request.res

      if (!isRotated) {
        if (shouldRotate && tokenAge > rotationAge) {
          if (canDeliverCookies) {
            triggerRotation = true
          } else {
            // WebSocket: Can't deliver rotated cookies, refresh active timestamp instead
            Odac.DB[tokenTable]
              .where('id', sql_token[0].id)
              .update(this.#activityRefresh(sql_token[0], browser, acceptLanguage))
              .catch(() => {})
          }
        } else if (inactiveAge > updateAge) {
          // Fallback active update if rotation is not triggered; also refreshes
          // the client baseline (see #activityRefresh)
          Odac.DB[tokenTable]
            .where('id', sql_token[0].id)
            .update(this.#activityRefresh(sql_token[0], browser, acceptLanguage))
            .catch(() => {})
        }
      } else {
        // Client still presenting a rotated (grace period) token.
        // This means the previous rotation response was lost (network hiccup, page navigation, etc.)
        // Give the client one more chance by re-issuing new credentials.
        const timeSinceRotation = inactiveAge - maxAge + rotationGrace
        if (timeSinceRotation > 5000 && canDeliverCookies) {
          triggerRotation = true
          isRecoveryRotation = true
        }
      }

      if (triggerRotation) {
        // --- Token Rotation ---
        const newTokenX = nodeCrypto.randomBytes(32).toString('hex')
        const newTokenY = nodeCrypto.randomBytes(32).toString('hex')
        const newToken = {
          id: Odac.DB.nanoid(),
          user: sql_token[0].user,
          token_x: newTokenX,
          token_y: this.#hashToken(newTokenY),
          // Refresh the client fingerprint baseline on each rotation so that
          // legitimate gradual drift (e.g. version bumps) stays tracked and
          // doesn't accumulate into a false "version jump" later.
          browser: this.#request.header('user-agent') || sql_token[0].browser,
          accept_language: this.#request.header('accept-language') || sql_token[0].accept_language,
          ip: this.#request.ip,
          date: new Date(),
          active: new Date()
        }

        // 1. Persist new token (await to ensure it exists before client uses new cookies)
        const insertOk = await Odac.DB[tokenTable].insert(newToken).catch(e => {
          console.error('Odac Auth Error: Token rotation failed', e.message)
          return false
        })

        if (insertOk !== false) {
          if (!isRecoveryRotation) {
            // 2a. Normal rotation: Mark old token as rotated with 60s grace period
            // Non-blocking I/O (Fire & Forget) -> High Throughput
            const rotatedActiveDate = new Date(now - maxAge + rotationGrace)
            const epochDate = new Date(0)

            Odac.DB[tokenTable]
              .where('id', sql_token[0].id)
              .update({
                active: rotatedActiveDate,
                date: epochDate
              })
              .catch(() => {})
          } else {
            // 2b. Recovery rotation: Delete old rotated token immediately.
            // Why: Prevents unbounded token multiplication. The old token already
            // had its grace period; one recovery attempt is the maximum.
            Odac.DB[tokenTable]
              .where('id', sql_token[0].id)
              .delete()
              .catch(() => {})
          }

          // 3. Issue new cookies immediately
          this.#request.cookie('odac_x', newTokenX, {
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
            'max-age': Math.floor(maxAge / 1000)
          })
          this.#request.cookie('odac_y', newTokenY, {
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
            'max-age': Math.floor(maxAge / 1000)
          })
        }
      }

      return true
    }
  }

  async login(where) {
    this.#user = null
    let user = await this.check(where)
    if (!user) return false

    let key = Odac.Config.auth.key || 'id'
    let token = Odac.Config.auth.token || 'odac_auth'

    if (!Auth.#migrationCache.has(token)) {
      await this.#ensureTokenTableV2(token)
      Auth.#migrationCache.add(token)
    }

    this.#cleanupExpiredTokens(token)

    // Generate secure token using generic CSPRNG (Cryptographically Secure Pseudo-Random Number Generator)
    // Why: Math.random() is predictable and MD5 is a broken hashing algorithm.
    // We use 32 bytes (256 bits) of entropy which is industry standard.
    let token_y = nodeCrypto.randomBytes(32).toString('hex')

    let cookie = {
      id: Odac.DB.nanoid(),
      user: user[key],
      token_x: nodeCrypto.randomBytes(32).toString('hex'),
      token_y: this.#hashToken(token_y),
      browser: this.#request.header('user-agent'),
      accept_language: this.#request.header('accept-language'),
      ip: this.#request.ip
    }

    const maxAge = Odac.Config.auth?.maxAge || 30 * 24 * 60 * 60 * 1000

    this.#request.cookie('odac_x', cookie.token_x, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      'max-age': Math.floor(maxAge / 1000)
    })
    this.#request.cookie('odac_y', token_y, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      'max-age': Math.floor(maxAge / 1000)
    })

    // Knex insert returns ids on some dbs, promise resolves to result
    const result = await Odac.DB[token].insert(cookie)
    return !!result
  }

  async #cleanupExpiredTokens(tokenTable) {
    const maxAge = Odac.Config.auth?.maxAge || 30 * 24 * 60 * 60 * 1000
    // Knex handles dates well, but better to pass JS Date object
    const cutoffDate = new Date(Date.now() - maxAge)

    Odac.DB[tokenTable]
      .where('active', '<', cutoffDate)
      .delete()
      .catch(() => {})
  }

  async register(data, options = {}) {
    if (!Odac.Config.auth) {
      Odac.Config.auth = {}
    }

    this.#table = Odac.Config.auth.table || 'users'
    const primaryKey = Odac.Config.auth.key || 'id'
    const passwordField = options.passwordField || 'password'
    const uniqueFields = options.uniqueFields || ['email']

    try {
      if (!Auth.#migrationCache.has(this.#table)) {
        await this.#ensureUserTableV2(this.#table, primaryKey, passwordField, uniqueFields, data)
        Auth.#migrationCache.add(this.#table)
      }
    } catch (e) {
      // If DB not configured or connection failed
      console.error('Odac Auth Error:', e.message)
      return {success: false, error: 'Database connection failed'}
    }

    if (!data || typeof data !== 'object') {
      return {success: false, error: 'Invalid data provided'}
    }

    if (data[passwordField] && !Odac.Var(data[passwordField]).is('hash')) {
      data[passwordField] = Odac.Var(data[passwordField]).hash()
    }

    // Check unique fields
    for (const field of uniqueFields) {
      if (data[field]) {
        try {
          const existing = await Odac.DB[this.#table].where(field, data[field]).first()
          if (existing) {
            return {success: false, error: `${field} already exists`, field}
          }
        } catch (e) {
          console.error('Odac Auth Error checking unique:', e.message)
          return {success: false, error: 'A database error occurred during registration.'}
        }
      }
    }

    // Auto-detect ID strategy (NanoID vs Auto-Increment)
    let shouldGenerateId = true

    // 1. Check User Config Preference
    if (Odac.Config.auth.idType === 'int' || Odac.Config.auth.idType === 'auto') shouldGenerateId = false
    else if (Odac.Config.auth.idType === 'string' || Odac.Config.auth.idType === 'nanoid') shouldGenerateId = true
    else {
      // 2. Detect from Database Schema (and Cache it)
      if (!Odac.Config.auth._viewedPkType) {
        try {
          // Determine column type of primary key
          const colInfo = await Odac.DB[this.#table].columnInfo(primaryKey)
          const type = colInfo?.type ? colInfo.type.toLowerCase() : 'string'

          // Common integer types in various SQL dialects
          if (type.includes('int') || type.includes('serial') || type.includes('number')) {
            Odac.Config.auth._viewedPkType = 'int'
          } else {
            Odac.Config.auth._viewedPkType = 'string'
          }
        } catch {
          // If table doesn't exist yet or error, default to string (NanoID) as per our new standard
          Odac.Config.auth._viewedPkType = 'string'
        }
      }

      if (Odac.Config.auth._viewedPkType === 'int') shouldGenerateId = false
    }

    try {
      if (shouldGenerateId && !data[primaryKey]) {
        data[primaryKey] = Odac.DB.nanoid()
      }

      await Odac.DB[this.#table].insert(data)

      let userId = data[primaryKey]

      if (!userId) {
        console.error('Odac Auth Error: Could not determine new user ID')
        return {success: false, error: 'Failed to create user'}
      }

      const newUser = await Odac.DB[this.#table].where(primaryKey, userId).first()

      if (!newUser) {
        return {success: false, error: 'User created but could not be retrieved'}
      }

      delete newUser[passwordField]

      if (options.autoLogin !== false) {
        const loginData = {}
        loginData[primaryKey] = userId
        const loginSuccess = await this.login(loginData)

        if (!loginSuccess) {
          return {success: true, user: newUser, autoLogin: false, message: 'User created but auto-login failed'}
        }
      }

      return {success: true, user: newUser}
    } catch (error) {
      console.error('Odac Auth Error: Registration failed with exception')
      console.error('Error:', error.message)
      return {success: false, error: error.message || 'Registration failed'}
    }
  }

  async logout() {
    if (!this.#user) return false

    if (!Odac.Config.auth) Odac.Config.auth = {}
    const tokenTable = Odac.Config.auth.token || 'user_tokens'
    const primaryKey = Odac.Config.auth.key || 'id'
    const odacX = this.#request.cookie('odac_x')
    const browser = this.#request.header('user-agent')

    if (odacX && browser) {
      // Delete current token AND any rotated grace-period tokens for this user+browser
      // Why: After rotation, the old token stays alive for the grace period. Explicit logout must kill it too.
      const userId = this.#user[primaryKey]
      await Odac.DB[tokenTable].where('user', userId).where('browser', browser).delete()
    }

    this.#request.cookie('odac_x', '', {'max-age': -1})
    this.#request.cookie('odac_y', '', {'max-age': -1})

    this.#token = null
    this.#user = null
    return true
  }

  // --- MAGIC LINK START ---

  async magic(email, options = {}) {
    if (!Odac.Config.auth) Odac.Config.auth = {}
    this.#table = Odac.Config.auth.table || 'users'
    const magicTable = Odac.Config.auth.magicTable || 'odac_magic'

    // Ensure magic table exists
    try {
      if (!Auth.#migrationCache.has(magicTable)) {
        await this.#ensureMagicLinkTable(magicTable)
        Auth.#migrationCache.add(magicTable)
      }
    } catch (e) {
      console.error('Failed to ensure magic link table exists:', e)
      // Consider returning an error here to prevent further execution.
    }

    // Rate limiting: Check recent requests from this IP and email
    // Magic link requires only email input, so rate limits should be very strict
    const rateLimitWindow = Odac.Config.auth?.magicLinkRateLimit || 60 * 60 * 1000 // 1 hour default
    const maxAttempts = Odac.Config.auth?.magicLinkMaxAttempts || 2 // Per email - very strict
    const maxAttemptsPerIP = Odac.Config.auth?.magicLinkMaxAttemptsPerIP || 5 // Per IP
    const sessionCooldown = Odac.Config.auth?.magicLinkSessionCooldown || 30 * 1000 // 30 seconds default

    // 1. Session Rate Limit (Fastest, no DB access)
    const lastRequestTime = this.#request.session('magic_last_request')
    if (lastRequestTime && Date.now() - lastRequestTime < sessionCooldown) {
      const remaining = Math.ceil((sessionCooldown - (Date.now() - lastRequestTime)) / 1000)
      return {success: false, error: `Please wait ${remaining} seconds before requesting another link.`}
    }
    this.#request.session('magic_last_request', Date.now())

    try {
      // 2. Database Rate Limits
      // Check email-based rate limit
      const recentEmailRequests = await Odac.DB[magicTable]
        .where('email', email)
        .where('created_at', '>', new Date(Date.now() - rateLimitWindow))

      if (recentEmailRequests && recentEmailRequests.length >= maxAttempts) {
        return {success: false, error: 'Too many login attempts. Please wait a while before trying again.'}
      }

      // Check IP-based rate limit (prevents mass enumeration attacks)
      const clientIP = this.#request.ip
      const recentIPRequests = await Odac.DB[magicTable]
        .where('ip', clientIP)
        .where('created_at', '>', new Date(Date.now() - rateLimitWindow))

      if (recentIPRequests && recentIPRequests.length >= maxAttemptsPerIP) {
        return {success: false, error: 'Too many requests from this IP. Please wait a while.'}
      }
    } catch {
      // Ignore rate limit check errors, proceed with request
    }

    // Cleanup: Remove expired tokens periodically
    this.#cleanupExpiredMagicLinks(magicTable)

    // 1. Check if user exists.
    // We proceed regardless of whether the user exists or not.
    // If they exist, it's a login. If not, it will accept the link and Auto-Register them (Passwordless Signup).
    // let user = null
    try {
      // Check if user exists (logic preserved but unused 'user' variable issue fixed)
      const existingUser = await Odac.DB[this.#table].where('email', email).first()
      if (existingUser) {
        /* user exists */
      }
    } catch (e) {
      // Ignore table not found error, treat as user not found
      if (e.code !== '42P01' && !e.message.includes('no such table')) {
        throw e
      }
    }

    // If user doesn't exist, we still proceed to send the link to allow for "Sign Up via Magic Link" (Passwordless Signup)
    // The user will be created upon verification.

    // 2. Generate secure token
    const tokenRaw = nodeCrypto.randomBytes(32).toString('hex')
    const tokenHash = Odac.Var(tokenRaw).hash() // Hash it for DB storage

    // 3. Save to DB
    await Odac.DB[magicTable].insert({
      email: email,
      token_hash: tokenHash,
      ip: this.#request.ip,
      browser: this.#request.header('user-agent'),
      expires_at: new Date(Date.now() + 15 * 60 * 1000) // 15 mins
    })

    // 4. Send Email
    let link = `${(this.#request.ssl ? 'https://' : 'http://') + this.#request.host}/_odac/magic-verify?token=${tokenRaw}&email=${encodeURIComponent(email)}`
    if (options.redirect) link += `&redirect_url=${encodeURIComponent(options.redirect)}`

    try {
      let mail = Odac.Mail(options.template || 'auth/magic-link')
        .to(email)
        .subject(options.subject || 'Login to our site')

      if (options.from) {
        if (typeof options.from === 'object') mail.from(options.from.email, options.from.name)
        else mail.from(options.from)
      }

      await mail.send({
        link: link,
        magic_link: link,
        network: this.#request.host,
        ip: this.#request.ip
      })
    } catch (e) {
      console.error('Magic Link Email Error:', e)
      return {success: false, error: 'Failed to send email'}
    }

    return {success: true, message: 'Magic link sent!'}
  }

  async verifyMagicLink(tokenRaw, email) {
    if (!tokenRaw || !email) {
      return {success: false, error: 'Invalid link'}
    }

    const magicTable = Odac.Config.auth?.magicTable || 'odac_magic'
    this.#table = Odac.Config.auth?.table || 'users'
    const primaryKey = Odac.Config.auth?.key || 'id'

    // 1. Find potential tokens for this email
    const records = await Odac.DB[magicTable].where('email', email).where('expires_at', '>', new Date())

    if (!records || records.length === 0) {
      return {success: false, error: 'Link expired or invalid'}
    }

    // 2. Find the matching token (verify hash)
    let validRecord = null
    // Iterate through all records without an early exit to mitigate timing attacks.
    for (const record of records) {
      if (Odac.Var(record.token_hash).hashCheck(tokenRaw)) {
        validRecord = record
      }
    }

    if (!validRecord) {
      return {success: false, error: 'Invalid token'}
    }

    // 3. Consume all tokens for this email to prevent reuse of other valid links.
    await Odac.DB[magicTable].where('email', email).delete()

    // 4. Log in user (or Register if new)
    let user = await Odac.DB[this.#table].where('email', email).first()
    let alreadyLoggedIn = false

    if (!user) {
      // Auto-Register the user

      const passwordField = Odac.Config.auth?.passwordField || 'password'
      // Optimization: If explicitly configured as passwordless, skip password generation overhead
      const isPasswordless = Odac.Config.auth?.passwordless === true

      const registerData = {
        email: email
      }

      if (!isPasswordless) {
        // Generate a random high-entropy password since they are using passwordless auth but DB might require password
        registerData[passwordField] = nodeCrypto.randomBytes(32).toString('hex')
      }

      let regResult = await this.register(registerData)

      // Fallback: If we tried to be secure (sent password) but DB failed because column doesn't exist, retry without password
      if (
        !isPasswordless &&
        !regResult.success &&
        regResult.error &&
        (regResult.error.includes(`column "${passwordField}"`) || regResult.error.includes(`Unknown column '${passwordField}'`)) &&
        (regResult.error.includes('does not exist') || regResult.error.includes('field list'))
      ) {
        regResult = await this.register({
          email: email
        })
      }

      if (!regResult.success) {
        return {success: false, error: 'Registration failed: ' + regResult.error}
      }

      user = regResult.user
      // register() already performs auto-login by default, skip duplicate login
      alreadyLoggedIn = regResult.autoLogin !== false
    }

    if (!alreadyLoggedIn) {
      const loginData = {}
      loginData[primaryKey] = user[primaryKey]
      await this.login(loginData)
    }

    return {success: true, user: user}
  }

  async #ensureMagicLinkTable(tableName) {
    await Odac.DB[tableName].schema(t => {
      t.increments('id')
      t.string('email').notNullable().index()
      t.string('token_hash').notNullable()
      t.string('ip')
      t.string('browser')
      t.timestamp('created_at').defaultTo(Odac.DB.fn.now())
      t.timestamp('expires_at')
    })
  }

  #cleanupExpiredMagicLinks(tableName) {
    // Run cleanup asynchronously without awaiting (fire and forget)
    Odac.DB[tableName]
      .where('expires_at', '<', new Date())
      .delete()
      .catch(() => {}) // Silently ignore cleanup errors
  }

  // --- MAGIC LINK END ---

  // --- MIGRATION HELPERS (Code-First) ---

  async #ensureTokenTableV2(tableName) {
    const exists = await Odac.DB.schema.hasTable(tableName)

    if (!exists) {
      await Odac.DB.schema.createTable(tableName, t => {
        t.string('id', 21).primary()
        t.string('user', 21).notNullable()
        t.string('token_x').notNullable().index() // hot-path lookup key
        t.string('token_y').notNullable()
        t.string('browser').notNullable()
        t.string('accept_language')
        t.string('ip').notNullable()
        t.timestamp('date').defaultTo(Odac.DB.fn.now())
        t.timestamp('active').defaultTo(Odac.DB.fn.now()).index() // sweep range scans
      })
      return
    }

    // Migrate existing token tables. .schema()/createTable are no-ops once the
    // table exists, so column and index additions must be applied explicitly.
    try {
      if (!(await Odac.DB.schema.hasColumn(tableName, 'accept_language'))) {
        await Odac.DB.schema.alterTable(tableName, t => {
          t.string('accept_language')
        })
      }
    } catch (e) {
      console.error('Odac Auth Error: Failed to add accept_language column:', e.message)
    }

    // Ensure token_x is indexed for the per-request lookup. Adding a duplicate
    // index throws on most drivers, so a failure here means it already exists.
    try {
      await Odac.DB.schema.alterTable(tableName, t => {
        t.index('token_x')
      })
    } catch {
      /* index already present */
    }

    // Ensure active is indexed for the periodic expired-token sweep, which
    // range-scans on it. Applied separately so one existing index doesn't
    // block the other from being created.
    try {
      await Odac.DB.schema.alterTable(tableName, t => {
        t.index('active')
      })
    } catch {
      /* index already present */
    }
  }

  async #ensureUserTableV2(tableName, primaryKey, passwordField, uniqueFields, sampleData) {
    await Odac.DB[tableName].schema(t => {
      t.string(primaryKey, 21).primary()

      for (const field of uniqueFields) {
        if (field !== primaryKey) t.string(field).notNullable().unique()
      }

      if (!uniqueFields.includes(passwordField) && passwordField !== primaryKey) {
        t.string(passwordField).notNullable()
      }

      // Heuristic type guessing from sampleData
      for (const key in sampleData) {
        if (key === primaryKey || uniqueFields.includes(key) || key === passwordField) continue

        const val = sampleData[key]
        if (typeof val === 'number') {
          if (Number.isInteger(val)) t.integer(key)
          else t.float(key)
        } else if (typeof val === 'boolean') {
          t.boolean(key)
        } else {
          t.string(key)
        }
      }

      t.timestamps(true, true) // created_at, updated_at
    })
  }

  // --- TOKEN HASHING ---

  // token_x/token_y are 256-bit CSPRNG values, so they are infeasible to brute-force.
  // A slow password hash (scrypt/bcrypt) is therefore unnecessary here, and its
  // per-request cost is significant at scale — a plain SHA-256 is cryptographically
  // sufficient for high-entropy secrets and ~1000x cheaper on the hot auth path.
  #hashToken(value) {
    return '$sha256$' + nodeCrypto.createHash('sha256').update(String(value)).digest('hex')
  }

  #verifyToken(stored, provided) {
    if (typeof stored !== 'string' || !provided) return false

    if (stored.startsWith('$sha256$')) {
      const expected = Buffer.from(stored.slice(8), 'hex')
      const actual = nodeCrypto.createHash('sha256').update(String(provided)).digest()
      if (expected.length !== actual.length) return false
      return nodeCrypto.timingSafeEqual(expected, actual)
    }

    // Backward compatibility: legacy scrypt tokens. Rehashed in place to
    // SHA-256 immediately after the first successful verification (see check()).
    if (stored.startsWith('$scrypt$')) {
      return Odac.Var(stored).hashCheck(provided)
    }

    return false
  }

  // --- SESSION ANOMALY DETECTION ---

  // Extracts a coarse, version-agnostic fingerprint from a User-Agent string:
  // browser family, OS family and *major* browser version only, so that routine
  // minor updates don't churn the stored baseline.
  #parseUA(ua) {
    ua = ua || ''

    // iOS variants (CriOS/FxiOS/EdgiOS) identify the same browser families.
    const browser = /Edg(iOS)?\//.test(ua)
      ? 'Edge'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /(Firefox|FxiOS)\//.test(ua)
          ? 'Firefox'
          : /(Chrome|CriOS)\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Other'

    const os = /Windows/.test(ua)
      ? 'Windows'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPad|iPod/.test(ua)
            ? 'iOS'
            : /Linux|X11/.test(ua)
              ? 'Linux'
              : 'Other'

    const pattern =
      browser === 'Edge'
        ? /Edg(?:iOS)?\/(\d+)/
        : browser === 'Opera'
          ? /OPR\/(\d+)/
          : browser === 'Firefox'
            ? /(?:Firefox|FxiOS)\/(\d+)/
            : browser === 'Chrome'
              ? /(?:Chrome|CriOS)\/(\d+)/
              : browser === 'Safari'
                ? /Version\/(\d+)/
                : null

    const match = pattern ? ua.match(pattern) : null
    const version = match ? parseInt(match[1], 10) || 0 : 0

    return {browser, os, version}
  }

  // Returns a short reason string when the presented request is anomalous enough
  // to invalidate the token, or null when it should be accepted.
  #detectAnomaly(token, currentUA, currentIP, currentLang) {
    const storedUA = token.browser || ''
    const prev = this.#parseUA(storedUA)
    const cur = this.#parseUA(currentUA)

    // Under the same cookie jar the OS and browser family cannot legitimately change.
    if (prev.os !== cur.os) return 'os_change'
    if (prev.browser !== cur.browser) return 'browser_change'

    // A browser version downgrade, or an implausibly large jump for the elapsed
    // idle time (a long absence justifies proportionally larger jumps).
    if (cur.version < prev.version) return 'version_downgrade'

    const lastActive = new Date(token.active).getTime()
    const monthsInactive = Number.isFinite(lastActive) ? Math.max(0, (Date.now() - lastActive) / 2592000000) : 0
    const allowedJump = 3 + monthsInactive * 2
    if (cur.version - prev.version > allowedJump) return 'version_jump'

    // IP-change-gated signals: a moved network paired with any other client
    // change is treated as suspicious.
    const ipChanged = !!token.ip && !!currentIP && token.ip !== currentIP
    if (ipChanged) {
      if (storedUA !== currentUA) return 'ip_ua_mismatch'
      // Rows from before the accept_language column existed have no baseline;
      // the rule activates once it is backfilled.
      if (token.accept_language != null && (currentLang || '') !== token.accept_language) return 'ip_lang_mismatch'
    }

    return null
  }

  // Builds the payload for activity-timestamp updates, refreshing the stored
  // client baseline (UA / language) alongside it. Without this, tokens that
  // never rotate (rotation disabled, WebSocket-only clients) keep their
  // login-day fingerprint forever and legitimate gradual drift eventually
  // accumulates into a false version_jump.
  #activityRefresh(token, currentUA, currentLang) {
    const payload = {active: new Date()}
    if (currentUA && currentUA !== token.browser) payload.browser = currentUA
    if (currentLang && currentLang !== token.accept_language) payload.accept_language = currentLang
    return payload
  }

  /**
   * Retrieves the active auth token record or a specific column from it.
   * Why: To provide access to the current session's token metadata (e.g., auth ID, IP, date).
   *
   * @param {string|null} [col=null] - The column to retrieve, or null for the full token object.
   * @returns {object|string|number|boolean|false} The token object, column value, or false if no active session.
   */
  token(col = null) {
    if (!this.#token) return false
    if (col === null) return this.#token
    return this.#token[col]
  }

  /**
   * Retrieves the authenticated user or a specific column.
   * Why: To provide access to the current user's session data securely.
   *
   * @param {string|null} [col=null] - The column to retrieve, or null for the full user object.
   * @returns {object|string|number|boolean|false} The user object, column value, or false if not logged in.
   */
  user(col = null) {
    if (!this.#user) return false
    if (col === null) return this.#user
    return this.#user[col]
  }
}

module.exports = Auth
