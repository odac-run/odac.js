const net = require('net')
const nodeCrypto = require('crypto')
const fs = require('fs')
const fsPromises = fs.promises
// const Form = require('./View/Form')

const {cacheName, compile} = require('./View/Compiler')
const {isLocalName} = require('./View/Identifiers')

const CACHE_DIR = 'storage/.cache'
// Header values and display names end up as raw header lines; CR/LF would start new headers.
const stripLineBreaks = value => (value === undefined || value === null ? value : String(value).replace(/[\r\n]+/g, ' '))

class Mail {
  static #compiled = new Map()
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

  /**
   * Renders a mail template with `data`.
   * Why: data keys become local variables, so `{{ name }}` works for `send({name})`. They are
   * declared per compiled variant (one per key set) from validated identifiers only. Declaring
   * the first call's keys into a cached module made later calls with other keys throw (and
   * send an empty mail), broke on keys such as `html` or `first-name`, and executed any key
   * that came from user input. Every key stays reachable through `get('key')`.
   * Render errors propagate, so send() fails instead of delivering an empty body.
   */
  async #render(file, data) {
    let mtime, content
    const handle = await fsPromises.open(file, 'r')
    try {
      mtime = (await handle.stat()).mtimeMs
      content = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }

    const locals = Object.keys(data).filter(isLocalName).sort()
    const variant = `${file}\u0000${locals.join(',')}`
    let compiled = Mail.#compiled.get(variant)

    if (compiled?.mtime !== mtime) {
      const name = cacheName('mail', variant)
      const dir = `${__dir}/${CACHE_DIR}`
      const target = `${dir}/${name}`
      const declarations = locals.map(key => `let ${key} = data[${JSON.stringify(key)}];`).join('\n')
      await fsPromises.mkdir(dir, {recursive: true})
      // Written to a temporary file and renamed so a concurrent render never loads half a module.
      const temp = `${target}.${process.pid}.${nodeCrypto.randomBytes(4).toString('hex')}.tmp`
      await fsPromises.writeFile(
        temp,
        `module.exports = async (Odac, data, get, __, __x) => {\n${declarations}\nlet html = '';\n${compile(content, {file})}\nreturn html.trim()\n}`
      )
      await fsPromises.rename(temp, target)
      delete require.cache[require.resolve(target)]
      compiled = {mtime, target}
      Mail.#compiled.set(variant, compiled)
    }

    return require(compiled.target)(
      Odac,
      data,
      key => data[key],
      (...args) => (Odac.Lang ? Odac.Lang.get(...args) : args[0]),
      (key, context, ...args) => (Odac.Lang ? Odac.Lang.getx(key, context, ...args) : key)
    )
  }

  header(header) {
    this.#header = {}
    for (const [name, value] of Object.entries(header ?? {})) {
      // RFC 5322 field names are printable ASCII without ':'.
      if (/^[!-9;-~]+$/.test(name)) this.#header[name] = stripLineBreaks(value)
    }
    return this
  }

  from(email, name) {
    this.#from = {email: email, name: stripLineBreaks(name)}
    return this
  }

  subject(subject) {
    this.#subject = stripLineBreaks(subject)
    return this
  }

  to(email, name = '') {
    this.#to = {value: [{address: email, name: stripLineBreaks(name)}]}
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

  #wrapLines(content, limit = 76) {
    if (!content) return ''
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const out = []
    for (const line of normalized.split('\n')) {
      if (Buffer.byteLength(line, 'utf8') <= limit) {
        out.push(line)
        continue
      }
      let buf = ''
      let bufBytes = 0
      const flush = () => {
        if (buf.length) out.push(buf)
        buf = ''
        bufBytes = 0
      }
      for (const word of line.split(/(\s+)/)) {
        if (!word) continue
        const wordBytes = Buffer.byteLength(word, 'utf8')
        if (bufBytes + wordBytes <= limit) {
          buf += word
          bufBytes += wordBytes
          continue
        }
        if (buf.length && /^\s+$/.test(word)) {
          flush()
          continue
        }
        if (buf.length) flush()
        if (wordBytes <= limit) {
          buf = word
          bufBytes = wordBytes
          continue
        }
        let chunk = ''
        let chunkBytes = 0
        for (const ch of word) {
          const chBytes = Buffer.byteLength(ch, 'utf8')
          if (chunkBytes + chBytes > limit) {
            out.push(chunk)
            chunk = ''
            chunkBytes = 0
          }
          chunk += ch
          chunkBytes += chBytes
        }
        if (chunk.length) {
          buf = chunk
          bufBytes = chunkBytes
        }
      }
      flush()
    }
    return out.join('\r\n')
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
            try {
              await fsPromises.access(__dir + '/view/mail/' + this.#template + '.html')
            } catch {
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

          // RFC 5321 §4.5.3.1.6: SMTP lines must be ≤1000 octets including CRLF.
          // Wrap to 990 chars for HTML and 76 for text to prevent SMTP rejection.
          htmlContent = this.#wrapLines(htmlContent, 990)
          textContent = this.#wrapLines(textContent)

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
                `[Mail] Mail is delivered through the ODAC Core socket (${socketPath}), which was not found. ` +
                  'Run the app under ODAC (with mail permission) or point ODAC_API_SOCKET at the Core socket.'
              )
            } else {
              console.error('[Mail] Socket Error:', error)
            }
            resolve(false)
          })

          client.on('close', () => {
            if (Odac.Config.debug) console.log('[Mail] Connection closed')
            // If the peer closed before sending a parseable response, resolve
            // is a no-op (already settled); otherwise it prevents send() from
            // hanging forever on a silent disconnect.
            resolve(false)
          })

          // Never wait indefinitely for the Core to answer.
          const timeoutMs = (Odac.Config.mail && Odac.Config.mail.timeout) || 30000
          client.setTimeout(timeoutMs, () => {
            console.error(`[Mail] No response from Odac Core within ${timeoutMs}ms; aborting.`)
            resolve(false)
            client.destroy()
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
