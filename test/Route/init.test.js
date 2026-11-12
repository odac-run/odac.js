const {execFile} = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Hot reload (debug mode) re-runs Route.init()'s loader every 5 s and relies on require.cache,
// which Jest's module registry ignores. Each scenario therefore runs in a plain Node process:
// init() is called once per step (it runs the same loader) and file mtimes are moved past the
// 1 s change threshold between steps.

const ROUTE = path.resolve(__dirname, '../../src/Route.js')

const HARNESS = `
const fs = require('fs')
const path = require('path')
const Route = require(${JSON.stringify(ROUTE)})
const dir = process.argv[2]
const steps = require(path.join(dir, 'steps.js'))
global.__dir = dir
const route = new Route()
global.Odac = {Route: route, Config: {debug: false}}
const errors = []
console.error = (...args) => errors.push(args.map(String).join(' '))
let offset = 0
function write(rel, content, mtimeOffset) {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, content)
  const time = new Date(Date.now() + (mtimeOffset ?? offset) * 1000)
  fs.utimesSync(file, time, time)
}
;(async () => {
  const results = []
  for (const step of steps) {
    for (const [rel, content, mtimeOffset] of step.files) write(rel, content, mtimeOffset)
    await route.init()
    results.push(step.check(route, global.Odac))
    offset += 5
  }
  route.stopCron()
  process.stdout.write(JSON.stringify({results, errors}))
})()
`

function run(steps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odac-route-'))
  fs.writeFileSync(path.join(dir, 'harness.js'), HARNESS)
  fs.writeFileSync(path.join(dir, 'steps.js'), `module.exports = ${steps}`)
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(dir, 'harness.js'), dir], {timeout: 20000}, (err, stdout, stderr) => {
      fs.rmSync(dir, {recursive: true, force: true})
      if (err) return reject(new Error(stderr || err.message))
      resolve(JSON.parse(stdout))
    })
  })
}

describe('Route.init() hot reload', () => {
  it('keeps reloading after a middleware fails to load', async () => {
    const {results} = await run(`[
      {files: [['middleware/mw.js', 'module.exports = ('], ['route/www.js', "module.exports = Odac => Odac.Route.get('/a', () => 'a')"]],
       check: r => ({loading: r.loading, route: !!r.routes.www.get['/a']})},
      {files: [['middleware/mw.js', 'module.exports = () => true']],
       check: r => ({loading: r.loading, handler: typeof r.middlewares.mw?.handler})}
    ]`)
    expect(results[0]).toEqual({loading: false, route: true})
    expect(results[1]).toEqual({loading: false, handler: 'function'})
  })

  it('drops removed routes of every method, not only page/post/get', async () => {
    const {results} = await run(`[
      {files: [['route/www.js', "module.exports = Odac => { Odac.Route.set('put', '/p', () => 1); Odac.Route.set('delete', '/d', () => 1); Odac.Route.get('/g', () => 1) }"]],
       check: r => [!!r.routes.www.put['/p'], !!r.routes.www.delete['/d'], !!r.routes.www.get['/g']]},
      {files: [['route/www.js', "module.exports = Odac => Odac.Route.get('/g', () => 1)"]],
       check: r => [!!r.routes.www.put['/p'], !!r.routes.www.delete['/d'], !!r.routes.www.get['/g']]}
    ]`)
    expect(results).toEqual([
      [true, true, true],
      [false, false, true]
    ])
  })

  it('drops removed WebSocket routes', async () => {
    const {results} = await run(`[
      {files: [['route/www.js', "module.exports = Odac => { Odac.Route.ws('/live', () => {}); Odac.Route.ws('/keep', () => {}) }"]],
       check: r => [!!r.wsServer.getRoute('/live', 'www'), !!r.wsServer.getRoute('/keep', 'www')]},
      {files: [['route/www.js', "module.exports = Odac => Odac.Route.ws('/keep', () => {})"]],
       check: r => [!!r.wsServer.getRoute('/live', 'www'), !!r.wsServer.getRoute('/keep', 'www')]}
    ]`)
    expect(results).toEqual([
      [true, true],
      [false, true]
    ])
  })

  it('updates middlewares, token and action of an unchanged controller route', async () => {
    const {results} = await run(`[
      {files: [['controller/Thing.js', 'module.exports = {one: () => 1, two: () => 2}', -60], ['route/www.js', "module.exports = Odac => Odac.Route.get('/c', 'Thing@one')"]],
       check: r => { const o = r.routes.www.get['/c']; return {action: o.action, middlewares: o.middlewares ?? null, token: o.token} }},
      {files: [['route/www.js', "module.exports = Odac => Odac.Route.use('auth').get('/c', 'Thing@two', {token: false})"]],
       check: r => { const o = r.routes.www.get['/c']; return {action: o.action, middlewares: o.middlewares ?? null, token: o.token} }}
    ]`)
    expect(results).toEqual([
      {action: 'one', middlewares: null, token: true},
      {action: 'two', middlewares: ['auth'], token: false}
    ])
  })

  it('reloads a controller edited without touching the route file', async () => {
    const {results} = await run(`[
      {files: [['controller/get/hello.js', "module.exports = () => 'v1'"], ['route/www.js', "module.exports = Odac => Odac.Route.get('/h', 'hello')", -60]],
       check: r => r.routes.www.get['/h'].cache()},
      {files: [['controller/get/hello.js', "module.exports = () => 'v2'"]],
       check: r => r.routes.www.get['/h'].cache()}
    ]`)
    expect(results).toEqual(['v1', 'v2'])
  })

  it('keeps the previous routes when a route file throws', async () => {
    const {results, errors} = await run(`[
      {files: [['route/www.js', "module.exports = Odac => { Odac.Route.get('/a', () => 1); Odac.Route.ws('/s', () => {}) }"]],
       check: () => null},
      {files: [['route/www.js', "module.exports = () => { throw new Error('half saved') }"]],
       check: (r, Odac) => [r.loading, !!r.routes.www.get['/a'], !!r.wsServer.getRoute('/s', 'www'), Odac.Route.buff === undefined]}
    ]`)
    expect(results[1]).toEqual([false, true, true, true])
    expect(errors.some(e => e.includes('half saved'))).toBe(true)
  })
})
