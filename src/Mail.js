const net = require('net')
const crypto = require('crypto')
const fs = require('fs')

class Mail {
  #header = {}
  #from
  #subject = ''
  #template
  #to

  constructor(template) {
    this.#template = template
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

  #encode(text) {
    if (!text) return ''
    if (/^[\x00-\x7F]*$/.test(text)) return text
    return '=?UTF-8?B?' + Buffer.from(text).toString('base64') + '?='
  }

  send(data = {}) {
    return new Promise(async resolve => {
      try {
        if (!fs.existsSync(__dir + '/view/mail/' + this.#template + '.html')) {
          console.error(`[Mail] Template not found: ${__dir}/view/mail/${this.#template}.html`)
          return resolve(false)
        }
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
        if (!this.#header['From']) this.#header['From'] = `${this.#encode(this.#from.name)} <${this.#from.email}>`
        if (!this.#header['To']) {
          const t = this.#to.value[0]
          this.#header['To'] = t.name ? `${this.#encode(t.name)} <${t.address}>` : t.address
        }
        if (!this.#header['Subject']) this.#header['Subject'] = this.#encode(this.#subject)
        if (!this.#header['Message-ID']) this.#header['Message-ID'] = `<${crypto.randomBytes(16).toString('hex')}-${Date.now()}@odac>`

        if (!this.#header['Date']) this.#header['Date'] = new Date().toUTCString()
        if (!this.#header['Content-Type'])
          this.#header['Content-Type'] = 'multipart/alternative; charset=UTF-8; boundary="----=' + crypto.randomBytes(32).toString('hex') + '"'
        if (!this.#header['X-Mailer']) this.#header['X-Mailer'] = 'ODAC'
        if (!this.#header['MIME-Version']) this.#header['MIME-Version'] = '1.0'
        let content = await fs.promises.readFile(__dir + '/view/mail/' + this.#template + '.html', 'utf-8')
        for (const iterator of Object.keys(data)) content = content.replace(new RegExp(`{${iterator}}`, 'g'), data[iterator])
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
              html: content,
              text: content
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<[^>]+>/g, '')
                .replace(/\s+/g, ' ')
                .trim(),
              attachments: []
            }
          ]
        }

        const socketPath = process.env.ODAC_API_SOCKET || '/var/run/odac.sock'
        
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
          console.error('[Mail] Socket Error:', error)
          resolve(false)
        })

        client.on('close', () => {
          if (Odac.Config.debug) console.log('[Mail] Connection closed')
        })
      } catch (error) {
        console.error('[Mail] Unexpected error:', error)
        resolve(false)
      }
    })
  }
}

module.exports = new Proxy(Mail, {
  apply(target, thisArg, args) {
    return new target(...args)
  }
})
