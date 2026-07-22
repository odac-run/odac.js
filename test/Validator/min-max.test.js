const Validator = require('../../src/Validator')

// min/max must compare numerically, not lexicographically. The classic bug:
// '9' < '10' is false as strings, so `min:10` wrongly passes the value 9.
// See IMPROVEMENT-PLAN 1.11.

const odacStub = {
  Var: () => ({is: () => false})
}

function makeValidator() {
  return new Validator({}, odacStub)
}

describe('Validator min/max rules', () => {
  describe('min', () => {
    it('rejects a number below the threshold when digit counts differ (9 < min:10)', async () => {
      const v = makeValidator()
      v.var('age', '9').check('min:10').message('too small')
      expect(await v.error()).toBe(true)
    })

    it('accepts a number at or above the threshold (10 >= min:10)', async () => {
      const v = makeValidator()
      v.var('age', '10').check('min:10').message('too small')
      expect(await v.error()).toBe(false)
    })

    it('accepts a larger number (100 >= min:10)', async () => {
      const v = makeValidator()
      v.var('age', '100').check('min:10').message('too small')
      expect(await v.error()).toBe(false)
    })
  })

  describe('max', () => {
    it('rejects a number above the threshold when digit counts differ (100 > max:20)', async () => {
      const v = makeValidator()
      v.var('age', '100').check('max:20').message('too big')
      expect(await v.error()).toBe(true)
    })

    it('accepts a number at or below the threshold (20 <= max:20)', async () => {
      const v = makeValidator()
      v.var('age', '20').check('max:20').message('too big')
      expect(await v.error()).toBe(false)
    })

    it('accepts a smaller number (5 <= max:20)', async () => {
      const v = makeValidator()
      v.var('age', '5').check('max:20').message('too big')
      expect(await v.error()).toBe(false)
    })
  })
})
