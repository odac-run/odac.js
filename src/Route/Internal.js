const nodeCrypto = require('crypto')

class Internal {
  static #validateField(validator, field, validation, value) {
    const rules = validation.rule.split('|')
    for (const rule of rules) {
      const validatorChain = validator.post(field.name).check(rule)
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

    const loginResult = await Odac.Auth.login(credentials)

    if (!loginResult.success) {
      if (loginResult.error === 'Database connection failed') {
        return Odac.return({
          result: {success: false},
          errors: {_odac_form: 'Service temporarily unavailable. Please try again later.'}
        })
      }
      const errorField = loginResult.field || '_odac_form'
      const errors = {[errorField]: loginResult.error}
      return Odac.return({
        result: {success: false},
        errors: errors
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
      redirect: config.redirect
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

  static async magicVerify(Odac) {
    const token = await Odac.request('token')
    const email = await Odac.request('email')

    if (!token || !email) {
      return Odac.Request.end('Invalid verification link.')
    }

    const result = await Odac.Auth.verifyMagicLink(token, email)

    if (!result.success) {
      return Odac.Request.end(`Verification failed: ${result.error}`)
    }

    // Redirect to a specific URL if provided, otherwise default to home or a configured dashboard page.
    let redirectUrl = (await Odac.request('redirect_url')) || Odac.Config.auth?.magicLinkRedirect || '/'

    // Security: Prevent open redirect attacks by only allowing relative paths
    if (redirectUrl && (!redirectUrl.startsWith('/') || redirectUrl.startsWith('//'))) {
      redirectUrl = '/'
    }

    Odac.Request.redirect(redirectUrl)
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
      const value = await Odac.request(field.name)

      for (const validation of field.validations) {
        this.#validateField(validator, field, validation, value)

        if (validation.rule.includes('unique')) {
          if (!uniqueFields.some(f => f.name === field.name)) {
            uniqueFields.push({name: field.name, message: validation.message})
          }
        }
      }

      if (!field.skip) {
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
            errors: {_odac_form: 'Database not configured. Please check your config.json'}
          })
        }

        return Odac.return({
          result: {success: false},
          errors: {_odac_form: error.message || 'Database error occurred'}
        })
      }
    }

    if (Odac.formConfig.action) {
      const actionParts = Odac.formConfig.action.split('.')
      if (actionParts.length === 2) {
        const controllerName = actionParts[0]
        const methodName = actionParts[1]

        // Dynamically load controller
        // We need to access Odac.Route.class to find the controller path/module
        // Or use require directly if we know the path structure.
        // Since we are in framework/src/Route/Internal.js, controllers are in framework/controller/ OR app/controller/
        // Ideally Odac.Route.class has the loaded controllers.

        let controllerModule = null

        if (Odac.Route && Odac.Route.class && Odac.Route.class[controllerName]) {
          controllerModule = Odac.Route.class[controllerName].module
        } else {
          // Try to require it if not loaded (though Route.js should have loaded it)
          // This fallback might be tricky with absolute paths, relying on Route.class is safer.
        }

        if (controllerModule) {
          try {
            // Create Form Helper Object
            const formHelper = {
              data: Odac.formData,

              error: (field, message) => {
                return Odac.return({
                  result: {success: false},
                  errors: {[field]: message}
                })
              },

              success: (message, redirect = null) => {
                const finalRedirect = redirect || Odac.formConfig.redirect
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
                    _token: newToken
                  }
                })
              }
            }

            // Handle Class-based Controller
            if (typeof controllerModule === 'function' && controllerModule.prototype) {
              const instance = new controllerModule(Odac)
              if (typeof instance[methodName] === 'function') {
                return await instance[methodName](formHelper)
              }
            }
            // Handle Object-based Controller (Backwards Compatibility)
            else if (typeof controllerModule[methodName] === 'function') {
              return await controllerModule[methodName](Odac, formHelper)
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
