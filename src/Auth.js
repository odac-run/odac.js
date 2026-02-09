const nodeCrypto = require('crypto')
class Auth {
  #request = null
  #table = null
  #user = null

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
      // Checking for token
      let odac_x = this.#request.cookie('odac_x')
      let odac_y = this.#request.cookie('odac_y')
      let browser = this.#request.header('user-agent')

      if (!odac_x || !odac_y || !browser) return false

      const tokenTable = Odac.Config.auth.token || 'odac_auth'
      const primaryKey = Odac.Config.auth.key || 'id'

      // Code First Migration: Ensure token table exists and clean up old tokens
      try {
        await this.#ensureTokenTableV2(tokenTable)
      } catch (e) {
        console.error('Odac Auth Error: Failed to ensure token table exists:', e.message)
      }

      // Query token
      let sql_token = await Odac.DB[tokenTable].where('token_x', odac_x).where('browser', browser)

      if (!sql_token || sql_token.length !== 1) return false

      if (!Odac.Var(sql_token[0].token_y).hashCheck(odac_y)) return false

      const maxAge = Odac.Config.auth?.maxAge || 30 * 24 * 60 * 60 * 1000
      const updateAge = Odac.Config.auth?.updateAge || 24 * 60 * 60 * 1000
      const now = Date.now()

      // Active comes as Date object usually from drivers
      const lastActive = new Date(sql_token[0].active).getTime()
      const inactiveAge = now - lastActive

      if (inactiveAge > maxAge) {
        await Odac.DB[tokenTable].where('id', sql_token[0].id).delete()
        return false
      }

      this.#user = await Odac.DB[this.#table].where(primaryKey, sql_token[0].user).first()
      if (!this.#user) return false

      if (inactiveAge > updateAge) {
        // Use update instead of set for Knex
        Odac.DB[tokenTable]
          .where('id', sql_token[0].id)
          .update({active: new Date()}) // knex uses .update
          .catch(() => {})
      }

      return true
    }
  }

  async login(where) {
    this.#user = null
    let user = await this.check(where)
    if (!user) return false

    if (!Odac.Config.auth) Odac.Config.auth = {}
    let key = Odac.Config.auth.key || 'id'
    let token = Odac.Config.auth.token || 'odac_auth'

    await this.#ensureTokenTableV2(token)

    this.#cleanupExpiredTokens(token)

    // Generate secure token using generic CSPRNG (Cryptographically Secure Pseudo-Random Number Generator)
    // Why: Math.random() is predictable and MD5 is a broken hashing algorithm.
    // We use 32 bytes (256 bits) of entropy which is industry standard.
    let token_y = nodeCrypto.randomBytes(32).toString('hex')

    let cookie = {
      id: Odac.DB.nanoid(),
      user: user[key],
      token_x: nodeCrypto.randomBytes(32).toString('hex'),
      token_y: Odac.Var(token_y).hash(),
      browser: this.#request.header('user-agent'),
      ip: this.#request.ip
    }

    this.#request.cookie('odac_x', cookie.token_x, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    })
    this.#request.cookie('odac_y', token_y, {httpOnly: true, secure: true, sameSite: 'Lax'})

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
      await this.#ensureUserTableV2(this.#table, primaryKey, passwordField, uniqueFields, data)
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
    const token = Odac.Config.auth.token || 'user_tokens'
    const odacX = this.#request.cookie('odac_x')
    const browser = this.#request.header('user-agent')

    if (odacX && browser) {
      await Odac.DB[token].where('token_x', odacX).where('browser', browser).delete()
    }

    this.#request.cookie('odac_x', '', {maxAge: -1})
    this.#request.cookie('odac_y', '', {maxAge: -1})

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
      await this.#ensureMagicLinkTable(magicTable)
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
    }

    // Login logic similar to login()
    const loginData = {}
    loginData[primaryKey] = user[primaryKey]
    await this.login(loginData)

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
    // Using .schema helper
    await Odac.DB[tableName].schema(t => {
      t.string('id', 21).primary()
      t.string('user', 21).notNullable()
      t.string('token_x').notNullable()
      t.string('token_y').notNullable()
      t.string('browser').notNullable()
      t.string('ip').notNullable()
      t.timestamp('date').defaultTo(Odac.DB.fn.now())
      t.timestamp('active').defaultTo(Odac.DB.fn.now())
    })
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
