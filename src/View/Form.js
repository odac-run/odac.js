const nodeCrypto = require('crypto')

class Form {
  static FORM_TYPES = ['register', 'login', 'magic-login', 'form']

  static FORM_META = {
    form: {
      cssClass: 'odac-custom-form',
      dataAttr: 'data-odac-form',
      tokenInputName: '_odac_form_token',
      action: '/_odac/form',
      defaultSubmitText: 'Submit',
      defaultSubmitLoading: 'Processing...',
      storageKey: 'customForms',
      sessionKeyPrefix: '_custom_form_'
    },
    register: {
      cssClass: 'odac-register-form',
      dataAttr: 'data-odac-register',
      tokenInputName: '_odac_register_token',
      action: '/_odac/register',
      defaultSubmitText: 'Register',
      defaultSubmitLoading: 'Processing...',
      storageKey: 'registerForms',
      sessionKeyPrefix: '_register_form_'
    },
    login: {
      cssClass: 'odac-login-form',
      dataAttr: 'data-odac-login',
      tokenInputName: '_odac_login_token',
      action: '/_odac/login',
      defaultSubmitText: 'Login',
      defaultSubmitLoading: 'Logging in...',
      storageKey: 'loginForms',
      sessionKeyPrefix: '_login_form_'
    },
    'magic-login': {
      cssClass: 'odac-magic-login-form',
      dataAttr: 'data-odac-magic-login',
      tokenInputName: '_odac_magic_login_token',
      action: '/_odac/magic-login',
      defaultSubmitText: 'Send Magic Link',
      defaultSubmitLoading: 'Sending...',
      storageKey: 'magicLoginForms',
      sessionKeyPrefix: '_magic_login_form_'
    }
  }

