const mockKnex = jest.fn()
jest.mock(
  'knex',
  () =>
    (...args) =>
      mockKnex(...args)
)

const {buildConnections} = require('../../../src/Database/ConnectionFactory')

describe('ConnectionFactory.buildConnections()', () => {
  beforeEach(() => {
    mockKnex.mockReset()
    mockKnex.mockImplementation(options => ({options, raw: jest.fn()}))
  })

  it('should support single database config', () => {
    const connections = buildConnections({type: 'mysql', user: 'root', database: 'app'})
    expect(Object.keys(connections)).toEqual(['default'])
    expect(mockKnex).toHaveBeenCalledTimes(1)
  })

  it('should support multi database config', () => {
    const connections = buildConnections({
      analytics: {type: 'postgres', user: 'u', database: 'a'},
      default: {type: 'sqlite', filename: './dev.sqlite3'}
    })
    expect(Object.keys(connections).sort()).toEqual(['analytics', 'default'])
    expect(mockKnex).toHaveBeenCalledTimes(2)
  })
})
