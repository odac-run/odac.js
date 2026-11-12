const nodeCrypto = require('crypto')

// Placeholder origin used to resolve a redirect target exactly the way a browser would.
const REDIRECT_BASE = 'http://odac.invalid'

/**
 * Returns `target` when it is a same-site absolute path, otherwise '/'.
 * Why: prefix checks missed inputs the WHATWG URL parser rewrites: it drops tabs and
 * newlines anywhere ('/\t/evil' becomes '//evil') and treats '\' as '/'. Resolving with the
 * same parser browsers use and comparing origins rejects every protocol-relative variant.
 * @param {*} target Redirect target from the request or config.
 * @returns {string}
 */
function sameSitePath(target) {
  if (typeof target !== 'string' || !target.startsWith('/')) return '/'
  let url
  try {
    url = new URL(target, REDIRECT_BASE)
  } catch {
    return '/'
  }
  if (url.origin !== REDIRECT_BASE) return '/'
  return url.pathname + url.search + url.hash
}

// What a person is told when their magic link does not sign them in, by verifyMagicLink() code.
const MAGIC_LINK_ERRORS = {
  invalid: 'This sign-in link is invalid or has already been used. Please request a new one.',
  expired: 'This sign-in link has expired. Please request a new one.',
  denied: 'Sign-in is not allowed for this account.',
  failed: 'Sign-in could not be completed. Please try again.'
}

/**
 * Standalone page for a failed magic link that has no page to return to.
 * Why: links sent by custom controllers without `errorRedirect` (and no
 * `auth.magicLinkErrorRedirect`) used to end on a bare text response.
 */
function magicLinkErrorPage(message) {
  const text = String(message).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Sign-in link</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'font-family:system-ui,-apple-system,sans-serif;background:#f6f7f9;color:#1f2328}main{max-width:26rem;margin:1rem;padding:2rem;' +
    'background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0 0 1.25rem;' +
    'line-height:1.5;color:#59636e}a{color:#0969da}@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}' +
    'main{background:#161b22}p{color:#9198a1}a{color:#4493f8}}</style></head><body><main><h1>Sign-in link</h1>' +
    `<p>${text}</p><a href="/">Go to the home page</a></main></body></html>`
  )
}