  static escapeHtml(value) {
    if (value === null || value === undefined) return ''
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return String(value).replace(/[&<>"']/g, ch => map[ch])
  }

  // Like escapeHtml but leaves {{ ... }} / {!! ... !!} template tokens intact
  // so they survive into the view engine's {{ }} pass. Escaping inside the
  // tokens would corrupt the JS expression (e.g. ' -> &#39;) and produce
  // "Unexpected token '&'" at render time.
  static escapeHtmlPreservingTemplates(value) {
    if (value === null || value === undefined) return ''
    const str = String(value)
    const regex = /\{\{[\s\S]*?\}\}|\{!![\s\S]*?!!\}/g
    let result = ''
    let lastIndex = 0
    let match
    while ((match = regex.exec(str)) !== null) {
      if (match.index > lastIndex) {
        result += this.escapeHtml(str.substring(lastIndex, match.index))
      }
      result += match[0]
      lastIndex = regex.lastIndex
    }
    if (lastIndex < str.length) {
      result += this.escapeHtml(str.substring(lastIndex))
    }
    return result
  }

  static parse(content, Odac) {
    for (const type of this.FORM_TYPES) {
      content = this.parseFormType(content, Odac, type)
    }
    return content
  }

  /**
   * Compile-time transform for <odac:{type}>...</odac:{type}> blocks.
   *
   * Emits two <script:odac> runtime hooks (openForm / closeForm) with the
   * form body kept inline between them. This preserves the view engine
   * pipeline for inner content — <odac:if>, <odac:for>, {{ }} interpolation,
   * etc. all keep working inside forms instead of being frozen into a JSON
   * string blob and then mangled by later passes.
   */
  static parseFormType(content, Odac, type) {
    const meta = this.FORM_META[type]
    const regex = new RegExp(`<odac:${type}[\\s\\S]*?<\\/odac:${type}>`, 'g')

    return content.replace(regex, match => {
      const formConfig = this.extractConfig(match, null, type)

      const openTagRegex = new RegExp(`^<odac:${type}[^>]*>`)
      const closeTagRegex = new RegExp(`</odac:${type}>$`)
      let innerContent = match.replace(openTagRegex, '').replace(closeTagRegex, '')

      // Pre-render <odac:input> tags into <input>/<textarea>/<label> markup.
      // Field values may contain {{ }} — those stay as-is here and get
      // resolved by the view engine's {{ }} pass on the surrounding HTML.
      innerContent = innerContent.replace(/<odac:input([^>]*?)(?:\/>|>(?:[\s\S]*?)<\/odac:input>)/g, fieldMatch => {
        const field = this.parseInput(fieldMatch)
        if (!field) return fieldMatch
        return this.generateFieldHtml(field)
      })

      // Pre-render <odac:submit>...</odac:submit> (or self-closing) into <button>
      let submitRendered = false
      innerContent = innerContent.replace(/<odac:submit([^>]*?)(?:\/>|>(.*?)<\/odac:submit>)/g, () => {
        submitRendered = true
        return this.generateSubmitButton(formConfig, meta)
      })

      // magic-login convenience: if the author didn't write any <odac:input>,
      // append the default email field that extractConfig pushed into config.
      if (type === 'magic-login' && !match.includes('<odac:input')) {
        const emailField = formConfig.fields.find(f => f.name === 'email')
        if (emailField) innerContent += '\n' + this.generateFieldHtml(emailField)
      }

      // magic-login convenience: if no <odac:submit> was rendered, add one.
      if (type === 'magic-login' && !submitRendered) {
        innerContent += '\n' + this.generateSubmitButton(formConfig, meta)
      }

      // <odac:set> is server-side only (sent into stored config) — strip from DOM.
      innerContent = innerContent.replace(/<odac:set[^>]*\/?>/g, '')

      // Serialize config; turn "{{ expr }}" string values into live (await expr)
      // so dynamic config values are evaluated at request time, not compile time.
      let configStr = JSON.stringify(formConfig).replace(/<\/script:odac/gi, '<\\/script:odac')
      configStr = configStr.replace(/"\{\{([\s\S]*?)\}\}"/g, (_, expr) => `(await ${expr.replace(/\\"/g, '"')})`)

      return (
        `<script:odac>html += await Odac.View.Form.openForm(Odac, '${type}', ${configStr});</script:odac>` +
        innerContent +
        `<script:odac>html += await Odac.View.Form.closeForm();</script:odac>`
      )
    })
  }

  // - RUNTIME: emits the opening <form ...> + hidden token input.
  //   Generates a fresh CSRF token per render and persists the resolved
  //   config in the session under the type-specific key.
  static async openForm(Odac, type, config) {
    const meta = this.FORM_META[type]
    const token = nodeCrypto.randomBytes(32).toString('hex')
    config.token = token
    this.storeConfig(token, config, Odac, type)

    const method = (config.method || 'POST').toUpperCase()
    let classes = meta.cssClass
    if (config.class) classes += ' ' + config.class

    let attrs = `class="${this.escapeHtml(classes)}"`
    attrs += ` ${meta.dataAttr}="${this.escapeHtml(token)}"`
    attrs += ` method="${this.escapeHtml(method)}"`
    attrs += ` action="${this.escapeHtml(meta.action)}"`
    attrs += ` novalidate`
    if (config.id) attrs += ` id="${this.escapeHtml(config.id)}"`
    if (type === 'form' && config.clear !== undefined) attrs += ` clear="${config.clear}"`
    if (config.fields && config.fields.some(f => f.type === 'file')) attrs += ` enctype="multipart/form-data"`

    let html = `<form ${attrs}>\n`
    html += `  <input type="hidden" name="${meta.tokenInputName}" value="${this.escapeHtml(token)}">\n`
    return html
  }

  // - RUNTIME: emits the trailing success span + </form>.
  static async closeForm() {
    return `\n  <span class="odac-form-success" style="display:none;"></span>\n</form>`
  }

  static storeConfig(token, config, Odac, type) {
    const meta = this.FORM_META[type]
    if (!Odac.View) Odac.View = {}
    if (!Odac.View[meta.storageKey]) Odac.View[meta.storageKey] = {}

    const formData = {
      config: config,
      created: Date.now(),
      expires: Date.now() + 30 * 60 * 1000,
      sessionId: Odac.Request.session('_client'),
      userAgent: Odac.Request.header('user-agent'),
      ip: Odac.Request.ip
    }

    Odac.View[meta.storageKey][token] = formData
    Odac.Request.session(meta.sessionKeyPrefix + token, formData)
  }

  static extractConfig(html, formToken, type) {
    if (type === 'register') return this.extractRegisterConfig(html, formToken)
    if (type === 'login') return this.extractLoginConfig(html, formToken)
    if (type === 'magic-login') return this.extractMagicLoginConfig(html, formToken)
    if (type === 'form') return this.extractFormConfig(html, formToken)
  }

  static generateSubmitButton(config, meta) {
    const submitText = config.submitText || meta.defaultSubmitText
    const submitLoading = config.submitLoading || meta.defaultSubmitLoading

    let attrs = `type="submit"`
    attrs += ` data-submit-text="${this.escapeHtml(submitText)}"`
    attrs += ` data-loading-text="${this.escapeHtml(submitLoading)}"`
    if (config.submitClass) attrs += ` class="${this.escapeHtml(config.submitClass)}"`
    if (config.submitStyle) attrs += ` style="${this.escapeHtml(config.submitStyle)}"`
    if (config.submitId) attrs += ` id="${this.escapeHtml(config.submitId)}"`
    return `<button ${attrs}>${this.escapeHtml(submitText)}</button>`
  }

  static extractRegisterConfig(html, formToken) {
    const config = {
      token: formToken,
      redirect: null,
      autologin: true,
      submitText: 'Register',
      submitLoading: 'Processing...',
      fields: [],
      sets: []
    }

    const registerMatch = html.match(/<odac:register([^>]*)>/)
    if (!registerMatch) return config

    const registerTag = registerMatch[0]
    const redirectMatch = registerTag.match(/redirect=["']([^"']+)["']/)
    const autologinMatch = registerTag.match(/autologin=["']([^"']+)["']/)

    if (redirectMatch) config.redirect = redirectMatch[1]
    if (autologinMatch) config.autologin = autologinMatch[1] !== 'false'

    this.applySubmitConfig(html, config)
    this.collectFields(html, config)
    this.collectSets(html, config)

    return config
  }

  static extractLoginConfig(html, formToken) {
    const config = {
      token: formToken,
      redirect: null,
      submitText: 'Login',
      submitLoading: 'Logging in...',
      fields: []
    }

    const loginMatch = html.match(/<odac:login([^>]*)>/)
    if (!loginMatch) return config

    const redirectMatch = loginMatch[0].match(/redirect=["']([^"']+)["']/)
    if (redirectMatch) config.redirect = redirectMatch[1]

    this.applySubmitConfig(html, config)
    this.collectFields(html, config)

    return config
  }

  static extractMagicLoginConfig(html, formToken) {
    const config = {
      token: formToken,
      redirect: null,
      submitText: 'Send Magic Link',
      submitLoading: 'Sending...',
      fields: []
    }

    const tagMatch = html.match(/<odac:magic-login([^>]*)>/)
    if (!tagMatch) return config

    const tag = tagMatch[0]
    const redirectMatch = tag.match(/redirect=["']([^"']+)["']/)
    const emailLabelMatch = tag.match(/email-label=["']([^"']+)["']/)
    if (redirectMatch) config.redirect = redirectMatch[1]

    const fieldMatches = html.match(/<odac:input([^>]*?)(?:\/>|>(?:[\s\S]*?)<\/odac:input>)/g)
    if (fieldMatches) {
      for (const fieldHtml of fieldMatches) {
        const field = this.parseInput(fieldHtml)
        if (field) config.fields.push(field)
      }
    } else {
      config.fields.push({
        name: 'email',
        type: 'email',
        placeholder: 'e.g. user@example.com',
        label: emailLabelMatch ? emailLabelMatch[1] : 'Email Address',
        class: '',
        id: null,
        unique: false,
        skip: false,
        value: null,
        validations: [
          {rule: 'required', message: 'Email is required'},
          {rule: 'email', message: 'Invalid email format'}
        ]
      })
    }

    const applied = this.applySubmitConfig(html, config)
    if (!applied) {
      const submitTextAttr = tag.match(/submit-text=["']([^"']+)["']/)
      if (submitTextAttr) config.submitText = submitTextAttr[1]
    }

    return config
  }

  static extractFormConfig(html, formToken) {
    const config = {
      token: formToken,
      action: null,
      method: 'POST',
      submitText: 'Submit',
      submitLoading: 'Processing...',
      fields: [],
      sets: [],
      class: '',
      id: null,
      table: null,
      redirect: null,
      successMessage: null
    }

    const formMatch = html.match(/<odac:form([^>]*)>/)
    if (!formMatch) return config

    const formTag = formMatch[0]
    const extractAttr = name => {
      const m = formTag.match(new RegExp(`${name}=(['"])((?:(?!\\1).)*)\\1`))
      return m ? m[2] : null
    }

    const actionMatch = extractAttr('action')
    const methodMatch = extractAttr('method')
    const classMatch = extractAttr('class')
    const idMatch = extractAttr('id')
    const tableMatch = extractAttr('table')
    const redirectMatch = extractAttr('redirect')
    const successMatch = extractAttr('success')
    const clearMatch = extractAttr('clear')

    if (actionMatch) config.action = actionMatch
    if (methodMatch) config.method = methodMatch.toUpperCase()
    if (classMatch) config.class = classMatch
    if (idMatch) config.id = idMatch
    if (tableMatch) config.table = tableMatch
    if (redirectMatch) config.redirect = redirectMatch
    if (successMatch) config.successMessage = successMatch
    if (clearMatch !== null) config.clear = clearMatch === 'true' || clearMatch === ''

    this.applySubmitConfig(html, config)
    this.collectFields(html, config)
    this.collectSets(html, config)

    return config
  }

  static applySubmitConfig(html, config) {
    const submitMatch = html.match(/<odac:submit([^>]*?)(?:\/?>|>(.*?)<\/odac:submit>)/)
    if (!submitMatch) return false

    const submitTag = submitMatch[1]
    const textMatch = submitTag.match(/text=["']([^"']+)["']/)
    const loadingMatch = submitTag.match(/loading=["']([^"']+)["']/)
    const classMatch = submitTag.match(/class=["']([^"']+)["']/)
    const styleMatch = submitTag.match(/style=["']([^"']+)["']/)
    const idMatch = submitTag.match(/id=["']([^"']+)["']/)

    if (textMatch) config.submitText = textMatch[1]
    else if (submitMatch[2]) config.submitText = submitMatch[2].trim()

    if (loadingMatch) config.submitLoading = loadingMatch[1]
    if (classMatch) config.submitClass = classMatch[1]
    if (styleMatch) config.submitStyle = styleMatch[1]
    if (idMatch) config.submitId = idMatch[1]

    return true
  }

  static collectFields(html, config) {
    const fieldMatches = html.match(/<odac:input([^>]*?)(?:\/>|>(?:[\s\S]*?)<\/odac:input>)/g)
    if (!fieldMatches) return
    for (const fieldHtml of fieldMatches) {
      const field = this.parseInput(fieldHtml)
      if (field) config.fields.push(field)
    }
  }

  static collectSets(html, config) {
    const setMatches = html.match(/<odac:set[^>]*\/?>/g)
    if (!setMatches) return
    for (const setTag of setMatches) {
      const set = this.parseSet(setTag)
      if (set) config.sets.push(set)
    }
  }

  static parseInput(html) {
    const fieldTagMatch = html.match(/<odac:input([^>]*?)(?:\/>|>)/)
    if (!fieldTagMatch) return null

    const fieldTag = fieldTagMatch[0]
    const nameMatch = fieldTag.match(/name=["']([^"']+)["']/)
    if (!nameMatch) return null

    const field = {
      name: nameMatch[1],
      type: 'text',
      placeholder: '',
      label: null,
      class: '',
      id: null,
      unique: false,
      skip: false,
      value: null,
      validations: []
    }

    const typeMatch = fieldTag.match(/type=(["'])(.*?)\1/)
    const placeholderMatch = fieldTag.match(/placeholder=(["'])(.*?)\1/)
    const labelMatch = fieldTag.match(/label=(["'])(.*?)\1/)
    const classMatch = fieldTag.match(/class=(["'])(.*?)\1/)
    const idMatch = fieldTag.match(/id=(["'])(.*?)\1/)
    const valueMatch = fieldTag.match(/value=(["'])(.*?)\1/)
    const uniqueMatch = fieldTag.match(/unique=["']([^"']+)["']/) || fieldTag.match(/\sunique[\s/>]/)
    const skipMatch = fieldTag.match(/skip=["']([^"']+)["']/) || fieldTag.match(/\sskip[\s/>]/)

    if (typeMatch) field.type = typeMatch[2]
    if (placeholderMatch) field.placeholder = placeholderMatch[2]
    if (labelMatch) field.label = labelMatch[2]
    if (classMatch) field.class = classMatch[2]
    if (idMatch) field.id = idMatch[2]
    if (valueMatch) field.value = valueMatch[2]
    if (uniqueMatch) field.unique = uniqueMatch[1] !== 'false'
    if (skipMatch) field.skip = skipMatch[1] !== 'false'

    const validateMatches = html.match(/<odac:validate[^>]*>/g)
    if (validateMatches) {
      for (const validateTag of validateMatches) {
        const ruleMatch = validateTag.match(/rule=["']([^"']+)["']/)
        const messageMatch = validateTag.match(/message=(["'])(.*?)\1/)
        if (ruleMatch) {
          field.validations.push({
            rule: ruleMatch[1],
            message: messageMatch ? messageMatch[2] : null
          })
        }
      }
    }

    const extraAttrs = {}
    const knownAttrs = ['name', 'type', 'placeholder', 'label', 'class', 'id', 'unique', 'skip', 'value']
    const attrRegex = /(\w+)(?:=(["'])((?:(?!\2).)*)\2|=([^\s>]+))?/g
    const attributesString = fieldTag.replace(/^<odac:input/, '').replace(/\/?>$/, '')
    let attrMatch
    while ((attrMatch = attrRegex.exec(attributesString))) {
      const key = attrMatch[1]
      const value = attrMatch[3] !== undefined ? attrMatch[3] : attrMatch[4] !== undefined ? attrMatch[4] : ''
      if (!knownAttrs.includes(key)) extraAttrs[key] = value
    }
    field.extraAttributes = extraAttrs

    return field
  }

  static parseSet(html) {
    const nameMatch = html.match(/name=(["'])(.*?)\1/)
    if (!nameMatch) return null

    const set = {
      name: nameMatch[2],
      value: null,
      compute: null,
      callback: null,
      ifEmpty: false
    }

    const valueMatch = html.match(/value=(["'])(.*?)\1/)
    const computeMatch = html.match(/compute=(["'])(.*?)\1/)
    const callbackMatch = html.match(/callback=(["'])(.*?)\1/)
    const ifEmptyMatch = html.match(/if-empty=(["'])(.*?)\1/) || html.match(/\sif-empty[\s/>]/)

    if (valueMatch) set.value = valueMatch[2]
    if (computeMatch) set.compute = computeMatch[2]
    if (callbackMatch) set.callback = callbackMatch[2]
    if (ifEmptyMatch) set.ifEmpty = ifEmptyMatch[2] !== 'false'

    return set
  }

  static generateFieldHtml(field) {
    let html = ''
    const escapedName = this.escapeHtml(field.name)
    const escapedType = this.escapeHtml(field.type)
    const escapedPlaceholder = this.escapeHtmlPreservingTemplates(field.placeholder)

    if (field.label && field.type !== 'checkbox') {
      const fieldId = this.escapeHtmlPreservingTemplates(field.id || `odac-${field.name}`)
      html += `<label for="${fieldId}">${this.escapeHtmlPreservingTemplates(field.label)}</label>\n`
    }

    const classAttr = field.class ? ` class="${this.escapeHtmlPreservingTemplates(field.class)}"` : ''
    const idAttr = field.id
      ? ` id="${this.escapeHtmlPreservingTemplates(field.id)}"`
      : ` id="${this.escapeHtmlPreservingTemplates(`odac-${field.name}`)}"`
    const valueAttr = field.value !== null ? ` value="${this.escapeHtmlPreservingTemplates(field.value)}"` : ''

    if (field.type === 'checkbox') {
      const attrs = this.buildHtml5Attributes(field)
      const checkedAttr = field.value === '1' || field.value === true || field.value === 'true' ? ' checked' : ''
      if (field.label) {
        html += `<label>\n`
        html += `  <input type="checkbox"${idAttr} name="${escapedName}" value="1"${classAttr}${checkedAttr}${attrs}>\n`
        html += `  ${this.escapeHtmlPreservingTemplates(field.label)}\n`
        html += `</label>\n`
      } else {
        html += `<input type="checkbox"${idAttr} name="${escapedName}" value="1"${classAttr}${checkedAttr}${attrs}>\n`
      }
    } else if (field.type === 'textarea') {
      const attrs = this.buildHtml5Attributes(field)
      html += `<textarea${idAttr} name="${escapedName}" placeholder="${escapedPlaceholder}"${classAttr}${attrs}>${this.escapeHtmlPreservingTemplates(
        field.value || ''
      )}</textarea>\n`
    } else if (field.type === 'file') {
      const attrs = this.buildHtml5Attributes(field)
      html += `<input type="file"${idAttr} name="${escapedName}"${classAttr}${attrs}>\n`
    } else {
      const attrs = this.buildHtml5Attributes(field)
      html += `<input type="${escapedType}"${idAttr} name="${escapedName}"${valueAttr} placeholder="${escapedPlaceholder}"${classAttr}${attrs}>\n`
    }

    return html
  }

  static #parseSizeStatic(sizeStr) {
    const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i)
    if (!match) return 0
    let bytes = parseFloat(match[1])
    const unit = (match[2] || 'B').toUpperCase()
    const multipliers = {B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024}
    return Math.floor(bytes * (multipliers[unit] || 1))
  }

  static appendExtraAttributes(attrs, field) {
    if (!field.extraAttributes) return attrs
    for (const key in field.extraAttributes) {
      const val = field.extraAttributes[key]
      if (val === '') attrs += ` ${key}`
      else attrs += ` ${key}="${this.escapeHtmlPreservingTemplates(val)}"`
    }
    return attrs
  }

  static buildHtml5Attributes(field) {
    let attrs = ''
    const html5Rules = {
      required: false,
      minlength: null,
      maxlength: null,
      min: null,
      max: null,
      pattern: null
    }
    const errorMessages = {}

    for (const validation of field.validations) {
      const rules = validation.rule.split('|')
      for (const rule of rules) {
        const [ruleName, ruleValue] = rule.split(':')

        switch (ruleName) {
          case 'required':
            html5Rules.required = true
            if (validation.message) errorMessages.required = validation.message
            break
          case 'minlen':
            if (field.type !== 'number') {
              html5Rules.minlength = ruleValue
              if (validation.message) errorMessages.minlength = validation.message
            }
            break
          case 'maxlen':
            if (field.type !== 'number') {
              html5Rules.maxlength = ruleValue
              if (validation.message) errorMessages.maxlength = validation.message
            }
            break
          case 'min':
            if (field.type === 'number') html5Rules.min = ruleValue
            break
          case 'max':
            if (field.type === 'number') html5Rules.max = ruleValue
            break
          case 'email':
            if (validation.message) errorMessages.email = validation.message
            break
          case 'url':
            break
          case 'numeric':
            if (field.type === 'text') {
              html5Rules.pattern = '[0-9]+'
              if (validation.message) errorMessages.pattern = validation.message
            }
            break
          case 'alpha':
            if (field.type === 'text') {
              html5Rules.pattern = '[a-zA-Z]+'
              if (validation.message) errorMessages.pattern = validation.message
            }
            break
          case 'alphanumeric':
            if (field.type === 'text') {
              html5Rules.pattern = '[a-zA-Z0-9]+'
              if (validation.message) errorMessages.pattern = validation.message
            }
            break
          case 'accepted':
            if (field.type === 'checkbox') {
              html5Rules.required = true
              if (validation.message) errorMessages.required = validation.message
            }
            break
          case 'maxsize':
            if (field.type === 'file') {
              const maxBytes = this.#parseSizeStatic(ruleValue)
              attrs += ` data-maxsize="${maxBytes}"`
              if (validation.message) errorMessages.maxsize = validation.message
            }
            break
          case 'minsize':
            if (field.type === 'file') {
              const minBytes = this.#parseSizeStatic(ruleValue)
              attrs += ` data-minsize="${minBytes}"`
              if (validation.message) errorMessages.minsize = validation.message
            }
            break
          case 'mimetype':
          case 'accept':
            if (field.type === 'file') {
              attrs += ` accept="${this.escapeHtml(ruleValue)}"`
              if (validation.message) errorMessages.accept = validation.message
            }
            break
          case 'ext':
            if (field.type === 'file') {
              const exts = ruleValue
                .split(',')
                .map(e => e.trim())
                .map(e => (e.startsWith('.') ? e : '.' + e))
                .join(',')
              attrs += ` accept="${this.escapeHtml(exts)}"`
              if (validation.message) errorMessages.accept = validation.message
            }
            break
          case 'maxfiles':
            if (field.type === 'file' && parseInt(ruleValue) > 1) {
              attrs += ` multiple`
              attrs += ` data-maxfiles="${this.escapeHtml(ruleValue)}"`
              if (validation.message) errorMessages.maxfiles = validation.message
            }
            break
        }
      }
    }

    if (html5Rules.required) attrs += ' required'
    if (html5Rules.minlength) attrs += ` minlength="${html5Rules.minlength}"`
    if (html5Rules.maxlength) attrs += ` maxlength="${html5Rules.maxlength}"`
    if (html5Rules.min) attrs += ` min="${html5Rules.min}"`
    if (html5Rules.max) attrs += ` max="${html5Rules.max}"`
    if (html5Rules.pattern) attrs += ` pattern="${html5Rules.pattern}"`

    if (errorMessages.required) attrs += ` data-error-required="${this.escapeHtml(errorMessages.required)}"`
    if (errorMessages.minlength) attrs += ` data-error-minlength="${this.escapeHtml(errorMessages.minlength)}"`
    if (errorMessages.maxlength) attrs += ` data-error-maxlength="${this.escapeHtml(errorMessages.maxlength)}"`
    if (errorMessages.pattern) attrs += ` data-error-pattern="${this.escapeHtml(errorMessages.pattern)}"`
    if (errorMessages.email) attrs += ` data-error-email="${this.escapeHtml(errorMessages.email)}"`
    if (errorMessages.maxsize) attrs += ` data-error-maxsize="${this.escapeHtml(errorMessages.maxsize)}"`
    if (errorMessages.minsize) attrs += ` data-error-minsize="${this.escapeHtml(errorMessages.minsize)}"`
    if (errorMessages.accept) attrs += ` data-error-accept="${this.escapeHtml(errorMessages.accept)}"`
    if (errorMessages.maxfiles) attrs += ` data-error-maxfiles="${this.escapeHtml(errorMessages.maxfiles)}"`

    return this.appendExtraAttributes(attrs, field)
  }
}

module.exports = Form
