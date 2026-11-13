const fs = require('fs')
const os = require('os')
const path = require('path')

// Templates are compiled by the shared View compiler; data keys become locals per key set,
// only when they are safe identifiers. Header values never carry line breaks.

jest.mock('net', () => {
  const {EventEmitter} = require('events')
  return {
    Socket: jest.fn(function () {
      const s = new EventEmitter()
      s.connect = jest.fn((socketPath, cb) => setImmediate(cb))
      s.write = jest.fn(payload => {
        global.__mailPayloads.push(JSON.parse(payload))
        setImmediate(() => s.emit('data', Buffer.from('{"success":true}')))
      })
      s.destroy = jest.fn()
      s.setTimeout = jest.fn()
      return s
    })
  }
})

const Mail = require('../../src/Mail')
const Var = require('../../src/Var')

describe('Mail templates and headers', () => {
  let tmpDir

  const template = (name, html) => {
    fs.mkdirSync(path.join(tmpDir, 'view', 'mail'), {recursive: true})
    fs.writeFileSync(path.join(tmpDir, 'view', 'mail', `${name}.html`), html)
  }
  const mail = name => Mail(name).from('sender@example.com', 'Sender').subject('Hi').to('rcpt@example.com')
  const body = () => global.__mailPayloads.at(-1)?.data[0].html

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-mail-'))
    global.__dir = tmpDir
    global.__mailPayloads = []
    global.Odac = {Config: {debug: false}, Var: (...args) => new Var(...args)}
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    fs.rmSync(tmpDir, {recursive: true, force: true})
    delete global.__dir
    delete global.Odac
    delete global.__mailPayloads
  })

  it('renders the same template with different key sets', async () => {
    template('welcome', '<p>{{ name }}</p>')
    await expect(mail('welcome').send({name: 'Ada'})).resolves.toEqual({success: true})
    expect(body()).toContain('<p>Ada</p>')

    template('greeting', '<p>{{ typeof name === "undefined" ? "guest" : name }} {{ code }}</p>')
    await mail('greeting').send({code: 7})
    expect(body()).toContain('<p>guest 7</p>')
    await mail('greeting').send({name: 'Bo', code: 8})
    expect(body()).toContain('<p>Bo 8</p>')
  })

  it('keeps reserved and non-identifier keys reachable through get() only', async () => {
    template('keys', "<p>{{ get('html') }}|{{ get('first-name') }}|{{ get('class') }}</p>")
    await mail('keys').send({html: 'h', 'first-name': 'Ada', class: 'c'})
    expect(body()).toContain('<p>h|Ada|c</p>')
  })

  it('does not execute data keys as code', async () => {
    template('inject', '<p>ok</p>')
    const key = "x'];global.__pwned=true;//"
    await mail('inject').send({[key]: 1})
    expect(global.__pwned).toBeUndefined()
    expect(body()).toContain('<p>ok</p>')
  })

  it('fails the send instead of mailing an empty body when the template throws', async () => {
    template('broken', '<p>{{ missing.value }}</p>')
    await expect(mail('broken').send({})).resolves.toBe(false)
    expect(global.__mailPayloads).toHaveLength(0)
  })

  it('supports the View template features, such as in= loops', async () => {
    template('loop', '<odac:for in="items" value="item">[{{ item }}]</odac:for>')
    await mail('loop').send({items: ['a', 'b']})
    expect(body()).toContain('[a][b]')
  })

  it('keeps $ sequences in templates intact', async () => {
    template('price', "<p>Total: $& $' $$</p>")
    await mail('price').send({})
    expect(body()).toContain("<p>Total: $& $' $$</p>")
  })

  describe('components', () => {
    const component = (name, html) => {
      const file = path.join(tmpDir, 'view', 'mail', 'components', `${name}.html`)
      fs.mkdirSync(path.dirname(file), {recursive: true})
      fs.writeFileSync(file, html)
    }

    it('renders components from view/mail/components with props and slots', async () => {
      component('button', `<odac:props :href label="'Open'" />\n<a href="{{ href }}" style="color:#fff">{{ label }}</a>`)
      component('layout', '<table><tr><td><odac:slot /></td></tr></table>')
      template('invite', `<c:layout><p>Hi {{ name }}</p><c:button :href="url" label="Join" /></c:layout>`)
      await mail('invite').send({name: 'Ada', url: 'https://example.com/?a=1&b=2'})
      expect(body()).toContain(
        '<table><tr><td><p>Hi Ada</p><a href="https://example.com/?a=1&amp;b=2" style="color:#fff">Join</a></td></tr></table>'
      )
    })

    it('prints pushed styles at the stack marker, once, without a browser marker', async () => {
      component('badge', '<odac:push to="styles"><style>.b{color:red}</style></odac:push><span class="b">{{ props.text }}</span>')
      template('styled', '<html><head><odac:stack name="styles" /></head><body><c:badge text="1" /><c:badge text="2" /></body></html>')
      await mail('styled').send({})
      expect(body()).toContain('<head><style>.b{color:red}</style></head><body><span class="b">1</span><span class="b">2</span></body>')
    })

    it('does not use the page components', async () => {
      fs.mkdirSync(path.join(tmpDir, 'view', 'components'), {recursive: true})
      fs.writeFileSync(path.join(tmpDir, 'view', 'components', 'page.html'), 'page')
      template('uses-page', '<c:page />')
      await expect(mail('uses-page').send({})).resolves.toBe(false)
      expect(global.__mailPayloads).toHaveLength(0)
      expect(console.error.mock.calls.flat().join('\n')).toContain('Component "page" not found')
    })

    it('fails the send for a lazy component: no browser loads it', async () => {
      component('late', 'x')
      template('lazy', '<c:late lazy />')
      await expect(mail('lazy').send({})).resolves.toBe(false)
      expect(console.error.mock.calls.flat().join('\n')).toContain('Component "late" cannot be lazy here: no browser loads it')
    })

    it('fails the send on malformed component markup, logging the line', async () => {
      template('malformed', '<p>x</p>\n<c:a></c:b>')
      await expect(mail('malformed').send({})).resolves.toBe(false)
      expect(console.error.mock.calls.flat().join('\n')).toContain('</c:b> does not match <c:a> opened in line 2\n  in line 2')
    })
  })

  it('strips line breaks from the subject, display names and custom headers', async () => {
    template('plain', '<p>x</p>')
    await Mail('plain')
      .from('sender@example.com', 'Sender\r\nBcc: victim@example.com')
      .subject('Hello\r\nBcc: victim@example.com')
      .to('rcpt@example.com', 'Rcpt\nX: y')
      .header({'X-Ref': 'a\r\nBcc: v@example.com', 'Bad\r\nName': 'x'})
      .send({})
    const sent = global.__mailPayloads.at(-1).data[0]
    for (const value of [sent.subject, ...Object.values(sent.header), sent.from.value[0].name, sent.to.value[0].name]) {
      expect(String(value)).not.toMatch(/[\r\n]/)
    }
    expect(Object.keys(sent.header)).not.toContain('Bad\r\nName')
  })
})
