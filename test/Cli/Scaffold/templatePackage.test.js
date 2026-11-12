const path = require('path')

// npm 12+ skips dependency install scripts unless the project's package.json allows them.
// sqlite3 fetches its native binary in one, so a project created by `odac init` must allow it
// up front: the user installs sqlite3 later and would otherwise get a driver that cannot load.

const pkg = require(path.resolve(__dirname, '../../../template/package.json'))

describe('template/package.json', () => {
  it('allows the sqlite3 install script for any version the project installs later', () => {
    expect(pkg.allowScripts).toEqual({sqlite3: true})
  })
})
