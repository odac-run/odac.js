const Lang = require('../../src/Lang')

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(async file => (String(file).endsWith('/tr.json') ? JSON.stringify({Hello: 'Merhaba', 'Hi %s': 'Selam %s'}) : '{}')),
    stat: jest.fn(async () => ({mtimeMs: 1}))
  }
}))

const config = {lang: {default: 'en', supported: ['en', 'tr']}}

describe('Lang.for()', () => {
  beforeEach(async () => {
    global.__dir = '/mock'
    Lang.store.reset()
    await Lang.store.init(config)
  })

  it('serves the given language without a request', () => {
    const lang = Lang.for('tr', config)
    expect(lang.current()).toBe('tr')
    expect(lang.get('Hello')).toBe('Merhaba')
  })

  it('serves lang.default for a missing or unsupported code', () => {
    expect(Lang.for(undefined, config).current()).toBe('en')
    expect(Lang.for('de', config).current()).toBe('en')
    expect(Lang.for('../etc', config).current()).toBe('en')
  })

  it('reads Odac.Config when no config is passed', () => {
    global.Odac = {Config: config}
    try {
      expect(Lang.for('tr').get('Hello')).toBe('Merhaba')
    } finally {
      delete global.Odac
    }
  })

  it('returns independent instances', () => {
    const a = Lang.for('tr', config)
    const b = Lang.for('en', config)
    expect(a.current()).toBe('tr')
    expect(b.current()).toBe('en')
  })
})

describe('Lang.translator()', () => {
  beforeEach(async () => {
    global.__dir = '/mock'
    Lang.store.reset()
    await Lang.store.init(config)
  })

  it('translates through the Lang of the object, read on every call', () => {
    const odac = {Lang: Lang.for('en', config)}
    const __ = Lang.translator(odac)
    expect(__('Hello')).toBe('Hello')
    odac.Lang.set('tr')
    expect(__('Hi %s', 'Ada')).toBe('Selam Ada')
  })

  it('formats the key when there is no Lang', () => {
    expect(Lang.translator({})('Hi %s', 'Ada')).toBe('Hi Ada')
    expect(Lang.translator(undefined)('Hello')).toBe('Hello')
  })
})
