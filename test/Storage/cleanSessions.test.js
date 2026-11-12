const Storage = require('../../src/Storage')

// The session GC removes a whole session only once its :_created stamp passes
// the 7-day window. Form records (View/Form.js) are session sub-keys named
// `_<type>_form_<token>` that carry their own short `expires` (30 min). Without
// per-record eviction, every unused form render lingers for up to 7 days. GC
// must drop an expired form record immediately, while leaving live form
// records, the parent session, and unrelated session values untouched.
// See IMPROVEMENT-PLAN 4.7.

function fakeDb(entries) {
  const removed = []
  return {
    removed,
    get(key) {
      return entries.find(entry => entry.key === key)?.value
    },
    ranges: 0,
    getRange({start, limit = Infinity}) {
      this.ranges++
      // Sorted like LMDB, from `start`, at most `limit`; a copy so removal during iteration is safe.
      return entries
        .filter(entry => entry.key >= start)
        .sort((a, b) => (a.key < b.key ? -1 : 1))
        .slice(0, limit)
    },
    getKeys() {
      return []
    },
    remove(key) {
      removed.push(key)
    }
  }
}

describe('OdacStorage.cleanSessions()', () => {
  const NOW = 1_800_000_000_000
  let realNow

  beforeEach(() => {
    realNow = Date.now
    Date.now = () => NOW
    Storage.ready = true
  })

  afterEach(() => {
    Date.now = realNow
    Storage.db = null
    Storage.ready = false
  })

  describe('sliding expiry', () => {
    const DAY = 24 * 60 * 60 * 1000

    it('keeps a session created long ago that was active within the lifetime', async () => {
      const db = fakeDb([
        {key: 'sess:pub:pri:_active', value: NOW - DAY},
        {key: 'sess:pub:pri:_created', value: NOW - 30 * DAY}
      ])
      Storage.db = db
      await Storage.cleanSessions(7 * DAY)
      expect(db.removed).toEqual([])
    })

    it('removes a session whose last activity is older than the lifetime', async () => {
      const db = fakeDb([
        {key: 'sess:pub:pri:_active', value: NOW - 8 * DAY},
        {key: 'sess:pub:pri:_created', value: NOW - 30 * DAY}
      ])
      db.getKeys = () => ['sess:pub:pri:_active', 'sess:pub:pri:_created']
      Storage.db = db
      await Storage.cleanSessions(7 * DAY)
      expect(db.removed).toEqual(['sess:pub:pri:_active', 'sess:pub:pri:_created'])
    })

    it('evicts expired CSRF tokens and keeps live ones', async () => {
      const db = fakeDb([
        {key: 'sess:pub:pri:_created', value: NOW},
        {key: 'sess:pub:pri:_token:old', value: NOW - 1},
        {key: 'sess:pub:pri:_token:new', value: NOW + DAY}
      ])
      Storage.db = db
      await Storage.cleanSessions(7 * DAY)
      expect(db.removed).toEqual(['sess:pub:pri:_token:old'])
    })
  })

  it('evicts an expired form record without waiting for the parent session', async () => {
    const db = fakeDb([
      {key: 'sess:pub:pri:_created', value: NOW}, // fresh session, keep
      {key: 'sess:pub:pri:_login_form_abc', value: {expires: NOW - 1000}} // lapsed
    ])
    Storage.db = db

    await Storage.cleanSessions(7 * 24 * 60 * 60 * 1000)

    expect(db.removed).toContain('sess:pub:pri:_login_form_abc')
    expect(db.removed).not.toContain('sess:pub:pri:_created')
  })

  it('keeps a form record whose expires has not passed', async () => {
    const db = fakeDb([{key: 'sess:pub:pri:_custom_form_xyz', value: {expires: NOW + 60_000}}])
    Storage.db = db

    await Storage.cleanSessions(7 * 24 * 60 * 60 * 1000)

    expect(db.removed).toHaveLength(0)
  })

  it('does not evict a non-form session value even if it carries an expires field', async () => {
    const db = fakeDb([{key: 'sess:pub:pri:cart', value: {expires: NOW - 1000, items: 3}}])
    Storage.db = db

    await Storage.cleanSessions(7 * 24 * 60 * 60 * 1000)

    expect(db.removed).toHaveLength(0)
  })

  describe('batching', () => {
    function sessions(n, created) {
      const entries = []
      for (let i = 0; i < n; i++) entries.push({key: `sess:${String(i).padStart(4, '0')}:ua:_created`, value: created})
      return entries
    }

    it('scans every batch and yields to the event loop between them', async () => {
      const db = fakeDb(sessions(25, NOW - 30 * 24 * 60 * 60 * 1000))
      Storage.db = db
      // Other work queued before the run gets the loop after the first batch.
      let rangesWhenOtherWorkRan = null
      setImmediate(() => (rangesWhenOtherWorkRan = db.ranges))

      const removed = await Storage.cleanSessions(7 * 24 * 60 * 60 * 1000, 10)

      expect(removed).toBe(25)
      expect(db.ranges).toBe(3)
      expect(rangesWhenOtherWorkRan).toBe(1)
    })

    it('skips a run while another is in progress', async () => {
      Storage.db = fakeDb(sessions(25, NOW - 30 * 24 * 60 * 60 * 1000))
      const first = Storage.cleanSessions(7 * 24 * 60 * 60 * 1000, 10)
      await expect(Storage.cleanSessions(7 * 24 * 60 * 60 * 1000, 10)).resolves.toBe(0)
      await expect(first).resolves.toBe(25)
    })
  })
})
