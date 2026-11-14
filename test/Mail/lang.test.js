const fs = require('fs')
const os = require('os')
const path = require('path')

// A mail is translated in its recipient's language (Mail#lang), not in the language of the
// request that sends it; without lang() it keeps using the global Odac.Lang.

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
const Lang = require('../../src/Lang')
const Var = require('../../src/Var')

describe('Mail#lang()', () => {
  let tmpDir
  const config = {debug: false, lang: {default: 'en'}}

  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(tmpDir, file)), {recursive: true})
    fs.writeFileSync(path.join(tmpDir, file), typeof content === 'string' ? content : JSON.stringify(content))
  }
  const mail = name => Mail(name).from('sender@example.com', 'Sender').subject('Hi').to('rcpt@example.com')
  const payload = () => global.__mailPayloads.at(-1)?.data[0]

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-mail-lang-'))
    global.__dir = tmpDir
    global.__mailPayloads = []
    write('lang/en.json', {Hello: 'Hello', Bye: 'Bye'})
    write('lang/tr.json', {Hello: 'Merhaba', Bye: 'Hoşça kal'})
    write('view/mail/greet.html', "<p>{{ __('Hello') }}|<odac translate>Bye</odac>|{{ Odac.__('Hello') }}|{{ Odac.Lang.current() }}</p>")
    Lang.store.reset()
    await Lang.store.init(config)
    const shared = new Lang({Config: config})
    global.Odac = {Config: config, Var: (...args) => new Var(...args), Lang: shared, __: (...args) => shared.get(...args)}
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    Lang.store.reset()
    fs.rmSync(tmpDir, {recursive: true, force: true})
    delete global.__dir
    delete global.Odac
    delete global.__mailPayloads
  })

  it('translates the template, Odac.__() and Odac.Lang in the given language', async () => {
    await expect(mail('greet').lang('tr').send()).resolves.toEqual({success: true})
    expect(payload().html).toContain('<p>Merhaba|Hoşça kal|Merhaba|tr</p>')
  })

  it('declares the language in Content-Language', async () => {
    await mail('greet').lang('tr').send()
    expect(payload().header['Content-Language']).toBe('tr')
  })

  it('sends an unsupported or missing language in lang.default', async () => {
    await mail('greet').lang('de').send()
    expect(payload().html).toContain('<p>Hello|Bye|Hello|en</p>')
    await mail('greet').lang(undefined).send()
    expect(payload().header['Content-Language']).toBe('en')
  })

  it('translates a subject function in the mail language, whatever the call order', async () => {
    await Mail('greet')
      .subject(__ => __('Hello'))
      .lang('tr')
      .from('sender@example.com')
      .to('rcpt@example.com')
      .send()
    expect(payload().subject).toBe('Merhaba')
  })

  it('strips line breaks from a translated subject', async () => {
    await mail('greet')
      .subject(() => 'A\r\nBcc: x@example.com')
      .send()
    expect(payload().subject).toBe('A Bcc: x@example.com')
  })

  it('does not change the shared Odac.Lang', async () => {
    await mail('greet').lang('tr').send()
    expect(global.Odac.Lang.current()).toBe('en')
  })

  it('keeps translating through the global Odac.Lang without lang()', async () => {
    global.Odac.Lang.set('tr')
    await mail('greet').send()
    expect(payload().html).toContain('<p>Merhaba|Hoşça kal|')
    expect(payload().header['Content-Language']).toBeUndefined()
  })
})
