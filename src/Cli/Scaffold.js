const fsPromises = require('node:fs').promises
const path = require('node:path')

// Template files stored without their leading dot, restored on copy.
// Why: npm never publishes `.gitignore` files, so a template shipped through the registry
// arrived without one and new projects committed `.env` and `storage/` (sessions, cache).
const DOTFILES = ['gitignore']

/**
 * Copies the project template into a target directory.
 * Why: `odac init` must produce the same project whether the framework was installed from
 * npm or a git checkout. Dotfiles kept under a plain name are renamed back; a dotfile the
 * target already has is left untouched so re-running init never overwrites the user's own.
 * @param {string} templateDir
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
async function copyTemplate(templateDir, targetDir) {
  await fsPromises.cp(templateDir, targetDir, {recursive: true})

  await Promise.all(
    DOTFILES.map(async name => {
      const source = path.join(targetDir, name)
      const target = path.join(targetDir, `.${name}`)
      if (!(await exists(source))) return
      if (await exists(target)) return fsPromises.rm(source)
      return fsPromises.rename(source, target)
    })
  )
}

async function exists(file) {
  try {
    await fsPromises.access(file)
    return true
  } catch {
    return false
  }
}

module.exports = {copyTemplate}
