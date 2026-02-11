const net = require('net')
const nodeCrypto = require('crypto')
const fs = require('fs')
// const Form = require('./View/Form')

const CACHE_DIR = './storage/.cache'

class Mail {
  #header = {}
  #from
  #subject = ''
  #template
  #to
  #htmlContent
  #textContent

  constructor(template) {
    this.#template = template
  }

  #functions = {
    '{!!': {
      function: '${await ',
      close: '!!}',
      end: '}'
    },
    '{{--': {
      function: '`; /*',
      close: '--}}',
      end: '*/ html += `'
    },
    '{{': {
      function: '${Odac.Var(await ',
      close: '}}',
      end: ').html().replace(/\\n/g, "<br>")}'
    },
    break: {
      function: 'break;',
      arguments: {}
    },
    component: {},
    continue: {
      function: 'continue;',
      arguments: {}
    },
    mysql: {},
    elseif: {
      function: '} else if(await ($condition)){',
      arguments: {
        condition: true
      }
    },
    else: {
      function: '} else {'
    },
    fetch: {},
    for: {
      function: '{ let _arr = $constructor; for(let $key in _arr){ let $value = _arr[$key];',
      end: '}}',
      arguments: {
        var: null,
        get: null,
        key: 'key',
        value: 'value'
      }
    },
    if: {
      function: 'if(await ($condition)){',
      arguments: {
        condition: true
      }
    },
    '<odac:js>': {
      end: ' html += `',
      function: '`; ',
      close: '</odac:js>'
    },
    lazy: {},
    list: {
      arguments: {
        var: null,
        get: null,
        key: 'key',
        value: 'value'
      },
      end: '}}',
      function: '{ let _arr = $constructor; for(let $key in _arr){ let $value = _arr[$key];',
      replace: 'ul'
    },
    while: {
      function: 'while(await ($condition)){',
      arguments: {
        condition: true
      }
    }
  }

  #parseOdacTag(content) {
    // Parse backend comments
    content = content.replace(/<!--odac([\s\S]*?)(?:odac-->|-->)/g, () => '')

    // Parse <script:odac> tags
    content = content.replace(/<script:odac([^>]*)>([\s\S]*?)<\/script:odac>/g, (fullMatch, attributes, jsContent) => {
      return `<odac:js>${jsContent}</odac:js>`
    })

    content = content.replace(/<odac:else\s*\/>/g, '<odac:else>')
    content = content.replace(/<odac:elseif\s+([^>]*?)\/>/g, '<odac:elseif $1>')

    content = content.replace(/<odac([^>]*?)\/>/g, (fullMatch, attributes) => {
      attributes = attributes.trim()
      const attrs = {}
      const attrRegex = /(\w+)(?:=(["'])((?:(?!\2).)*)\2|=([^\s>]+))?/g
      let match
      while ((match = attrRegex.exec(attributes))) {
        const key = match[1]
        const value = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : true
        attrs[key] = value
      }

      if (attrs.get) return `{{ get('${attrs.get}') || '' }}`
      else if (attrs.var) return attrs.raw ? `{!! ${attrs.var} !!}` : `{{ ${attrs.var} }}`

      return fullMatch
    })

    let depth = 0
    let maxDepth = 10
    while (depth < maxDepth && content.includes('<odac')) {
      const before = content
      content = content.replace(/<odac([^>]*)>((?:(?!<odac)[\s\S])*?)<\/odac>/g, (fullMatch, attributes, innerContent) => {
        attributes = attributes.trim()
        innerContent = innerContent.trim()

        const attrs = {}
        const attrRegex = /(\w+)(?:=(["'])((?:(?!\2).)*)\2|=([^\s>]+))?/g
        let match
        while ((match = attrRegex.exec(attributes))) {
          const key = match[1]
          const value = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : true
          attrs[key] = value
        }

        if (attrs.get) return `{{ get('${attrs.get}') || '' }}`
        else if (attrs.var) return attrs.raw ? `{!! ${attrs.var} !!}` : `{{ ${attrs.var} }}`
        else if (attrs.t || attrs.translate)
          return `{{ '${innerContent}' }}` // Simple fallback for mail
        else return `{{ '${innerContent}' }}`
      })
      if (before === content) break
      depth++
    }

    return content
  }

  async #render(file, data) {
    const fd = fs.openSync(file, 'r')
    let mtime, content
    try {
      mtime = fs.fstatSync(fd).mtimeMs
      content = fs.readFileSync(fd, 'utf8')
    } finally {
      fs.closeSync(fd)
    }

    // Since mail doesn't have a persistent Odac instance access like View cache, we manage a simple cache or just re-compile.
    // For performance in emails (usually background), re-compiling is okay, but caching is better.
    // Let's use global Odac.View.cache if available or local.
    if (!Odac.View) Odac.View = {}
    if (!Odac.View.cache) Odac.View.cache = {}

    if (Odac.View.cache[file]?.mtime !== mtime) {
      // No Form options needed normally for simplified email templates, but keeping Form.parse for consistency if needed
      // content = Form.parse(content, {Request: {}, ...Odac}) // Partially mock if Form needs it, but Form usually needs full Request.
      // Skipping Form.parse for mail for now unless requested, as it relies on Session/Request heavily.
      // User asked for "View file rendering", usually meaning logic tags.

      const jsBlocks = []
      content = content.replace(/<script:odac([^>]*)>([\s\S]*?)<\/script:odac>/g, (match, attrs, jsContent) => {
        const placeholder = `___ODAC_JS_BLOCK_${jsBlocks.length}___`
        jsBlocks.push(jsContent)
        return `<script:odac${attrs}>${placeholder}</script:odac>`
      })

      content = this.#parseOdacTag(content)
      content = content.replace(/`/g, '\\\\`').replace(/\$\{/g, '\\\\${')

      jsBlocks.forEach((jsContent, index) => {
        content = content.replace(`___ODAC_JS_BLOCK_${index}___`, jsContent)
      })

      let result = 'html += `\n' + content + '\n`'
      content = content.split('\n')

      for (let key in this.#functions) {
        let att = ''
        let func = this.#functions[key]
        let matches = func.close
          ? result.match(new RegExp(`${key}[\\s\\S]*?${func.close}`, 'g'))
          : result.match(new RegExp(`<odac:${key}(?:\\s+[^>]*?(?:"[^"]*"|'[^']*'|[^"'>])*)?>`, 'g'))
        if (!matches) continue
        for (let match of matches) {
          let matchForParsing = match
          if (!func.close) matchForParsing = matchForParsing.replace(/^<odac:/, '').replace(/>$/, '')
          const attrRegex = /(\w+)(?:=(["'])((?:(?!\2).)*)\2|=([^\s>]+))?/g
          let attrMatch
          const args = []
          while ((attrMatch = attrRegex.exec(matchForParsing))) {
            args.push(attrMatch[0])
          }
          let vars = {}
          if (func.arguments)
            for (let arg of args) {
              const argRegex = /(\w+)(?:=(["'])((?:(?!\2).)*)\2|=([^\s>]+))?/
              const argMatch = argRegex.exec(arg)
              if (!argMatch) continue
              const argKey = argMatch[1]
              const value = argMatch[3] !== undefined ? argMatch[3] : argMatch[4] !== undefined ? argMatch[4] : true
              if (func.arguments[argKey] === undefined) {
                att += `${argKey}="${value}"`
                continue
              }
              vars[argKey] = value
            }
          if (!func.function) continue
          let fun = func.function

          // Simplified logic for loop
          if (key === 'for' || key === 'list') {
            let constructor
            if (vars.var) {
              constructor = `await ${vars.var}`
              delete vars.var
            }
            fun = fun.replace(/\$constructor/g, constructor)
          }

          for (let argKey in func.arguments) {
            if (argKey === 'var' || argKey === 'get') continue
            if (vars[argKey] === undefined) vars[argKey] = func.arguments[argKey]
            fun = fun.replace(new RegExp(`\\$${argKey}`, 'g'), vars[argKey])
          }
          if (func.close) {
            result = result.replace(match, fun + match.substring(key.length, match.length - func.close.length) + func.end)
          } else {
            result = result.replace(match, (func.replace ? `<${[func.replace, att].join(' ')}>` : '') + '`; ' + fun + ' html += `')
            result = result.replace(`</odac:${key}>`, '`; ' + (func.end ?? '}') + ' html += `' + (func.replace ? `</${func.replace}>` : ''))
          }
        }
      }

      let cache = `${nodeCrypto.createHash('md5').update(file).digest('hex')}`
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, {recursive: true})
      fs.writeFileSync(
        `${CACHE_DIR}/${cache}`,
        `module.exports = async (Odac, data, get, __) => {\n
           // Destructure data keys into local scope variables
           ${Object.keys(data)
             .map(k => `let ${k} = data['${k}'];`)
             .join('\n')}
           let html = '';\n${result}\nreturn html.trim()\n}`
      )
      delete require.cache[require.resolve(`${__dir}/${CACHE_DIR}/${cache}`)]
      Odac.View.cache[file] = {mtime: mtime, cache: cache}
    }

    try {
      return await require(`${__dir}/${CACHE_DIR}/${Odac.View.cache[file].cache}`)(
        Odac,
        data,
        key => data[key],
        (...args) => (Odac.Lang ? Odac.Lang.get(...args) : args[0])
      )
    } catch (e) {
      console.error(e)
      return ''
    }
  }

  header(header) {
    this.#header = header
    return this
  }

  from(email, name) {
    this.#from = {email: email, name: name}
    return this
  }

  subject(subject) {
    this.#subject = subject
    return this
  }

  to(email, name = '') {
    this.#to = {value: [{address: email, name: name}]}
    return this
  }

  html(content) {
    this.#htmlContent = content
    return this
  }

  text(content) {
    this.#textContent = content
    return this
  }

  #encode(text) {
    if (!text) return ''
    // eslint-disable-next-line
    if (/^[\x00-\x7F]*$/.test(text)) return text
    return '=?UTF-8?B?' + Buffer.from(text).toString('base64') + '?='
  }

  #stripHtml(html) {
    if (!html) return ''

    let text = html
    // Recursively remove script and style tags to handle nested injections
    // Single-pass removal for plain text generation.
    // Recursive removal (do-while) is dangerous (ReDoS) and unnecessary for text/plain output.
    text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gim, '')
    text = text.replace(/<[^>]+>/g, '')

    return text.replace(/\s+/g, ' ').trim()
  }

  send(data = {}) {
    return new Promise(resolve => {
      ;(async () => {
        try {
          if (!this.#from || !this.#subject || !this.#to) {
            console.error('[Mail] Missing required fields: From, Subject, or To')
            return resolve(false)
          }

          if (!Odac.Var(this.#from.email).is('email')) {
            console.error('[Mail] From field is not a valid e-mail address')
            return resolve(false)
          }

          if (!Odac.Var(this.#to.value[0].address).is('email')) {
            console.error('[Mail] To field is not a valid e-mail address')
            return resolve(false)
          }

          let htmlContent = ''
          let textContent = ''

          if (this.#template) {
            if (!fs.existsSync(__dir + '/view/mail/' + this.#template + '.html')) {
              console.error(`[Mail] Template not found: ${__dir}/view/mail/${this.#template}.html`)
              return resolve(false)
            }
            htmlContent = await this.#render(__dir + '/view/mail/' + this.#template + '.html', data)
            textContent = this.#stripHtml(htmlContent)
          } else {
            if (this.#htmlContent) htmlContent = this.#htmlContent
            if (this.#textContent) textContent = this.#textContent

            if (!htmlContent && !textContent) {
              console.error('[Mail] No content provided (Template, HTML, or Text)')
              return resolve(false)
            }

            // If only HTML is provided, auto-generate text
            if (htmlContent && !textContent) {
              textContent = this.#stripHtml(htmlContent)
            }
          }

          if (!this.#header['From']) this.#header['From'] = `${this.#encode(this.#from.name)} <${this.#from.email}>`
          if (!this.#header['To']) {
            const t = this.#to.value[0]
            this.#header['To'] = t.name ? `${this.#encode(t.name)} <${t.address}>` : t.address
          }
          if (!this.#header['Subject']) this.#header['Subject'] = this.#encode(this.#subject)
          if (!this.#header['Message-ID']) this.#header['Message-ID'] = `<${nodeCrypto.randomBytes(16).toString('hex')}-${Date.now()}@odac>`

          if (!this.#header['Date']) this.#header['Date'] = new Date().toUTCString()
          if (!this.#header['Content-Type']) {
            if (htmlContent) {
              this.#header['Content-Type'] =
                'multipart/alternative; charset=UTF-8; boundary="----=' + nodeCrypto.randomBytes(32).toString('hex') + '"'
            } else {
              this.#header['Content-Type'] = 'text/plain; charset=UTF-8'
            }
          }
          if (!this.#header['X-Mailer']) this.#header['X-Mailer'] = 'ODAC'
          if (!this.#header['MIME-Version']) this.#header['MIME-Version'] = '1.0'

          const client = new net.Socket()
          const payload = {
            auth: process.env.ODAC_API_KEY,
            action: 'mail.send',
            data: [
              {
                subject: this.#subject,
                from: {value: [{address: this.#from.email, name: this.#from.name}]},
                to: this.#to,
                header: this.#header,
                html: htmlContent,
                text: textContent,
                attachments: []
              }
            ]
          }

          const socketPath = process.env.ODAC_API_SOCKET || '/odac/api.sock'

          if (Odac.Config.debug) console.log(`[Mail] Connecting to Odac Core via Unix Socket: ${socketPath}...`)

          client.connect(socketPath, () => {
            if (Odac.Config.debug) console.log('[Mail] Connected to Odac Core. Sending payload...')
            client.write(JSON.stringify(payload))
          })

          client.on('data', data => {
            if (Odac.Config.debug) console.log('[Mail] Received data from server:', data.toString())
            try {
              const response = JSON.parse(data.toString())
              resolve(response)
            } catch (error) {
              console.error('[Mail] Error parsing response:', error)
              resolve(false)
            }
            client.destroy()
          })

          client.on('error', error => {
            if (error.code === 'ENOENT' && error.address === socketPath) {
              console.error(
                '[Mail] Socket Error: If you are using ODAC, you must grant permissions or enter SMTP information in the config.'
              )
            } else {
              console.error('[Mail] Socket Error:', error)
            }
            resolve(false)
          })

          client.on('close', () => {
            if (Odac.Config.debug) console.log('[Mail] Connection closed')
          })
        } catch (error) {
          console.error('[Mail] Unexpected error:', error)
          resolve(false)
        }
      })()
    })
  }
}

module.exports = new Proxy(Mail, {
  apply(target, thisArg, args) {
    return new target(...args)
  }
})
