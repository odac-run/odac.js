class OdacWebSocket {
  #url
  #protocols
  #options
  #socket = null
  #reconnectTimer = null
  #reconnectAttempts = 0
  #handlers = {}
  #isClosed = false
  #tokenProvider = null

  constructor(url, protocols = [], options = {}) {
    this.#url = url
    this.#protocols = protocols
    this.#tokenProvider = options.tokenProvider || null
    this.#options = {
      autoReconnect: true,
      reconnectDelay: 3000,
      maxReconnectAttempts: 10,
      ...options
    }
    this.connect()
  }

  async connect() {
    if (this.#isClosed) return

    if (this.#tokenProvider) {
      try {
        const freshToken = await this.#tokenProvider()
        if (freshToken) {
          let current = Array.isArray(this.#protocols) ? this.#protocols : this.#protocols ? [this.#protocols] : []
          this.#protocols = current.filter(p => !p.startsWith('odac-token-'))
          this.#protocols.push(`odac-token-${freshToken}`)
        }
      } catch (e) {
        console.error('Odac WebSocket tokenProvider error:', e)
      }
      if (this.#isClosed) return
    }

    this.#socket = this.#protocols.length > 0 ? new WebSocket(this.#url, this.#protocols) : new WebSocket(this.#url)

    this.#socket.onopen = () => {
      this.#reconnectAttempts = 0
      this.emit('open')
    }

    this.#socket.onmessage = e => {
      try {
        const data = JSON.parse(e.data)
        this.emit('message', data)
      } catch {
        this.emit('message', e.data)
      }
    }

    this.#socket.onclose = e => {
      this.emit('close', e)
      if (this.#options.autoReconnect && !this.#isClosed && this.#reconnectAttempts < this.#options.maxReconnectAttempts) {
        this.#reconnectAttempts++
        this.#reconnectTimer = setTimeout(() => this.connect(), this.#options.reconnectDelay)
      }
    }

    this.#socket.onerror = e => {
      this.emit('error', e)
    }
  }

  emit(event, ...args) {
    if (this.#handlers[event]) {
      this.#handlers[event].forEach(fn => fn(...args))
    }
  }

  on(event, handler) {
    if (!this.#handlers[event]) this.#handlers[event] = []
    this.#handlers[event].push(handler)
    return this
  }

  off(event, handler) {
    if (!this.#handlers[event]) return this
    if (handler) {
      this.#handlers[event] = this.#handlers[event].filter(h => h !== handler)
    } else {
      delete this.#handlers[event]
    }
    return this
  }

  send(data) {
    if (this.#socket && this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(typeof data === 'object' ? JSON.stringify(data) : data)
    }
    return this
  }

  close() {
    this.#isClosed = true
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    if (this.#socket) this.#socket.close()
  }

  get state() {
    return this.#socket ? this.#socket.readyState : WebSocket.CLOSED
  }

  get connected() {
    return this.#socket && this.#socket.readyState === WebSocket.OPEN
  }
}

if (typeof window !== 'undefined') {
  class _odac {
    actions = {}
    #data = null
    #lang = null
    fn = {}
    #page = null
    #token = {hash: [], data: false, pending: null}
    #formSubmitHandlers = new Map()
    #formElementSelectors = new WeakMap()
    #loader = {elements: {}, callback: null, parts: {}}
    #isNavigating = false
    #pendingHash = ''
    #stackScripts = []
    #lazyObserver = null
    #lazyObserved = new Set()

    constructor() {
      // In constructor we can't call this.data() easily if it uses 'this' for caching properly before init
      // But based on original code logic:
      this.#data = this.data()

      const ready = () => {
        this.#initForms()
        this.#initLazy()
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ready)
      } else {
        ready()
      }
    }

    #ajax(options) {
      const {
        url,
        type = 'GET',
        headers = {},
        data = null,
        dataType = 'text',
        success = () => {},
        error = () => {},
        complete = () => {},
        contentType = 'application/x-www-form-urlencoded; charset=UTF-8',
        xhr: xhrFactory
      } = options

      const xhr = xhrFactory ? xhrFactory() : new XMLHttpRequest()

      xhr.open(type, url, true)

      Object.keys(headers).forEach(key => {
        xhr.setRequestHeader(key, headers[key])
      })

      if (contentType && !(data instanceof FormData)) {
        xhr.setRequestHeader('Content-Type', contentType)
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let responseData = xhr.responseText
          const contentTypeHeader = xhr.getResponseHeader('Content-Type')
          const isJson = dataType === 'json' || (contentTypeHeader && contentTypeHeader.includes('application/json'))

          if (isJson) {
            try {
              responseData = JSON.parse(responseData)
            } catch (e) {
              if (dataType === 'json') {
                console.error('JSON parse error:', e)
                error(xhr, 'parseerror', e)
                return
              }
            }
          }

          document.dispatchEvent(
            new CustomEvent('odac:ajaxSuccess', {
              detail: {response: responseData, status: xhr.statusText, xhr, requestUrl: url}
            })
          )

          success(responseData, xhr.statusText, xhr)
        } else {
          error(xhr, xhr.statusText)
        }
      }

      xhr.onerror = () => error(xhr, 'error')
      xhr.onloadend = () => complete()
      xhr.send(data)
    }

    /**
     * Assigns `view-transition-name` CSS properties to all elements carrying
     * the `odac-transition` attribute, enabling the browser's native View
     * Transition API to animate them individually during navigation.
     *
     * @returns {Element[]} The list of elements that received transition names.
     */
    #applyTransitionNames() {
      const elements = document.querySelectorAll('[odac-transition]')
      elements.forEach(el => {
        el.style.viewTransitionName = el.getAttribute('odac-transition')
      })
      return Array.from(elements)
    }

    /**
     * Removes `view-transition-name` from previously tagged elements to
     * prevent stale names from conflicting with future transitions.
     *
     * @param {Element[]} elements - Elements to clean up.
     */
    #clearTransitionNames(elements) {
      elements.forEach(el => {
        el.style.viewTransitionName = ''
      })
    }

    #fade(element, type, duration = 400, callback) {
      const isIn = type === 'in'
      const startOpacity = isIn ? 0 : 1
      const endOpacity = isIn ? 1 : 0

      element.style.opacity = startOpacity
      if (isIn) {
        element.style.display = 'block'
      }

      let startTime = null

      const animate = currentTime => {
        if (!startTime) startTime = currentTime
        const progress = currentTime - startTime
        const opacity = startOpacity + (endOpacity - startOpacity) * Math.min(progress / duration, 1)
        element.style.opacity = opacity

        if (progress < duration) {
          requestAnimationFrame(animate)
        } else {
          if (!isIn) {
            element.style.display = 'none'
          }
          if (callback) callback()
        }
      }
      requestAnimationFrame(animate)
    }

    #fadeIn(element, duration, callback) {
      this.#fade(element, 'in', duration, callback)
    }

    #fadeOut(element, duration, callback) {
      this.#fade(element, 'out', duration, callback)
    }

    #on(element, event, selector, handler) {
      element.addEventListener(event, e => {
        let target = e.target.closest(selector)
        if (target) {
          handler.call(target, e)
        }
      })
    }

    #serialize(form) {
      const params = []
      form.querySelectorAll('input, select, textarea').forEach(el => {
        if (el.name && !el.disabled) {
          if (el.type === 'checkbox' || el.type === 'radio') {
            if (el.checked) {
              params.push(`${encodeURIComponent(el.name)}=${encodeURIComponent(el.value)}`)
            }
          } else if (el.tagName.toLowerCase() === 'select' && el.multiple) {
            Array.from(el.options).forEach(option => {
              if (option.selected) {
                params.push(`${encodeURIComponent(el.name)}=${encodeURIComponent(option.value)}`)
              }
            })
          } else {
            params.push(`${encodeURIComponent(el.name)}=${encodeURIComponent(el.value)}`)
          }
        }
      })
      return params.join('&')
    }

    action(obj) {
      if (obj.function) for (let func in obj.function) this.fn[func] = obj.function[func]

      if (obj.navigate !== undefined && obj.navigate !== false) {
        let selector, elements, callback

        if (typeof obj.navigate === 'string') {
          selector = 'a[href^="/"]:not([data-navigate="false"]):not(.no-navigate)'
          elements = {content: obj.navigate}
          callback = null
        } else if (typeof obj.navigate === 'object') {
          let baseSelector = obj.navigate.links || obj.navigate.selector || 'a[href^="/"]'
          selector = `${baseSelector}:not([data-navigate="false"]):not(.no-navigate)`

          if (obj.navigate.update) {
            elements = typeof obj.navigate.update === 'string' ? {content: obj.navigate.update} : obj.navigate.update
          } else if (obj.navigate.elements) {
            elements = obj.navigate.elements
          } else {
            elements = {content: 'main'}
          }

          callback = obj.navigate.on || obj.navigate.callback || null
        } else if (obj.navigate === true) {
          selector = 'a[href^="/"]:not([data-navigate="false"]):not(.no-navigate)'
          elements = {content: 'main'}
          callback = null
        }

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => {
            this.loader(selector, elements, callback)
          })
        } else {
          this.loader(selector, elements, callback)
        }
      }

      if (obj.start) document.addEventListener('DOMContentLoaded', () => obj.start())
      if (obj.load) {
        if (!this.actions.load) this.actions.load = []
        this.actions.load.push(obj.load)
        document.addEventListener('DOMContentLoaded', () => obj.load())
      }
      if (obj.page) {
        if (!this.actions.page) this.actions.page = {}
        for (let page in obj.page) {
          if (!this.actions.page[page]) this.actions.page[page] = []
          this.actions.page[page].push(obj.page[page])
          if (this.page() == page) document.addEventListener('DOMContentLoaded', () => obj.page[page]())
        }
      }
      if (obj.interval) {
        if (!this.actions.interval) this.actions.interval = {}
        for (let interval in obj.interval) {
          this.actions.interval[interval] = obj.interval[interval]
          if (obj.interval[interval].page && obj.interval[interval].page != this.page()) continue
          this.actions.interval[interval]._ = setInterval(obj.interval[interval].function, obj.interval[interval].interval ?? 1000)
        }
      }
      for (let key in obj) {
        if (['function', 'start', 'load', 'page', 'interval', 'navigate'].includes(key)) continue
        for (let key2 in obj[key]) {
          if (typeof obj[key][key2] == 'function') {
            this.#on(document, key, key2, obj[key][key2])
          } else {
            let split = ''
            if (obj[key][key2].includes('.')) split = '.'
            else if (obj[key][key2].includes('#')) split = '#'
            else if (obj[key][key2].includes(' ')) split = ' '
            const func = split != '' ? obj[key][key2].split(split) : [obj[key][key2]]
            if (func != '') {
              let getfunc = obj
              func.forEach(function (item) {
                getfunc = getfunc[item] !== undefined ? getfunc[item] : getfunc[split + item]
              })
              this.#on(document, key, key2, getfunc)
            }
          }
        }
      }
    }

    client() {
      if (!document.cookie.includes('odac_client=')) return null
      return document.cookie.split('odac_client=')[1].split(';')[0]
    }

    /**
     * Translates a key with the translations the server sent for this page.
     * Why: only keys used in view/js are sent, already resolved for the active language; a
     * key without a translation is returned as is. The result is plain text: insert it with
     * textContent, never innerHTML, since placeholder values may come from user input.
     * @param {string} key
     * @param {...*} args Values for %s / %s1, %s2 placeholders.
     * @returns {string}
     */
    __(key, ...args) {
      return this.#translate(key, '', args)
    }

    /**
     * Translates a key within a context (e.g. __x('Gül', 'verb')), like Odac.__x on the server.
     * @param {string} key
     * @param {string} context
     * @param {...*} args
     * @returns {string}
     */
    __x(key, context, ...args) {
      return this.#translate(key, context == null ? '' : String(context).trim().slice(0, 100), args)
    }

    /**
     * Returns the language the page is served in, or null when no translations were sent.
     * @returns {string|null}
     */
    lang() {
      return this.#translations().lang
    }

    #translations() {
      if (this.#lang) return this.#lang
      let parsed = null
      const script = document.getElementById('odac-lang')
      if (script) {
        try {
          parsed = JSON.parse(script.textContent)
        } catch (e) {
          console.error('Odac: Failed to parse odac-lang', e)
        }
      }
      this.#lang = this.#validTranslations(parsed) ? parsed : {lang: null, t: {}}
      return this.#lang
    }

    /**
     * Applies the served language to `<html lang dir>` after an AJAX navigation.
     * Why: a navigation can switch the language; screen readers, browser translation and
     * `text-transform` read the document's `lang`, which a full load sets on the server.
     * The server omits `document` when the application declares no language.
     */
    // Identifies the translations this page holds (`lang:v`), so the server sends new ones
    // only when the language or their content changed.
    #heldTranslations() {
      const {lang, v} = this.#translations()
      if (!lang) return ''
      return typeof v === 'string' ? `${lang}:${v}` : lang
    }

    #applyDocumentLanguage(served) {
      if (!served || typeof served.lang !== 'string' || !/^[a-z]{2}$/.test(served.lang)) return
      const root = document.documentElement
      root.lang = served.lang
      root.dir = served.dir === 'rtl' ? 'rtl' : 'ltr'
    }

    #validTranslations(value) {
      return !!value && typeof value === 'object' && typeof value.lang === 'string' && !!value.t && typeof value.t === 'object'
    }

    #translate(key, context, args) {
      if (typeof key !== 'string') return key
      const {t} = this.#translations()
      const has = (object, name) => Object.prototype.hasOwnProperty.call(object, name)
      let str
      if (has(t, key)) {
        const value = t[key]
        if (typeof value === 'string') str = context === '' ? value : undefined
        else if (value && typeof value === 'object' && has(value, context)) str = value[context]
      }
      if (typeof str !== 'string' || str === '') str = key
      if (args.length === 0) return str
      // Single pass, so placeholder-like text inside a value is inserted literally.
      if (/%s\d/.test(str)) return str.replace(/%s(\d+)/g, (match, i) => (i > 0 && i <= args.length ? String(args[i - 1]) : match))
      let next = 0
      return str.replace(/%s/g, match => (next < args.length ? String(args[next++]) : match))
    }

    data(key) {
      if (!this.#data) {
        const script = document.getElementById('odac-data')
        if (script) {
          try {
            this.#data = JSON.parse(script.textContent)
          } catch (e) {
            console.error('Odac: Failed to parse odac-data', e)
          }
        }
      }

      if (this.#data) {
        if (key) return this.#data[key] ?? null
        return this.#data
      }

      return null
    }

    form(obj, callback) {
      if (typeof obj != 'object') obj = {form: obj}
      const formSelector = obj.form

      if (this.#formSubmitHandlers.has(formSelector)) {
        const oldHandler = this.#formSubmitHandlers.get(formSelector)
        document.removeEventListener('submit', oldHandler)
      }

      const handler = async e => {
        const formElement = e.target.closest(formSelector)
        if (!formElement) return

        // Ownership guard: a single form can be matched by more than one
        // registered selector — e.g. an <odac:form> auto-bound by #initForms
        // under its data-odac-form token, then re-bound by the app via
        // Odac.form('#id', cb) to attach a callback. The form is tagged with the
        // selector it was last registered under; only that handler may process
        // the submit, so the form fires exactly once instead of 2x. We don't
        // tear down the other selector's listener (it may still serve *other*
        // forms — e.g. a shared '.ajax-form' selector), we just let those
        // handlers ignore this form. Forms never explicitly (re-)bound aren't
        // tracked and fall through normally, preserving delegation for forms
        // added to the DOM after registration.
        const owner = this.#formElementSelectors.get(formElement)
        if (owner && owner !== formSelector) return

        e.preventDefault()

        if (obj.messages !== false) {
          if (obj.messages == undefined || obj.messages == true || obj.messages.includes('error')) {
            formElement.querySelectorAll('*[odac-form-error]').forEach(el => (el.style.display = 'none'))
          }
          if (obj.messages == undefined || obj.messages == true || obj.messages.includes('success')) {
            formElement.querySelectorAll('*[odac-form-success]').forEach(el => (el.style.display = 'none'))
          }
        }

        const inputs = formElement.querySelectorAll('input:not([type="hidden"]), textarea, select')
        let isValid = true
        let firstInvalidInput = null

        const showError = (input, errorType) => {
          isValid = false
          firstInvalidInput = input

          if (input.type !== 'checkbox' && input.type !== 'radio') {
            input.style.borderColor = '#dc3545'
          }

          const customMessage = input.getAttribute(`data-error-${errorType}`)
          if (customMessage) {
            let errorSpan = formElement.querySelector(`[odac-form-error="${input.name}"]`)

            if (!errorSpan) {
              errorSpan = document.createElement('span')
              errorSpan.setAttribute('odac-form-error', input.name)
              if ((input.type === 'checkbox' || input.type === 'radio') && input.id) {
                const label = formElement.querySelector(`label[for="${input.id}"]`)
                label
                  ? label.parentNode.insertBefore(errorSpan, label.nextSibling)
                  : input.parentNode.insertBefore(errorSpan, input.nextSibling)
              } else {
                input.parentNode.insertBefore(errorSpan, input.nextSibling)
              }
            }
            errorSpan.textContent = customMessage
            errorSpan.style.cssText = 'display:block;color:#dc3545;font-size:0.875rem;margin-top:0.25rem'
          }
        }

        for (const input of inputs) {
          input.style.borderColor = ''
          const errorSpan = formElement.querySelector(`[odac-form-error="${input.name}"]`)
          if (errorSpan) {
            errorSpan.style.display = 'none'
            errorSpan.textContent = ''
          }

          if (input.type === 'file') {
            const files = input.files
            if (input.hasAttribute('required') && files.length === 0) {
              showError(input, 'required')
              break
            }
            const maxFiles = parseInt(input.getAttribute('data-maxfiles'))
            if (maxFiles && files.length > maxFiles) {
              showError(input, 'maxfiles')
              break
            }
            const maxSize = parseInt(input.getAttribute('data-maxsize'))
            if (maxSize && [...files].some(f => f.size > maxSize)) {
              showError(input, 'maxsize')
              break
            }
            const minSize = parseInt(input.getAttribute('data-minsize'))
            if (minSize && [...files].some(f => f.size < minSize)) {
              showError(input, 'minsize')
              break
            }
            const accept = input.getAttribute('accept')
            if (accept && files.length) {
              const tokens = accept.split(',').map(t => t.trim().toLowerCase())
              const ok = [...files].every(f =>
                tokens.some(t =>
                  t.startsWith('.') ? f.name.toLowerCase().endsWith(t) : t.endsWith('/*') ? f.type.startsWith(t.slice(0, -1)) : f.type === t
                )
              )
              if (!ok) {
                showError(input, 'accept')
                break
              }
            }
            continue
          }

          if (input.hasAttribute('required')) {
            const isEmpty = input.type === 'checkbox' || input.type === 'radio' ? !input.checked : !input.value.trim()
            if (isEmpty) {
              showError(input, 'required')
              break
            }
          }

          if (input.hasAttribute('minlength') && input.value && input.value.trim().length < parseInt(input.getAttribute('minlength'))) {
            showError(input, 'minlength')
            break
          }

          if (input.hasAttribute('maxlength') && input.value && input.value.trim().length > parseInt(input.getAttribute('maxlength'))) {
            showError(input, 'maxlength')
            break
          }

          if (input.hasAttribute('pattern') && input.value) {
            if (!new RegExp(input.getAttribute('pattern')).test(input.value.trim())) {
              showError(input, 'pattern')
              break
            }
          }

          if (input.type === 'email' && input.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.value.trim())) {
            showError(input, 'email')
            break
          }
        }

        if (!isValid) {
          if (firstInvalidInput) firstInvalidInput.focus()
          return
        }

        if (this.actions.odac?.form?.input?.class?.invalid) {
          const invalidClass = this.actions.odac.form.input.class.invalid
          formElement.querySelectorAll(`.${invalidClass}`).forEach(el => el.classList.remove(invalidClass))
        }

        const token = await this.tokenAsync()
        let datastring, cache, contentType, processData
        if (formElement.querySelector('input[type=file]')) {
          datastring = new FormData(formElement)
          datastring.append('_token', token)
          cache = false
          contentType = false
          processData = false
        } else {
          datastring = this.#serialize(formElement) + '&_token=' + encodeURIComponent(token)
          cache = true
          contentType = 'application/x-www-form-urlencoded; charset=UTF-8'
          processData = true
        }

        const submitButtons = formElement.querySelectorAll('button[type="submit"], input[type="submit"]')
        submitButtons.forEach(btn => {
          btn.disabled = true
          const loadingText = btn.getAttribute('data-loading-text')
          if (loadingText) {
            btn.setAttribute('data-original-text', btn.textContent)
            btn.textContent = loadingText
          }
        })

        formElement.querySelectorAll('input:not([type="hidden"]), textarea, select').forEach(el => (el.disabled = true))

        this.#ajax({
          type: formElement.getAttribute('method'),
          url: formElement.getAttribute('action'),
          data: datastring,
          dataType: 'json',
          contentType: contentType,
          processData: processData,
          cache: cache,
          success: data => {
            if (!data.result) return false

            // Token rotation must always apply on success, independent of messages config.
            // Server has already cleared the old session entry; if we skip this update
            // the next submit sends a stale token and gets "Form session expired".
            if (data.result.success && data.result._token) {
              const tokenInput = formElement.querySelector('input[name="_odac_form_token"]')
              if (tokenInput) tokenInput.value = data.result._token

              const formTokenAttr = formElement.getAttribute('data-odac-form')
              if (formTokenAttr) {
                formElement.setAttribute('data-odac-form', data.result._token)
                if (!formElement.matches(formSelector)) {
                  if (this.#formSubmitHandlers.has(formSelector)) {
                    document.removeEventListener('submit', this.#formSubmitHandlers.get(formSelector))
                    this.#formSubmitHandlers.delete(formSelector)
                  }
                  const newObj = {...obj, form: `form[data-odac-form="${data.result._token}"]`}
                  this.form(newObj, callback)
                }
              }
            }

            if (obj.messages == undefined || obj.messages) {
              if (data.result.success && (obj.messages == undefined || obj.messages.includes('success') || obj.messages == true)) {
                const successEl = formElement.querySelector('*[odac-form-success]')
                if (successEl) {
                  successEl.innerHTML = this.textToHtml(data.result.message)
                  this.#fadeIn(successEl)
                } else {
                  const span = document.createElement('span')
                  span.setAttribute('odac-form-success', obj.form)
                  span.innerHTML = this.textToHtml(data.result.message)
                  formElement.appendChild(span)
                }

                if (obj.clear !== false && formElement.getAttribute('clear') !== 'false' && !data.result.redirect) {
                  formElement
                    .querySelectorAll(
                      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([readonly]), textarea, select'
                    )
                    .forEach(el => {
                      if (el.type === 'checkbox' || el.type === 'radio') el.checked = false
                      else if (el.tagName === 'SELECT') el.selectedIndex = 0
                      else el.value = ''
                    })
                }
              } else if (!data.result.success && data.errors) {
                Object.entries(data.errors).forEach(([name, message]) => {
                  if (message) {
                    let errorEl = formElement.querySelector(`[odac-form-error="${name}"]`)
                    if (errorEl) {
                      errorEl.innerHTML = this.textToHtml(message)
                      errorEl.style.display = 'block'
                      if (!errorEl.style.color) errorEl.style.color = '#dc3545'
                      if (!errorEl.style.fontSize) errorEl.style.fontSize = '0.875rem'
                      if (!errorEl.style.marginTop) errorEl.style.marginTop = '0.25rem'
                    } else {
                      const inputEl = formElement.querySelector(`*[name="${name}"]`)
                      if (inputEl) {
                        const errorEl = document.createElement('span')
                        errorEl.setAttribute('odac-form-error', name)
                        errorEl.innerHTML = this.textToHtml(message)
                        errorEl.style.cssText = 'display:block;color:#dc3545;font-size:0.875rem;margin-top:0.25rem'

                        if ((inputEl.type === 'checkbox' || inputEl.type === 'radio') && inputEl.id) {
                          const label = formElement.querySelector(`label[for="${inputEl.id}"]`)
                          label
                            ? label.parentNode.insertBefore(errorEl, label.nextSibling)
                            : inputEl.parentNode.insertBefore(errorEl, inputEl.nextSibling)
                        } else {
                          inputEl.parentNode.insertBefore(errorEl, inputEl.nextSibling)
                        }
                      } else if (name === '_odac_form') {
                        const errorEl = document.createElement('div')
                        errorEl.setAttribute('odac-form-error', name)
                        errorEl.innerHTML = this.textToHtml(message)
                        errorEl.style.display = 'block'
                        errorEl.style.color = '#dc3545'
                        errorEl.style.fontSize = '0.875rem'
                        errorEl.style.marginBottom = '1rem'
                        formElement.insertBefore(errorEl, formElement.firstChild)
                      }
                    }
                  }
                  const inputEl = formElement.querySelector(`*[name="${name}"]`)
                  if (inputEl) {
                    if (inputEl.type !== 'checkbox' && inputEl.type !== 'radio') inputEl.style.borderColor = '#dc3545'
                    inputEl.addEventListener(
                      'focus',
                      function handler() {
                        inputEl.style.borderColor = ''
                        const errorEl = formElement.querySelector(`[odac-form-error="${name}"]`)
                        if (errorEl) {
                          errorEl.style.display = 'none'
                          errorEl.textContent = ''
                        }
                        inputEl.removeEventListener('focus', handler)
                      },
                      {once: true}
                    )
                  }
                })
              }
            }
            if (data.result.success && data.result.redirect) {
              window.location.href = data.result.redirect
            } else if (callback !== undefined) {
              if (typeof callback === 'function') callback(data)
              else if (data.result.success) window.location.replace(callback)
            }
          },
          xhr: () => {
            const xhr = new window.XMLHttpRequest()
            xhr.upload.addEventListener(
              'progress',
              evt => {
                if (evt.lengthComputable && obj.loading) obj.loading(parseInt((100 / evt.total) * evt.loaded))
              },
              false
            )
            return xhr
          },
          // Transport failures (5xx, timeout, dropped connection, unparsable JSON)
          // must reach the callback too — otherwise the app never learns the
          // submit ended and stays stuck in its own busy state, while `complete`
          // silently re-enables the inputs. Shaped like a server failure response
          // so existing callbacks, which branch on `result.success`, take their
          // error path unchanged.
          error: (xhr, status) => {
            console.error('Odac:', 'Request failed', '\nForm: ' + obj.form + '\nRequest: ' + formElement.getAttribute('action'))
            if (typeof callback === 'function') {
              callback({
                result: {success: false},
                errors: {_odac_form: 'Request failed'},
                status: status,
                xhr: xhr
              })
            }
          },
          complete: () => {
            submitButtons.forEach(btn => {
              btn.disabled = false
              const originalText = btn.getAttribute('data-original-text')
              if (originalText) {
                btn.textContent = originalText
                btn.removeAttribute('data-original-text')
              }
            })
            formElement.querySelectorAll('input:not([type="hidden"]), textarea, select').forEach(el => (el.disabled = false))
          }
        })
      }

      document.addEventListener('submit', handler)
      this.#formSubmitHandlers.set(formSelector, handler)
      document.querySelectorAll(formSelector).forEach(formEl => this.#formElementSelectors.set(formEl, formSelector))
    }

    async get(url, callback) {
      const token = await this.tokenAsync()
      url = url + (url.includes('?') ? '&' : '?') + '_token=' + encodeURIComponent(token)
      this.#ajax({url: url, success: callback})
    }

    page() {
      if (!this.#page) {
        this.#page = document.documentElement.dataset.odacPage || ''
      }
      return this.#page
    }

    storage(key, value) {
      if (value === undefined) return localStorage.getItem(key)
      else if (value === null) return localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    }

    // Shared by token() and tokenAsync(): rotated tokens arrive in X-Odac-Token headers.
    #listenForTokens() {
      if (!this.#token.listener) {
        document.addEventListener('odac:ajaxSuccess', event => {
          const {detail} = event
          if (detail.requestUrl.includes('://')) return false
          try {
            const token = detail.xhr.getResponseHeader('X-Odac-Token')
            if (token) {
              this.#token.hash.push(token)
              if (this.#token.hash.length > 2) this.#token.hash.shift()
            }
          } catch (e) {
            console.error('Error in ajaxSuccess token handler:', e)
          }
        })
        this.#token.listener = true
      }
    }

    // One token request in flight at a time, shared by every caller waiting for it.
    #requestToken() {
      if (!this.#token.pending) {
        const pending = new Promise(resolve => {
          this.#ajax({
            url: '/',
            type: 'GET',
            dataType: 'json',
            headers: {'X-Odac': 'token', 'X-Odac-Client': this.client()},
            success: data => {
              if (data && data.token) this.#token.hash.push(data.token)
              resolve()
            },
            error: () => resolve()
          })
        })
        // Cleared after assignment: a request that completes synchronously must not leave a
        // settled promise behind that would stop every later refill.
        const tracked = pending.finally(() => {
          if (this.#token.pending === tracked) this.#token.pending = null
        })
        this.#token.pending = tracked
      }
      return this.#token.pending
    }

    #takeToken() {
      this.#token.hash = this.#token.hash.filter(n => n)
      const token = this.#token.hash.shift()
      // Keep one token in reserve so the next caller rarely has to wait.
      if (!this.#token.hash.length) this.#requestToken()
      return token
    }

    /**
     * Returns a CSRF token without blocking the page.
     * Why: token() falls back to a synchronous request when no token is cached, which
     * freezes the main thread on a slow network. Every built-in caller uses this instead.
     * @returns {Promise<string|undefined>}
     */
    async tokenAsync() {
      this.#listenForTokens()
      if (!this.#token.hash.filter(n => n).length) await this.#requestToken()
      return this.#takeToken()
    }

    /**
     * Returns a CSRF token synchronously.
     * Kept for existing callers; when no token is cached it has to block on a synchronous
     * request. Prefer `await Odac.tokenAsync()`.
     */
    token() {
      this.#listenForTokens()
      if (!this.#token.hash.length) {
        const req = new XMLHttpRequest()
        req.open('GET', '/', false)
        req.setRequestHeader('X-Odac', 'token')
        req.setRequestHeader('X-Odac-Client', this.client())
        req.send(null)
        try {
          const req_data = JSON.parse(req.response)
          if (req_data && req_data.token) this.#token.hash.push(req_data.token)
        } catch {
          // Not a token response (expired session, proxy error page): no token.
        }
      }
      return this.#takeToken()
    }

    textToHtml(str) {
      if (typeof str !== 'string') return str
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\n/g, '<br>')
    }

    /**
     * Decodes HTML entities back to their plain-text representation.
     * Uses a textarea element as a safe decoder — no script execution risk.
     *
     * @param {string} str - HTML-encoded string (e.g. "&amp;" → "&").
     * @returns {string} Decoded plain-text string.
     */
    #decodeHtmlEntities(str) {
      if (typeof str !== 'string') return str
      const textarea = document.createElement('textarea')
      textarea.innerHTML = str
      return textarea.value
    }

    /**
     * Inserts the `<odac:push>` content of a navigated page into the page's stacks.
     * Why: a component on the next page may need CSS or a script the current page never loaded.
     * Each stack marker (`<template data-odac-stack>`) lists the keys of the items it already
     * has, so an item is inserted once however often pages using it are visited. It runs before
     * the new content is swapped in (styles apply without a flash) and again after it, for the
     * markers that came with the new content. Scripts are kept for #runStackScripts().
     *
     * @param {Object<string, Array<{key: string, html: string}>>} stacks - Response `stacks`.
     * @param {Array} [scripts] - Where pushed scripts are queued (navigation's queue by default).
     */
    #applyStacks(stacks, scripts = this.#stackScripts) {
      if (!stacks || typeof stacks !== 'object') return
      for (const name of Object.keys(stacks)) {
        if (!/^[A-Za-z_][\w-]*$/.test(name) || !Array.isArray(stacks[name])) continue
        const marker = document.querySelector(`template[data-odac-stack="${name}"]`)
        if (!marker || !marker.parentNode) continue
        const keys = new Set((marker.getAttribute('data-odac-keys') || '').split(' ').filter(Boolean))
        for (const item of stacks[name]) {
          if (!item || typeof item.key !== 'string' || typeof item.html !== 'string' || keys.has(item.key)) continue
          keys.add(item.key)
          const holder = document.createElement('template')
          holder.innerHTML = item.html
          for (const node of Array.from(holder.content.childNodes)) {
            if (node.nodeName === 'SCRIPT') scripts.push({marker, node})
            else marker.parentNode.insertBefore(node, marker)
          }
        }
        marker.setAttribute('data-odac-keys', Array.from(keys).join(' '))
      }
    }

    // Scripts parsed from HTML do not run; each pushed script is recreated so the browser runs it.
    // A script whose marker was replaced with its part was queued again for the new marker.
    #runStackScripts(scripts) {
      if (!scripts) {
        scripts = this.#stackScripts
        this.#stackScripts = []
      }
      for (const {marker, node} of scripts) {
        if (!marker.parentNode) continue
        const script = document.createElement('script')
        for (const attribute of Array.from(node.attributes)) script.setAttribute(attribute.name, attribute.value)
        script.textContent = node.textContent
        marker.parentNode.insertBefore(script, marker)
      }
    }

    /**
     * Loads the lazy components (`<c:name lazy>`) of the page: each `<odac-lazy>` placeholder
     * when it comes near the viewport, or right away with `data-odac-when="load"`.
     * Why: the page is sent without the deferred components, and runs again after AJAX
     * navigation and after a lazy component brought placeholders of its own. Placeholders that
     * navigation removed are no longer observed, so the observer holds no detached elements.
     */
    #initLazy() {
      for (const element of this.#lazyObserved) {
        if (element.isConnected) continue
        this.#lazyObserver.unobserve(element)
        this.#lazyObserved.delete(element)
      }
      for (const element of document.querySelectorAll('odac-lazy[data-odac-lazy]:not([data-odac-lazy-state])')) {
        if (this.#lazyObserved.has(element)) continue
        if (element.getAttribute('data-odac-when') === 'load' || typeof IntersectionObserver === 'undefined') {
          this.#loadLazy(element)
          continue
        }
        if (!this.#lazyObserver) {
          this.#lazyObserver = new IntersectionObserver(
            entries => {
              for (const entry of entries) {
                if (!entry.isIntersecting) continue
                this.#lazyObserver.unobserve(entry.target)
                this.#lazyObserved.delete(entry.target)
                this.#loadLazy(entry.target)
              }
            },
            {rootMargin: '200px'}
          )
        }
        this.#lazyObserved.add(element)
        this.#lazyObserver.observe(element)
      }
    }

    // Fetches one lazy component and puts it in place of its placeholder. A failed load keeps
    // the placeholder, marked `data-odac-lazy-state="error"` for styling.
    #loadLazy(element) {
      element.setAttribute('data-odac-lazy-state', 'loading')
      const failed = () => {
        if (!element.isConnected) return
        element.setAttribute('data-odac-lazy-state', 'error')
        document.dispatchEvent(new CustomEvent('odac:lazyError', {detail: {element}}))
      }
      this.#ajax({
        url: '/_odac/lazy?t=' + encodeURIComponent(element.getAttribute('data-odac-lazy')),
        type: 'GET',
        headers: {'X-Odac': 'lazy'},
        dataType: 'json',
        contentType: null,
        success: data => {
          if (!element.isConnected) return
          if (!data || typeof data.html !== 'string') return failed()
          const scripts = []
          this.#applyStacks(data.stacks, scripts)
          const holder = document.createElement('template')
          holder.innerHTML = data.html
          const nodes = Array.from(holder.content.childNodes)
          element.replaceWith(holder.content)
          this.#runStackScripts(scripts)
          this.#initForms()
          this.#initLazy()
          document.dispatchEvent(new CustomEvent('odac:lazy', {detail: {nodes}}))
        },
        error: failed
      })
    }

    load(url, callback, push = true) {
      if (this.#isNavigating) return false

      const currentUrl = window.location.href
      let target
      try {
        target = new URL(url, currentUrl)
      } catch {
        return false
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
      // Only this origin's pages are fetched and written into the DOM; anything else is a
      // normal browser navigation.
      if (target.origin !== new URL(currentUrl).origin) {
        window.location.assign(target.href)
        return false
      }

      const hash = target.hash
      target.hash = ''
      const current = new URL(currentUrl)
      current.hash = ''
      if (hash && target.href === current.href) {
        // An anchor on the current page: the browser scrolls to it.
        window.location.hash = hash
        return false
      }
      url = target.href
      this.#pendingHash = hash

      this.#isNavigating = true

      const currentSkeleton = document.documentElement.dataset.odacSkeleton

      // Merge loader-registered elements with auto-discovered navigate elements
      const elements = {...this.#loader.elements}
      document.querySelectorAll('[data-odac-navigate]').forEach(el => {
        const partName = el.getAttribute('data-odac-navigate')
        if (!elements[partName]) elements[partName] = `[data-odac-navigate="${partName}"]`
      })

      const elementsToUpdate = []
      for (const [key, selector] of Object.entries(elements)) {
        const element = document.querySelector(selector)
        if (element) elementsToUpdate.push({key, element, selector})
      }

      // Build X-Odac-Parts header from current known parts
      const partsHeader = Object.entries(this.#loader.parts)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join(',')

      // Collect part keys to request from server
      const loadKeys = Object.keys(elements)

      const useViewTransition = document.startViewTransition && document.querySelectorAll('[odac-transition]').length > 0

      if (useViewTransition) {
        this.#loadWithViewTransition(url, callback, push, currentUrl, currentSkeleton, elementsToUpdate, partsHeader, loadKeys)
      } else {
        this.#loadWithFade(url, callback, push, currentUrl, currentSkeleton, elementsToUpdate, partsHeader, loadKeys)
      }
    }

    /**
     * Performs page navigation using the browser's native View Transition API.
     * Elements with `odac-transition` attributes receive individual transition
     * names, enabling per-element morphing animations orchestrated by the browser.
     * Non-transition elements still update their content within the transition frame.
     */
    #loadWithViewTransition(url, callback, push, currentUrl, currentSkeleton, elementsToUpdate, partsHeader, loadKeys) {
      const oldTransitionElements = this.#applyTransitionNames()

      const headers = {
        'X-Odac': 'ajaxload',
        'X-Odac-Load': loadKeys.join(','),
        'X-Odac-Skeleton': currentSkeleton || '',
        'X-Odac-Lang': this.#heldTranslations()
      }
      if (partsHeader) headers['X-Odac-Parts'] = partsHeader

      this.#ajax({
        url,
        type: 'GET',
        headers,
        dataType: 'json',
        success: (data, status, xhr) => {
          const finalUrl = xhr.responseURL || url
          if (data.skeletonChanged) {
            this.#clearTransitionNames(oldTransitionElements)
            window.location.href = finalUrl
            return
          }

          // Update tracked parts from server manifest
          if (data.parts) this.#loader.parts = data.parts
          this.#applyStacks(data.stacks)

          // Determine which parts were removed by the new page
          const removedParts = []
          for (const {key, element} of elementsToUpdate) {
            if (data.parts && !(key in data.parts)) removedParts.push({key, element})
          }

          const transition = document.startViewTransition(() => {
            if (finalUrl !== currentUrl && push) window.history.pushState(null, document.title, finalUrl + this.#pendingHash)

            const newPage = xhr.getResponseHeader('X-Odac-Page')
            if (newPage !== null) {
              this.#page = newPage
              document.documentElement.dataset.odacPage = newPage
            }

            if (data.data) this.#data = data.data
            if (this.#validTranslations(data.lang)) this.#lang = data.lang
            this.#applyDocumentLanguage(data.document)
            if (data.title) document.title = this.#decodeHtmlEntities(data.title)

            // Update only parts that have new content from server
            elementsToUpdate.forEach(({key, element}) => {
              if (data.output && data.output[key] !== undefined) element.innerHTML = data.output[key]
            })

            // Clear removed parts
            for (const {element} of removedParts) {
              element.innerHTML = ''
            }

            this.#applyTransitionNames()
          })

          transition.finished
            .then(() => {
              this.#clearTransitionNames(document.querySelectorAll('[odac-transition]'))
              this.#handleLoadComplete(data, callback)
            })
            .catch(() => {
              this.#clearTransitionNames(document.querySelectorAll('[odac-transition]'))
              this.#isNavigating = false
            })
        },
        error: () => {
          this.#clearTransitionNames(oldTransitionElements)
          this.#isNavigating = false
          window.location.replace(url)
        }
      })
    }

    /**
     * Performs page navigation using the legacy fade-in/fade-out animation.
     * Only fades elements whose content actually changed, leaving unchanged
     * parts (like a shared sidebar) completely untouched and visible.
     */
    #loadWithFade(url, callback, push, currentUrl, currentSkeleton, elementsToUpdate, partsHeader, loadKeys) {
      const headers = {
        'X-Odac': 'ajaxload',
        'X-Odac-Load': loadKeys.join(','),
        'X-Odac-Skeleton': currentSkeleton || '',
        'X-Odac-Lang': this.#heldTranslations()
      }
      if (partsHeader) headers['X-Odac-Parts'] = partsHeader

      this.#ajax({
        url,
        type: 'GET',
        headers,
        dataType: 'json',
        success: (data, status, xhr) => {
          const finalUrl = xhr.responseURL || url
          if (data.skeletonChanged) {
            window.location.href = finalUrl
            return
          }
          this.#applyStacks(data.stacks)
          if (finalUrl !== currentUrl && push) window.history.pushState(null, document.title, finalUrl + this.#pendingHash)

          const newPage = xhr.getResponseHeader('X-Odac-Page')
          if (newPage !== null) {
            this.#page = newPage
            document.documentElement.dataset.odacPage = newPage
          }

          if (data.data) this.#data = data.data
          if (this.#validTranslations(data.lang)) this.#lang = data.lang
          this.#applyDocumentLanguage(data.document)
          if (data.title) document.title = this.#decodeHtmlEntities(data.title)
          if (data.parts) this.#loader.parts = data.parts

          // Classify elements: changed, removed, or unchanged
          const changedParts = []
          const removedParts = []

          for (const {key, element} of elementsToUpdate) {
            if (data.output && data.output[key] !== undefined) {
              changedParts.push({key, element})
            } else if (data.parts && !(key in data.parts)) {
              removedParts.push({key, element})
            }
          }

          // Clear removed parts immediately
          for (const {element} of removedParts) {
            element.innerHTML = ''
          }

          // No changed parts — complete immediately
          if (changedParts.length === 0) {
            this.#handleLoadComplete(data, callback)
            return
          }

          // Fade out only changed parts, then swap content and fade in
          let fadeOutCount = 0
          changedParts.forEach(({key, element}) => {
            this.#fadeOut(element, 200, () => {
              element.innerHTML = data.output[key]
              this.#fadeIn(element, 200, () => {
                fadeOutCount++
                if (fadeOutCount === changedParts.length) this.#handleLoadComplete(data, callback)
              })
            })
          })
        },
        error: () => {
          this.#isNavigating = false
          window.location.replace(url)
        }
      })
    }

    #handleLoadComplete(data, callback) {
      this.#applyStacks(data.stacks)
      this.#runStackScripts()
      this.#initForms()
      this.#initLazy()

      if (this.actions.load)
        (Array.isArray(this.actions.load) ? this.actions.load : [this.actions.load]).forEach(fn => fn(this.page(), data.variables))
      if (this.actions.page && this.actions.page[this.page()])
        (Array.isArray(this.actions.page[this.page()]) ? this.actions.page[this.page()] : [this.actions.page[this.page()]]).forEach(fn =>
          fn(data.variables)
        )

      if (callback && typeof callback === 'function') callback(this.page(), data.variables)

      // A link such as /docs#install lands on its section instead of the top of the page.
      const hash = this.#pendingHash
      this.#pendingHash = ''
      let anchor = null
      if (hash) {
        try {
          anchor = document.getElementById(decodeURIComponent(hash.slice(1)))
        } catch {
          anchor = null
        }
      }
      if (anchor) anchor.scrollIntoView({behavior: 'smooth'})
      else window.scrollTo({top: 0, behavior: 'smooth'})
      this.#isNavigating = false
    }

    /**
     * Scans the DOM for ODAC form components and registers submit handlers
     * for any that haven't been initialized yet. Called on DOMContentLoaded
     * and after every AJAX navigation to bind freshly rendered forms.
     */
    #initForms() {
      const formTypes = [
        {cls: 'odac-register-form', attr: 'data-odac-register'},
        {cls: 'odac-login-form', attr: 'data-odac-login'},
        {cls: 'odac-magic-login-form', attr: 'data-odac-magic-login'},
        {cls: 'odac-custom-form', attr: 'data-odac-form'}
      ]

      for (const {cls, attr} of formTypes) {
        document.querySelectorAll(`form.${cls}[${attr}]`).forEach(form => {
          // Skip forms the app already bound via Odac.form(...) — re-registering
          // here would attach a second handler and cause 2x submit.
          if (this.#formElementSelectors.has(form)) return
          const token = form.getAttribute(attr)
          const selector = `form[${attr}="${token}"]`
          if (!this.#formSubmitHandlers.has(selector)) {
            this.form({form: selector})
          }
        })
      }
    }

    loader(selector, elements, callback, initialParts) {
      this.#loader.elements = elements
      this.#loader.callback = callback
      if (initialParts) this.#loader.parts = initialParts
      const odacInstance = this

      this.#on(document, 'click', selector, function (e) {
        if (e.ctrlKey || e.metaKey) return
        const anchor = this
        if (!anchor) return
        const url = anchor.getAttribute('href')
        const target = anchor.getAttribute('target')
        if (!url || url.startsWith('#')) return
        if (target !== null && target !== '_self') return
        // Compare origins, not substrings: '//evil.example/x' matches a[href^="/"] and
        // 'https://evil.example/?site.com' contains the host, yet both leave the site.
        let destination
        try {
          destination = new URL(url, window.location.href)
        } catch {
          return
        }
        const here = new URL(window.location.href)
        if (destination.protocol !== 'http:' && destination.protocol !== 'https:') return
        if (destination.origin !== here.origin) return
        // An anchor on the current page is the browser's job.
        if (destination.hash && destination.pathname === here.pathname && destination.search === here.search) return
        e.preventDefault()
        odacInstance.load(destination.href, callback)
      })

      window.addEventListener('popstate', () => {
        this.load(window.location.href, callback, false)
      })
    }

    listen(url, onMessage, options = {}) {
      const {onError = null, onOpen = null, autoReconnect = false, reconnectDelay = 3000} = options
      let eventSource = null,
        reconnectTimer = null,
        isClosed = false

      const connect = async () => {
        if (isClosed) return
        const token = await this.tokenAsync()
        if (isClosed) return
        const urlWithToken = url + (url.includes('?') ? '&' : '?') + '_token=' + encodeURIComponent(token)
        eventSource = new EventSource(urlWithToken)
        eventSource.onopen = e => {
          if (onOpen) onOpen(e)
        }
        eventSource.onmessage = e => {
          try {
            onMessage(JSON.parse(e.data))
          } catch {
            onMessage(e.data)
          }
        }
        eventSource.onerror = e => {
          if (onError) onError(e)
          if (autoReconnect && !isClosed) {
            eventSource.close()
            reconnectTimer = setTimeout(connect, reconnectDelay)
          }
        }
      }
      connect()

      return {
        close: () => {
          isClosed = true
          if (reconnectTimer) clearTimeout(reconnectTimer)
          if (eventSource) eventSource.close()
        },
        send: () => {
          throw new Error('SSE is one-way. Use POST requests to send data.')
        }
      }
    }

    ws(path, options = {}) {
      const {autoReconnect = true, reconnectDelay = 3000, maxReconnectAttempts = 10, shared = false, token = true} = options

      if (shared && typeof SharedWorker !== 'undefined') {
        return this.#createSharedWebSocket(path, {autoReconnect, reconnectDelay, maxReconnectAttempts, token})
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${protocol}//${window.location.host}${path}`
      const protocols = []
      const tokenProvider = token ? () => this.tokenAsync() : null

      return new OdacWebSocket(wsUrl, protocols, {...options, tokenProvider})
    }

    #createSharedWebSocket(path, options) {
      const scriptUrl = (() => {
        if (document.currentScript) return document.currentScript.src
        const scripts = document.querySelectorAll('script')
        for (let i = 0; i < scripts.length; i++) {
          if (scripts[i].src.includes('odac.js')) return scripts[i].src
        }
        return '/odac.js'
      })()
      const worker = new SharedWorker(scriptUrl, `odac-ws-${path}`)
      const handlers = {}
      let isConnected = false

      const emit = (event, ...args) => {
        if (handlers[event]) handlers[event].forEach(fn => fn(...args))
      }

      worker.port.onmessage = e => {
        const {type, data} = e.data
        switch (type) {
          case 'open':
            isConnected = true
            emit('open')
            break
          case 'message':
            emit('message', data)
            break
          case 'close':
            isConnected = false
            emit('close', data)
            break
          case 'error':
            emit('error', data)
            break
          case 'requestToken':
            this.tokenAsync().then(token => worker.port.postMessage({type: 'provideToken', token}))
            break
        }
      }

      worker.port.start()

      Promise.resolve(options.token ? this.tokenAsync() : null).then(token =>
        worker.port.postMessage({
          type: 'connect',
          path,
          host: window.location.host,
          protocol: window.location.protocol === 'https:' ? 'wss:' : 'ws:',
          token,
          options
        })
      )

      return {
        on: (event, handler) => {
          if (!handlers[event]) handlers[event] = []
          handlers[event].push(handler)
          return this
        },
        off: (event, handler) => {
          if (!handlers[event]) return
          if (handler) {
            handlers[event] = handlers[event].filter(h => h !== handler)
          } else {
            delete handlers[event]
          }
          return this
        },
        send: data => {
          worker.port.postMessage({
            type: 'send',
            data: typeof data === 'object' ? JSON.stringify(data) : data
          })
          return this
        },
        close: () => {
          worker.port.postMessage({type: 'close'})
          worker.port.close()
        },
        get connected() {
          return isConnected
        }
      }
    }
  }

  window.Odac = new _odac()
  // __() and __x() as globals, the way views write them. A global another script already
  // defined is left alone; Odac.__() and Odac.__x() always work.
  for (const name of ['__', '__x']) {
    const current = window[name]
    if (current !== undefined && !current.odac) {
      console.warn(`Odac: window.${name} is already defined; use Odac.${name}() instead.`)
      continue
    }
    const alias = (...args) => window.Odac[name](...args)
    alias.odac = true
    window[name] = alias
  }
  ;(function initAutoNavigate() {
    const init = () => {
      const navigateElements = document.querySelectorAll('[data-odac-navigate]')
      if (navigateElements.length === 0) return

      const elements = {}
      navigateElements.forEach(el => {
        const partName = el.getAttribute('data-odac-navigate')
        elements[partName] = `[data-odac-navigate="${partName}"]`
      })

      // Initialize parts state from server-rendered data attribute
      const partsAttr = document.documentElement.dataset.odacParts
      let initialParts = {}
      if (partsAttr) {
        try {
          initialParts = JSON.parse(partsAttr)
        } catch (e) {
          console.error('Odac: Failed to parse data-odac-parts attribute.', e)
          // Graceful fallback if attribute is malformed
        }
      }

      window.Odac.loader('a[href^="/"]:not([data-navigate="false"]):not(.no-navigate)', elements, null, initialParts)
    }
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init()
  })()
} else {
  let socket = null
  const ports = new Set()

  const broadcast = (type, data) => ports.forEach(port => port.postMessage({type, data}))

  let wsConfig = null
  let reconnectAttempts = 0
  let reconnectTimer = null

  const requestTokenFromPort = () => {
    return new Promise(resolve => {
      const firstPort = ports.values().next().value
      if (!firstPort) return resolve(null)

      let timeoutTimer = null

      const handler = event => {
        if (event.data.type === 'provideToken') {
          clearTimeout(timeoutTimer)
          firstPort.removeEventListener('message', handler)
          resolve(event.data.token)
        }
      }

      timeoutTimer = setTimeout(() => {
        firstPort.removeEventListener('message', handler)
        resolve(null)
      }, 5000)

      firstPort.addEventListener('message', handler)
      firstPort.postMessage({type: 'requestToken'})
    })
  }

  const connectSocket = protocols => {
    if (!wsConfig || ports.size === 0) return
    const wsUrl = wsConfig.protocol + '//' + wsConfig.host + wsConfig.path
    socket = new OdacWebSocket(wsUrl, protocols, {
      ...wsConfig.options,
      tokenProvider: null
    })
    socket.on('open', () => {
      reconnectAttempts = 0
      broadcast('open')
    })
    socket.on('message', data => broadcast('message', data))
    socket.on('close', e => {
      broadcast('close', {code: e?.code, reason: e?.reason, wasClean: e?.wasClean})
      const maxAttempts = wsConfig.options.maxReconnectAttempts || 10
      if (wsConfig && wsConfig.options.autoReconnect !== false && ports.size > 0 && reconnectAttempts < maxAttempts) {
        if (socket) {
          socket.close()
          socket = null
        }
        reconnectAttempts++
        reconnectTimer = setTimeout(() => {
          requestTokenFromPort().then(freshToken => {
            if (!freshToken || ports.size === 0) return
            connectSocket(['odac-token-' + freshToken])
          })
        }, wsConfig.options.reconnectDelay || 1000)
      }
    })
    socket.on('error', e => broadcast('error', {message: e?.message || 'WebSocket error'}))
  }

  self.onconnect = e => {
    const port = e.ports[0]
    ports.add(port)

    port.onmessage = event => {
      const {type, path, host, protocol, token, options, data} = event.data

      switch (type) {
        case 'connect':
          if (!socket) {
            wsConfig = {host, path, protocol, options}
            const protocols = token ? ['odac-token-' + token] : []
            connectSocket(protocols)
          } else if (socket.connected) {
            port.postMessage({type: 'open'})
          }
          break
        case 'send':
          if (socket) socket.send(data)
          break
        case 'close':
          ports.delete(port)
          if (ports.size === 0) {
            if (reconnectTimer) {
              clearTimeout(reconnectTimer)
              reconnectTimer = null
            }
            if (socket) {
              socket.close()
              socket = null
            }
          }
          break
      }
    }

    port.start()
  }
}
