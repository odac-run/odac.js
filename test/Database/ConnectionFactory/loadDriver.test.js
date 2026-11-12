// A driver that is absent and a driver that is present but throws on load need different fixes.
// npm 12+ blocks install scripts unless `allowScripts` covers them, which leaves sqlite3 installed
// without its native binding; calling that "not installed" sent users to `npm install`.

const notFound = name => Object.assign(new Error(`Cannot find module '${name}'\nRequire stack:\n- x.js`), {code: 'MODULE_NOT_FOUND'})

const build = (pkg, factory, config) => {
  let buildConnections
  jest.isolateModules(() => {
    jest.doMock('knex', () => () => ({raw: jest.fn()}))
    jest.doMock(pkg, factory, {virtual: true})
    ;({buildConnections} = require('../../../src/Database/ConnectionFactory'))
  })
  return () => buildConnections(config)
}

const sqlite = {type: 'sqlite', filename: ':memory:'}

describe('ConnectionFactory driver loading', () => {
  afterEach(() => jest.resetModules())

  it('reports a missing driver as not installed', () => {
    const run = build(
      'sqlite3',
      () => {
        throw notFound('sqlite3')
      },
      sqlite
    )
    expect(run).toThrow('Database driver "sqlite3" is not installed. Run: npm install sqlite3')
  })

  it('reports a native binding failure as a load failure with the rebuild and approve commands', () => {
    const cause = new Error('Could not locate the bindings file. Tried:\n → node_modules/sqlite3/build/node_sqlite3.node')
    const run = build(
      'sqlite3',
      () => {
        throw cause
      },
      sqlite
    )

    let err
    try {
      run()
    } catch (e) {
      err = e
    }
    expect(err.message).toContain('Database driver "sqlite3" is installed but failed to load.')
    expect(err.message).toContain('npm rebuild sqlite3')
    expect(err.message).toContain('npm install-scripts approve sqlite3')
    expect(err.message).toContain('Cause: Could not locate the bindings file.')
    expect(err.message).not.toContain('is not installed')
    expect(err.cause).toBe(cause)
  })

  it('does not treat a missing module inside the driver as the driver being absent', () => {
    const run = build(
      'sqlite3',
      () => {
        throw notFound('bindings')
      },
      sqlite
    )
    expect(run).toThrow('Database driver "sqlite3" is installed but failed to load.')
  })

  it('leaves the native addon hint out for pure JavaScript drivers', () => {
    const run = build(
      'pg',
      () => {
        throw new TypeError('boom')
      },
      {type: 'postgres', database: 'app'}
    )

    let err
    try {
      run()
    } catch (e) {
      err = e
    }
    expect(err.message).toBe('Database driver "pg" is installed but failed to load.\nCause: boom')
  })

  it('builds the connection when the driver loads', () => {
    const run = build('sqlite3', () => ({}), sqlite)
    expect(Object.keys(run())).toEqual(['default'])
  })
})