class Internal {
  static #validateField(validator, field, validation, value) {
    const rules = validation.rule.split('|')
    for (const rule of rules) {
      const validatorChain = (field.type === 'file' ? validator.file(field.name) : validator.post(field.name)).check(rule)
      if (validation.message) {
        const message = this.replacePlaceholders(validation.message, {
          value: value,
          field: field.name,
          label: field.label || field.placeholder,
          rule: rule
        })
        validatorChain.message(message)
      }
    }
  }

  static async register(Odac) {
    const token = await Odac.request('_odac_register_token')
    if (!token) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid request'}
      })
    }

    const formData = Odac.Request.session(`_register_form_${token}`)

    if (!formData) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Form session expired. Please refresh the page.'}
      })
    }

    if (formData.expires < Date.now()) {
      Odac.Request.session(`_register_form_${token}`, null)
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Form session expired. Please refresh the page.'}
      })
    }

    if (formData.sessionId !== Odac.Request.session('_client')) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid session'}
      })
    }

    if (formData.userAgent !== Odac.Request.header('user-agent')) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid request'}
      })
    }

    if (formData.ip !== Odac.Request.ip) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid request'}
      })
    }

    const config = formData.config
    const validator = Odac.validator()
    const data = {}

    const uniqueFields = []

    for (const field of config.fields) {
      if (field.type === 'file') continue

      const value = await Odac.request(field.name)

      for (const validation of field.validations) {
        this.#validateField(validator, field, validation, value)
      }

      if (field.unique) {
        uniqueFields.push(field.name)
      }

      if (!field.skip) {
        data[field.name] = value
      }
    }

    for (const set of config.sets) {
      if (set.value !== null) {
        if (set.ifEmpty && data[set.name]) continue
        data[set.name] = set.value
      } else if (set.compute) {
        data[set.name] = await this.computeValue(set.compute, Odac)
      } else if (set.callback) {
        if (typeof Odac.fn[set.callback] === 'function') {
          data[set.name] = await Odac.fn[set.callback](Odac)
        }
      }
    }

    if (await validator.error()) {
      return validator.result()
    }

    const registerResult = await Odac.Auth.register(data, {
      autoLogin: config.autologin !== false,
      uniqueFields: uniqueFields.length > 0 ? uniqueFields : ['email']
    })

    if (!registerResult.success) {
      if (registerResult.error === 'Database connection failed') {
        return Odac.return({
          result: {success: false},
          errors: {_odac_form: 'Service temporarily unavailable. Please try again later.'}
        })
      }
      const errorField = registerResult.field || '_odac_form'
      const errors = {[errorField]: registerResult.error}
      return Odac.return({
        result: {success: false},
        errors: errors
      })
    }

    Odac.Request.session(`_register_form_${token}`, null)

    return Odac.return({
      result: {
        success: true,
        message: 'Registration successful',
        redirect: config.redirect
      }
    })
  }

  static replacePlaceholders(message, data) {
    if (!message) return message

    const ruleParts = data.rule ? data.rule.split(':') : []
    const ruleValue = ruleParts[1] || null

    const placeholders = {
      '{value}': data.value || '',
      '{field}': data.field || '',
      '{label}': data.label || data.field || '',
      '{min}': ruleValue,
      '{max}': ruleValue,
      '{len}': ruleValue,
      '{other}': ruleValue
    }

    let result = message
    for (const [placeholder, value] of Object.entries(placeholders)) {
      if (value !== null) {
        result = result.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value)
      }
    }

    return result
  }

  static async computeValue(type, Odac) {
    switch (type) {
      case 'now':
        return Math.floor(Date.now() / 1000)
      case 'date':
        return new Date().toISOString().split('T')[0]
      case 'datetime':
        return new Date().toISOString()
      case 'timestamp':
        return Date.now()
      case 'ip':
        return Odac.Request.ip
      case 'user_agent':
        return Odac.Request.header('user-agent')
      case 'uuid':
        return require('crypto').randomUUID()
      default:
        return null
    }
  }

  static async login(Odac) {
    const token = await Odac.request('_odac_login_token')
    if (!token) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid request'}
      })
    }

    const formData = Odac.Request.session(`_login_form_${token}`)

    if (!formData) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Form session expired. Please refresh the page.'}
      })
    }

    if (formData.expires < Date.now()) {
      Odac.Request.session(`_login_form_${token}`, null)
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Form session expired. Please refresh the page.'}
      })
    }

    if (formData.sessionId !== Odac.Request.session('_client')) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid session'}
      })
    }

    if (formData.userAgent !== Odac.Request.header('user-agent')) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid request'}
      })
    }

    if (formData.ip !== Odac.Request.ip) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid request'}
      })
    }

    const config = formData.config
    const validator = Odac.validator()
    const credentials = {}

    for (const field of config.fields) {
      const value = await Odac.request(field.name)

      for (const validation of field.validations) {
        this.#validateField(validator, field, validation, value)
      }

      credentials[field.name] = value
    }

    if (await validator.error()) {
      return validator.result()
    }

    // Auth.login() returns a truthy value on success and a falsy value on
    // invalid credentials (its documented boolean contract). A thrown error
    // means the login could not be evaluated at all (e.g. DB unreachable).
    const tooManyAttempts = () =>
      Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Too many failed attempts. Please try again later.'}
      })

    let loginResult
    try {
      if (await Odac.Auth.loginThrottled(credentials)) return tooManyAttempts()
      loginResult = await Odac.Auth.login(credentials)
    } catch (e) {
      console.error(e)
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Service temporarily unavailable. Please try again later.'}
      })
    }

    if (!loginResult) {
      // This failure may have been the one that reached the limit.
      if (await Odac.Auth.loginThrottled(credentials).catch(() => false)) return tooManyAttempts()
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid credentials'}
      })
    }

    Odac.Request.session(`_login_form_${token}`, null)

    return Odac.return({
      result: {
        success: true,
        message: 'Login successful',
        redirect: config.redirect
      }
    })
  }

  static async magicLogin(Odac) {
    const token = await Odac.request('_odac_magic_login_token')
    if (!token) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid request'}
      })
    }

    const formData = Odac.Request.session(`_magic_login_form_${token}`)
    if (!formData) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Form session expired. Please refresh the page.'}
      })
    }

    if (formData.expires < Date.now()) {
      Odac.Request.session(`_magic_login_form_${token}`, null)
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Form session expired. Please refresh the page.'}
      })
    }

    // Basic security checks
    if (
      formData.sessionId !== Odac.Request.session('_client') ||
      formData.userAgent !== Odac.Request.header('user-agent') ||
      formData.ip !== Odac.Request.ip
    ) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid request security token'}
      })
    }

    const config = formData.config
    const validator = Odac.validator()
    let email = ''

    // Validate inputs (expecting email)
    for (const field of config.fields) {
      const value = await Odac.request(field.name)
      for (const validation of field.validations) {
        this.#validateField(validator, field, validation, value)
      }
      if (field.name === 'email') email = value
    }

    if (await validator.error()) {
      return validator.result()
    }

    if (!email) {
      return Odac.return({
        result: {success: false},
        errors: {email: 'Email is required'}
      })
    }

    const result = await Odac.Auth.magic(email, {
      autoRegister: false, // config.autoRegister
      redirect: config.redirect,
      // The form's error-redirect, or the page the form is on (see Form.openForm).
      errorRedirect: config.errorRedirect
    })

    if (!result.success) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: result.error || 'Failed to send magic link'}
      })
    }

    Odac.Request.session(`_magic_login_form_${token}`, null)

    return Odac.return({
      result: {
        success: true,
        message: result.message || 'Magic link sent! Please check your email.',
        // We might want to keep them on page or redirect to a "check email" page
        redirect: config.redirect
      }
    })
  }

  // Mail clients, chat apps and corporate link scanners fetch a link's target to
  // build a preview or check it for malware, long before the recipient taps it.
  // A one-shot magic link consumed by such a fetch leaves the human with "Link
  // expired or invalid" — which is how magic-link login broke on mobile. These
  // requests are answered with a neutral page and the token is left untouched;
  // only a genuine top-level navigation may consume it.
  static #isMachineFetch(Odac) {
    const header = name => Odac.Request.header(name) || ''

    // Browsers never navigate with HEAD; link scanners probe with it.
    if (Odac.Request.method === 'head') return true

    // Explicitly declared prefetch / prerender / preview (Chrome, Firefox, Safari).
    const purpose = `${header('sec-purpose')} ${header('purpose')} ${header('x-purpose')} ${header('x-moz')}`.toLowerCase()
    if (/prefetch|prerender|preview/.test(purpose)) return true

    // Fetch metadata: opening a link is a top-level document navigation.
    // Anything else (sub-resource, no-cors probe) is a machine reading the page.
    const dest = header('sec-fetch-dest')
    if (dest) return dest !== 'document'
    const mode = header('sec-fetch-mode')
    if (mode) return mode !== 'navigate'

    // No fetch metadata: browsers predating it (and in-app webviews that strip
    // it) still have to work, so fall back to the user agent rather than
    // treating the request as a machine by default.
    const ua = header('user-agent').toLowerCase()
    if (!ua) return true
    return /bot|crawl|spider|preview|scan|slurp|curl|wget|python-requests|okhttp|java\/|libwww|headless|phantom|proofpoint|mimecast|barracuda|symantec|safelinks|linkprotect/.test(
      ua
    )
  }

  /**
   * Handles a followed magic link: signs the owner in, or returns them to a page that
   * explains the failure.
   * Why: a failed link used to end on a bare text response with nowhere to go. It now goes
   * back to the page the link was requested from (the form shows the error), a page chosen by
   * the app, or a standalone page; the error itself travels in the session, read once through
   * Odac.Auth.magicError().
   */
  static async magicVerify(Odac) {
    const token = await Odac.request('token')
    const email = await Odac.request('email')

    // 200, not an error: scanners flag failing links, and the recipient's own
    // tap arrives later on this same URL.
    if (this.#isMachineFetch(Odac)) {
      return Odac.Request.end(
        '<!doctype html><meta charset="utf-8"><title>Sign in</title><p>Open this link in your browser to sign in.</p>'
      )
    }

    const result = token && email ? await Odac.Auth.verifyMagicLink(token, email) : {success: false, code: 'invalid'}
    const successTarget = (await Odac.request('redirect_url')) || Odac.Config.auth?.magicLinkRedirect || '/'

    if (result.success) {
      Odac.Request.redirect(sameSitePath(successTarget))
      return Odac.Request.end('')
    }

    // A second tap on a link that already signed this person in is not an error for them.
    if ((result.code === 'invalid' || result.code === 'expired') && (await Odac.Auth.check()) && Odac.Auth.user('email') === email) {
      Odac.Request.redirect(sameSitePath(successTarget))
      return Odac.Request.end('')
    }

    const code = MAGIC_LINK_ERRORS[result.code] ? result.code : 'failed'
    const message = MAGIC_LINK_ERRORS[code]
    const errorTarget = (await Odac.request('error_url')) || Odac.Config.auth?.magicLinkErrorRedirect

    if (typeof errorTarget !== 'string' || !errorTarget) {
      Odac.Request.status(400)
      Odac.Request.header('Content-Type', 'text/html; charset=utf-8')
      return Odac.Request.end(magicLinkErrorPage(message))
    }

    // Read once by Odac.Auth.magicError() on the page the visitor lands on.
    Odac.Request.session('_odac_magic_error', {code, message})
    Odac.Request.redirect(sameSitePath(errorTarget))
    Odac.Request.end('')
  }

  static async processForm(Odac) {
    const token = await Odac.request('_odac_form_token')
    if (!token) return

    const formData = Odac.Request.session(`_custom_form_${token}`)
    if (!formData) return

    if (formData.expires < Date.now()) {
      Odac.Request.session(`_custom_form_${token}`, null)
      return
    }

    if (formData.sessionId !== Odac.Request.session('_client')) return
    if (formData.userAgent !== Odac.Request.header('user-agent')) return
    if (formData.ip !== Odac.Request.ip) return

    const config = formData.config
    const validator = Odac.validator()
    const data = {}

    const uniqueFields = []

    for (const field of config.fields) {
      const value = field.type === 'file' ? await Odac.file(field.name) : await Odac.request(field.name)

      for (const validation of field.validations) {
        this.#validateField(validator, field, validation, value)

        if (validation.rule.includes('unique')) {
          if (!uniqueFields.some(f => f.name === field.name)) {
            uniqueFields.push({name: field.name, message: validation.message})
          }
        }
      }

      // File fields excluded from data bag; controllers access via formHelper.file()
      if (!field.skip && field.type !== 'file') {
        data[field.name] = value
      }
    }

    for (const set of config.sets || []) {
      if (set.value !== undefined && set.value !== null) {
        if (set.ifEmpty && data[set.name] !== undefined && data[set.name] !== null && data[set.name] !== '') continue
        data[set.name] = set.value
      } else if (set.compute) {
        data[set.name] = await this.computeValue(set.compute, Odac)
      } else if (set.callback) {
        if (typeof Odac.fn[set.callback] === 'function') {
          data[set.name] = await Odac.fn[set.callback](Odac)
        }
      }
    }

    Odac.formData = data
    Odac.formConfig = config
    Odac.formValidator = validator
    Odac.formUniqueFields = uniqueFields
  }

  static async customForm(Odac) {
    const token = await Odac.request('_odac_form_token')
    if (!token) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid request'}
      })
    }

    const formData = Odac.Request.session(`_custom_form_${token}`)

    if (!formData) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Form session expired. Please refresh the page.'}
      })
    }

    if (formData.expires < Date.now()) {
      Odac.Request.session(`_custom_form_${token}`, null)
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Form session expired. Please refresh the page.'}
      })
    }

    if (formData.sessionId !== Odac.Request.session('_client')) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid session'}
      })
    }

    if (formData.userAgent !== Odac.Request.header('user-agent')) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid request'}
      })
    }

    if (formData.ip !== Odac.Request.ip) {
      return Odac.return({
        result: {success: false},
        errors: {_odac_form: 'Invalid request'}
      })
    }

    if (await Odac.formValidator.error()) {
      return Odac.formValidator.result()
    }

    if (Odac.formConfig.table) {
      try {
        const table = Odac.DB[Odac.formConfig.table]
        const path = require('path')

        for (const field of Odac.formUniqueFields) {
          if (Odac.formData[field.name] == null) continue

          const existingRecord = await table.where(field.name, Odac.formData[field.name]).first()

          if (existingRecord) {
            const errorMessage = field.message || `This ${field.name} is already registered`
            return Odac.return({
              result: {success: false},
              errors: {[field.name]: errorMessage}
            })
          }
        }

        // Auto-store file fields for table forms. Skipped fields are validated
        // but excluded from persistence (mirrors `skip` for text fields); their
        // temp files are cleaned up by Request when the response is sent.
        // Stored files are permanent, so they never default to the OS temp directory, which is
        // cleared on reboot and by tmp cleaners.
        const uploadDir = global.Odac.Config.request.uploadDir || path.join(global.__dir || process.cwd(), 'storage', 'uploads')
        for (const field of Odac.formConfig.fields) {
          if (field.type !== 'file' || field.skip) continue

          const file = await Odac.file(field.name)
          if (!file) continue

          const files = Array.isArray(file) ? file : [file]
          const storedPaths = []
          for (const f of files) {
            const rel = path.join(Odac.formConfig.table, `${nodeCrypto.randomBytes(8).toString('hex')}.${f.ext}`)
            await f.move(path.join(uploadDir, rel))
            storedPaths.push(rel)
          }
          Odac.formData[field.name] = Array.isArray(file) ? JSON.stringify(storedPaths) : storedPaths[0]
        }

        await table.insert(Odac.formData)

        Odac.Request.session(`_custom_form_${token}`, null)

        return Odac.return({
          result: {
            success: true,
            message: Odac.formConfig.successMessage || 'Form submitted successfully!',
            redirect: Odac.formConfig.redirect
          }
        })
      } catch (error) {
        if (error.message === 'Database connection failed') {
          return Odac.return({
            result: {success: false},
            errors: {_odac_form: 'Database not configured. Please check your odac.json'}
          })
        }

        // Driver messages expose table/column names and submitted values; log them instead.
        console.error(JSON.stringify({level: 'ERROR', message: 'Form insert failed', table: Odac.formConfig.table, error: error.message}))
        return Odac.return({
          result: {success: false},
          errors: {_odac_form: 'The form could not be saved. Please try again.'}
        })
      }
    }

    if (Odac.formConfig.action) {
      const actionParts = Odac.formConfig.action.split('.')
      if (actionParts.length >= 2) {
        const controllerName = actionParts[0]

        let controllerModule = null

        if (Odac.Route && Odac.Route.class && Odac.Route.class[controllerName]) {
          controllerModule = Odac.Route.class[controllerName].module
        }

        if (controllerModule) {
          try {
            // Create Form Helper Object
            const formHelper = {
              data: Odac.formData,

              file: name => {
                return Odac.file(name)
              },

              // Accepts either a single field (`error('email', 'msg')`) or a map
              // (`error({email: 'msg', name: 'msg'})`). The response can only be
              // sent once, so the map form is the only way to surface every
              // invalid field of a multi-field form in one round trip; the client
              // already iterates `errors` and renders each entry.
              error: (field, message) => {
                const errors = field !== null && typeof field === 'object' ? field : {[field]: message}

                return Odac.return({
                  result: {success: false},
                  errors
                })
              },

              // `options` is a redirect string (legacy signature) or
              // `{redirect, data}`. `data` is echoed to the client as
              // `result.data` and is the only supported way for an action to hand
              // computed values (a new id, a stored file path, a total) back to
              // the caller: token rotation lives in this closure, so a hand-rolled
              // Odac.return() would omit `_token` and the next submit on a
              // redirect-less form would fail with "Form session expired".
              success: (message, options = null) => {
                const opts = options === null || typeof options === 'string' ? {redirect: options} : options
                const finalRedirect = opts.redirect || Odac.formConfig.redirect
                let newToken = null

                // Only rotate token if we are staying on the page (no redirect)
                if (!finalRedirect) {
                  newToken = nodeCrypto.randomBytes(32).toString('hex')

                  if (formData && formData.config) {
                    const newFormData = {
                      ...formData,
                      config: {...formData.config, token: newToken},
                      created: Date.now(),
                      expires: Date.now() + 30 * 60 * 1000
                    }
                    Odac.Request.session(`_custom_form_${newToken}`, newFormData)
                  }
                }

                Odac.Request.session(`_custom_form_${token}`, null)

                return Odac.return({
                  result: {
                    success: true,
                    message: message,
                    redirect: finalRedirect,
                    _token: newToken,
                    ...(opts.data !== undefined && {data: opts.data})
                  }
                })
              }
            }

            let method = controllerModule
            let context = null
            let isClass = false

            if (typeof controllerModule === 'function' && controllerModule.prototype) {
              isClass = true
              context = new controllerModule(Odac)
              method = context
            }

            for (let i = 1; i < actionParts.length; i++) {
              if (method) {
                context = method
                method = method[actionParts[i]]
              }
            }

            if (typeof method === 'function') {
              if (isClass) {
                return await method.call(context, formHelper)
              } else {
                return await method.call(context, Odac, formHelper)
              }
            }
          } catch (e) {
            console.error(e)
            return Odac.return({
              result: {success: false},
              errors: {_odac_form: 'An error occurred while processing your request.'}
            })
          }
        }

        console.error(`Action ${Odac.formConfig.action} not found or invalid.`)
        return Odac.return({
          result: {success: false},
          errors: {_odac_form: 'An error occurred while processing your request.'}
        })
      }
    }

    Odac.Request.session(`_custom_form_${token}`, null)

    return null
  }
}

module.exports = Internal
