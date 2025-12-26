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
      for (let key in where) {
          query = query.orWhere(key, where[key] instanceof Promise ? await where[key] : where[key]) 
      }
      
      // Execute query
      let get = await query
      
      if (!get || get.length === 0) return false
      
      let equal = false
      for (var user of get) {
        equal = Object.keys(where).length > 0
        for (let key of Object.keys(where)) {
          if (where[key] instanceof Promise) where[key] = await where[key]
          if (!user[key]) equal = false
          if (user[key] === where[key]) equal = equal && true
          else if (Odac.Var(user[key]).is('bcrypt')) equal = equal && Odac.Var(user[key]).hashCheck(where[key])
          else if (Odac.Var(user[key]).is('md5')) equal = equal && Odac.Var(where[key]).md5() === user[key]
        }
        if (equal) break
      }
      if (!equal) return false
      return user
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
        } catch(e) { /* ignore if fails, maybe db not up */ }

        // Query token
        let sql_token = await Odac.DB[tokenTable]
            .where('token_x', odac_x)
            .where('browser', browser)
            
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
        if (!this.#user) return false;

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

    let token_y = Odac.Var(Math.random().toString() + Date.now().toString() + this.#request.id + this.#request.ip).md5()
    
    let cookie = {
      user: user[key],
      token_x: Odac.Var(Math.random().toString() + Date.now().toString()).md5(),
      token_y: Odac.Var(token_y).hash(),
      browser: this.#request.header('user-agent'),
      ip: this.#request.ip
    }
    
    this.#request.cookie('odac_x', cookie.token_x, {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict'
    })
    this.#request.cookie('odac_y', token_y, {httpOnly: true, secure: true, sameSite: 'Strict'})
    
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

    if (data[passwordField] && !Odac.Var(data[passwordField]).is('bcrypt')) {
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
        }
      }
    }

    try {
      // Insert returns [id] in mysql/sqlite if standard knex, or result object
      // But we are using a proxy that might not standardise this yet? 
      // Actually standard Knex insert returns:
      // - MySQL: [id] (array with insertId)
      // - PG: [result] if returning used
      
       const insertResult = await Odac.DB[this.#table].insert(data)
       
       // Handle return result (Knex returns array of IDs usually)
       let userId
       if (Array.isArray(insertResult) && insertResult.length > 0) {
           userId = insertResult[0]
       } else if (insertResult && insertResult.insertId) { // mysql2 raw
           userId = insertResult.insertId
       } else {
           // Try to query by unique field if ID not returned
           // Fallback
       }
       
       // If no userId, create fallback query to find user
       // Actually most modern Knex invocations return [id] for auto-increment.
       
       if (!userId) {
           // Fallback: try finding the user we just inserted
           // Not 100% safe but better than failure
            for (const field of uniqueFields) {
               if (data[field]) {
                   const u = await Odac.DB[this.#table].where(field, data[field]).first()
                   if (u) userId = u[primaryKey]
               }
            }
       }
       
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

  async requestMagicLink(email, options = {}) {
     if (!Odac.Config.auth) Odac.Config.auth = {}
     this.#table = Odac.Config.auth.table || 'users'
     const magicTable = Odac.Config.auth.magicTable || 'magic_links'
     
     // Ensure magic table exists
     try {
        await this.#ensureMagicLinkTable(magicTable)
      } catch(e) {
         console.error('Failed to ensure magic link table exists:', e);
         // Consider returning an error here to prevent further execution.
      }
     
     // 1. Check if user exists (or auto-register check if needed, but for now lets assume user must exist)
     // If you want to support auto-register, we'd need more logic here.
     // For security by default: only existing users.
     const user = await Odac.DB[this.#table].where('email', email).first()
     
     // If user doesn't exist and auto-register is NOT enabled, we should probably pretend we sent it
     // to avoid enumeration attacks, or return false. 
     // Let's implement options.autoRegister later if requested.
     if (!user) {
         if (options.autoRegister) {
             // TODO: Implement user auto-registration logic here.
             // For now, return the same generic success message to prevent user enumeration.
             return {success: true, message: 'If this email exists, a link has been sent.'}
         }
         // Fake success to prevent enumeration
         return {success: true, message: 'If this email exists, a link has been sent.'}
     }
     
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
     const link = `${(this.#request.ssl ? 'https://' : 'http://') + this.#request.host}/_odac/magic-verify?token=${tokenRaw}&email=${encodeURIComponent(email)}`
     
     try {
         await Odac.Mail(options.template || 'auth/magic-link')
            .to(email)
            .subject(options.subject || 'Login to our site')
            .send({
                link: link,
                network: this.#request.host,
                ip: this.#request.ip
            })
     } catch(e) {
         console.error('Magic Link Email Error:', e)
         return {success: false, error: 'Failed to send email'}
     }
     
     return {success: true, message: 'Magic link sent!'}
  }
  
  async verifyMagicLink(tokenRaw, email) {
      if (!tokenRaw || !email) return {success: false, error: 'Invalid link'}
      
      const magicTable = Odac.Config.auth?.magicTable || 'magic_links'
      this.#table = Odac.Config.auth?.table || 'users'
      const primaryKey = Odac.Config.auth?.key || 'id'
      
      // 1. Find potential tokens for this email
      const records = await Odac.DB[magicTable]
        .where('email', email)
        .where('expires_at', '>', new Date())
        
      if (!records || records.length === 0) return {success: false, error: 'Link expired or invalid'}
      
      // 2. Find the matching token (verify hash)
      let validRecord = null
      // Iterate through all records without an early exit to mitigate timing attacks.
      for (const record of records) {
          if (Odac.Var(record.token_hash).hashCheck(tokenRaw)) {
              validRecord = record
          }
      }
      
      if (!validRecord) return {success: false, error: 'Invalid token'}
      
      // 3. Consume token (delete)
      await Odac.DB[magicTable].where('id', validRecord.id).delete()
      
      // 4. Log in user
      const user = await Odac.DB[this.#table].where('email', email).first()
      
      if (!user) return {success: false, error: 'User not found'}
      
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

  // --- MAGIC LINK END ---

  // --- MIGRATION HELPERS (Code-First) ---
  
  async #ensureTokenTableV2(tableName) {
      // Using .schema helper
      await Odac.DB[tableName].schema(t => {
          t.increments('id')
          t.integer('user').notNullable()
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
          t.increments(primaryKey)
          
          for (const field of uniqueFields) {
              if (field !== primaryKey) t.string(field).notNullable().unique()
          }
          
          if (!uniqueFields.includes(passwordField) && passwordField !== primaryKey) {
              t.string(passwordField).notNullable()
          }
          
          // Heuristic type guessing from sampleData
          for (const key in sampleData) {
              if (key === primaryKey || uniqueFields.includes(key) || key === passwordField) continue;
              
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

  user(col) {
    if (!this.#user) return false
    if (col === null) return this.#user
    else return this.#user[col]
  }
}

module.exports = Auth
