const knexFactory = require('knex')
const Auth = require('../../src/Auth.js')
const Var = require('../../src/Var.js')

// register() must return the id of the row it just wrote. With database-generated keys the id
// is not part of the submitted data, so it has to come from the insert result.

describe('Auth.register()', () => {
  let knex
  let auth

  const useDatabase = buildTable => {
    global.Odac.DB = new Proxy(
      {nanoid: () => 'nano_' + Math.random().toString(36).slice(2, 12)},
      {
        get: (target, prop) => {
          if (prop in target) return target[prop]
          const qb = buildTable(prop)
          qb.schema = async () => {}
          return qb
        }
      }
    )
  }

  beforeEach(() => {
    knex = knexFactory({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true})
    global.Odac = {Config: {auth: {}}, Var: value => new Var(value)}
    auth = new Auth({cookie: jest.fn(), header: jest.fn(), ip: '127.0.0.1'})
  })

  afterEach(async () => {
    await knex.destroy()
    delete global.Odac
  })

  describe('with an auto-increment primary key', () => {
    beforeEach(async () => {
      await knex.schema.createTable('users', t => {
        t.increments('id')
        t.string('email').unique()
        t.string('password')
      })
      useDatabase(table => knex(table))
    })

    it('returns the generated id and the stored row', async () => {
      const result = await auth.register({email: 'a@example.com', password: 's3cret'}, {autoLogin: false})

      expect(result).toMatchObject({success: true, user: {id: 1, email: 'a@example.com'}})
      expect(result.user.password).toBeUndefined()
      expect(await knex('users').count({n: '*'})).toEqual([{n: 1}])
    })

    it('does not return driver error messages to the caller', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {})
      // SQLite: "table users has no column named missing_column" must stay in the log.
      const result = await auth.register({email: 'b@example.com', password: 'x', missing_column: 1}, {autoLogin: false})

      expect(result).toEqual({success: false, error: 'Registration failed'})
      console.error.mockRestore()
    })

    it('stores the password as a scrypt hash', async () => {
      await auth.register({email: 'a@example.com', password: 's3cret'}, {autoLogin: false})

      const row = await knex('users').first()
      expect(new Var(row.password).hashCheck('s3cret')).toBe(true)
    })

    it('reports a duplicate email instead of a failed insert on retry', async () => {
      await auth.register({email: 'a@example.com', password: 's3cret'}, {autoLogin: false})
      const second = await auth.register({email: 'a@example.com', password: 's3cret'}, {autoLogin: false})

      expect(second).toMatchObject({success: false, field: 'email'})
    })
  })

  it('generates a NanoID when the primary key is a string column', async () => {
    await knex.schema.createTable('users', t => {
      t.string('id', 21).primary()
      t.string('email').unique()
      t.string('password')
    })
    useDatabase(table => knex(table))

    const result = await auth.register({email: 'a@example.com', password: 's3cret'}, {autoLogin: false})

    expect(result.success).toBe(true)
    expect(result.user.id).toMatch(/^nano_/)
  })

  describe('with drivers that do not support RETURNING', () => {
    const stubTable = ({client, insertResult, row}) => {
      const calls = {returning: 0, where: []}
      const builder = {
        client: {config: {client}},
        columnInfo: async () => ({type: 'int'}),
        first: async () => row,
        insert: () => builder,
        returning: () => {
          calls.returning++
          return builder
        },
        then: (resolve, reject) => Promise.resolve(insertResult).then(resolve, reject),
        where: (...args) => {
          calls.where.push(args)
          return {first: async () => (args[0] === 'email' && !row?.id ? null : row)}
        }
      }
      return {builder, calls}
    }

    it('uses the insert id MySQL resolves to without calling returning()', async () => {
      const {builder, calls} = stubTable({client: 'mysql2', insertResult: [42], row: {id: 42, email: 'a@example.com'}})
      useDatabase(() => builder)

      const result = await auth.register({email: 'a@example.com', password: 's3cret'}, {autoLogin: false, uniqueFields: []})

      expect(result).toMatchObject({success: true, user: {id: 42}})
      expect(calls.returning).toBe(0)
    })

    it('falls back to the unique field when the insert reports no id', async () => {
      const row = {id: 9, email: 'a@example.com'}
      const {builder, calls} = stubTable({client: 'mysql2', insertResult: [0], row})
      let inserted = false
      builder.insert = () => {
        inserted = true
        return builder
      }
      builder.where = (...args) => {
        calls.where.push(args)
        return {first: async () => (inserted ? row : null)}
      }
      useDatabase(() => builder)

      const result = await auth.register({email: 'a@example.com', password: 's3cret'}, {autoLogin: false})

      expect(result).toMatchObject({success: true, user: {id: 9}})
      expect(calls.where).toContainEqual(['email', 'a@example.com'])
      expect(calls.where).toContainEqual(['id', 9])
    })
  })
})
