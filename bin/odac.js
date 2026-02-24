#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const {execSync, spawn} = require('node:child_process')
const cluster = require('node:cluster')

const command = process.argv[2]
const args = process.argv.slice(3)

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

const ask = question => new Promise(resolve => rl.question(question, answer => resolve(answer.trim())))

/**
 * Interactive selection menu for CLI.
 * @param {string} title Menu title
 * @param {string[]} options List of choice strings
 * @returns {Promise<number>} Selected index
 */
const select = async (title, options) => {
  if (!process.stdout.isTTY) return 0

  return new Promise(resolve => {
    let current = 0
    const hideCursor = '\u001B[?25l'
    const showCursor = '\u001B[?25h'

    // Calculate total lines the title occupies
    const titleLines = title.split('\n')
    const totalLines = titleLines.length + options.length

    const render = () => {
      // Clear all lines we previously wrote
      titleLines.forEach(line => {
        process.stdout.write('\r\x1b[K' + line + '\n')
      })
      options.forEach((opt, i) => {
        const line = i === current ? `\x1b[36m  ❯ ${opt}\x1b[0m` : `    ${opt}`
        process.stdout.write('\r\x1b[K' + line + '\n')
      })
      process.stdout.write(`\x1b[${totalLines}A`) // Move back to the very start
    }

    process.stdout.write(hideCursor)
    if (!process.stdin.isRaw) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
    }
    readline.emitKeypressEvents(process.stdin)

    render()

    const onKey = (str, key) => {
      if (key.name === 'up') {
        current = current > 0 ? current - 1 : options.length - 1
        render()
      } else if (key.name === 'down') {
        current = current < options.length - 1 ? current + 1 : 0
        render()
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup()
        process.stdout.write(`\x1b[${totalLines}B\n`) // Move down past everything
        resolve(current)
      } else if (key.ctrl && key.name === 'c') {
        cleanup()
        process.exit()
      }
    }

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey)
      if (process.stdin.isRaw) process.stdin.setRawMode(false)
      process.stdout.write(showCursor)
    }

    process.stdin.on('keypress', onKey)
  })
}

/**
 * Resolves Tailwind CSS paths and ensures required directories/files exist.
 * Supports multiple CSS entry points from 'view/css'.
 * @returns {Array<{ input: string, cssOutput: string, isCustom: boolean, name: string }>}
 */
function getTailwindConfigs() {
  const cssDir = path.join(process.cwd(), 'view/css')
  const cacheDir = path.join(process.cwd(), 'storage/.cache')
  const defaultCssInput = path.join(cacheDir, 'tailwind.css')
  const defaultCssOutput = path.join(process.cwd(), 'public/assets/css/app.css')

  const configs = []

  // Scan for custom CSS files
  if (fs.existsSync(cssDir) && fs.lstatSync(cssDir).isDirectory()) {
    const files = fs.readdirSync(cssDir).filter(file => file.endsWith('.css'))

    files.forEach(file => {
      const input = path.join(cssDir, file)
      const cssOutput = path.join(process.cwd(), 'public/assets/css', file)

      // Ensure output directory exists
      const cssOutputDir = path.dirname(cssOutput)
      fs.mkdirSync(cssOutputDir, {recursive: true})

      configs.push({
        input,
        cssOutput,
        isCustom: true,
        name: file
      })
    })
  }

  // Fallback to default if no custom files found
  if (configs.length === 0) {
    fs.mkdirSync(cacheDir, {recursive: true})
    try {
      fs.writeFileSync(defaultCssInput, '@import "tailwindcss";', {flag: 'wx'})
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }

    const cssOutputDir = path.dirname(defaultCssOutput)
    fs.mkdirSync(cssOutputDir, {recursive: true})

    configs.push({
      input: defaultCssInput,
      cssOutput: defaultCssOutput,
      isCustom: false,
      name: 'Default'
    })
  }

  return configs
}

/**
 * Manages the AI Agent skills synchronization.
 * @param {string} targetDir The directory to sync skills into.
 */
async function manageSkills(targetDir = process.cwd()) {
  const aiSourceDir = path.resolve(__dirname, '../docs/ai')

  if (!fs.existsSync(aiSourceDir)) {
    console.error('❌ AI components not found in framework.')
    return
  }

  const options = [
    'Antigravity / Cascade (.agent/skills)',
    'Claude / Projects (.claude/skills)',
    'Continue (.continue/skills)',
    'Cursor (.cursor/skills)',
    'Kilo Code (.kilocode/skills)',
    'Kiro CLI (.kiro/skills)',
    'Qwen Code (.qwen/skills)',
    'Windsurf (.windsurf/skills)',
    'Custom Path',
    'Skip / Cancel'
  ]

  const choiceIndex = await select('\n🤖 \x1b[36mODAC AI Agent Skills Manager\x1b[0m\nSelect your AI Agent / IDE for setup:', options)

  let targetSubDir = ''
  let copySkillsOnly = true

  const SKIP_INDEX = 9
  const CUSTOM_INDEX = 8

  if (choiceIndex === SKIP_INDEX) return // Skip / Cancel

  switch (choiceIndex) {
    case 0:
      targetSubDir = '.agent/skills'
      break
    case 1:
      targetSubDir = '.claude/skills'
      break
    case 2:
      targetSubDir = '.continue/skills'
      break
    case 3:
      targetSubDir = '.cursor/skills'
      break
    case 4:
      targetSubDir = '.kilocode/skills'
      break
    case 5:
      targetSubDir = '.kiro/skills'
      break
    case 6:
      targetSubDir = '.qwen/skills'
      break
    case 7:
      targetSubDir = '.windsurf/skills'
      break
    case CUSTOM_INDEX:
      targetSubDir = await ask('Enter custom path: ')
      copySkillsOnly = false
      break
    default:
      return
  }

  const targetBase = path.resolve(targetDir, targetSubDir)
  const targetPath = path.join(targetBase, 'odac.js')

  try {
    fs.mkdirSync(targetPath, {recursive: true})

    if (copySkillsOnly) {
      const skillsSource = path.join(aiSourceDir, 'skills')
      fs.cpSync(skillsSource, targetPath, {recursive: true})
    } else {
      fs.cpSync(aiSourceDir, targetPath, {recursive: true})
    }

    console.log(`\n✨ AI skills successfully synced to: \x1b[32m${path.join(targetSubDir, 'odac.js')}\x1b[0m`)
    console.log('Your AI Agent now has full knowledge of the ODAC Framework. 🚀')
  } catch (err) {
    console.error('❌ Failed to sync AI skills:', err.message)
  }
}

async function run() {
  if (command === 'init') {
    const projectName = args[0] || '.'
    const targetDir = path.resolve(process.cwd(), projectName)

    fs.mkdirSync(targetDir, {recursive: true})

    console.log(`🚀 Initializing new Odac project in: ${targetDir}`)
    const templateDir = path.resolve(__dirname, '../template')

    try {
      fs.cpSync(templateDir, targetDir, {recursive: true})

      const pkgPath = path.join(targetDir, 'package.json')
      const frameworkPkg = require('../package.json')

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      pkg.name = projectName === '.' ? path.basename(targetDir) : projectName
      pkg.version = '0.0.1'

      if (!pkg.dependencies) pkg.dependencies = {}
      pkg.dependencies[frameworkPkg.name] = `^${frameworkPkg.version}`

      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))

      console.log('\n📦 Installing dependencies...')
      try {
        execSync('npm install', {
          stdio: 'inherit',
          cwd: targetDir
        })
      } catch (err) {
        console.warn('⚠️  npm install failed. You might need to run it manually.')
        process.exit(1)
      }

      console.log('\n✨ Project initialized successfully!')

      // Interactive AI Skills setup
      if (process.stdout.isTTY) {
        const setupAIIndex = await select('\n🤖 Should we setup AI Agent skills for your IDE?', ['Yes', 'No'])
        if (setupAIIndex === 0) {
          await manageSkills(targetDir)
        } else {
          console.log('\n💡 \x1b[33mTip:\x1b[0m You can always run \x1b[36mnpx odac skills\x1b[0m later.')
        }
      }
    } catch (error) {
      console.error('❌ Error initializing project:', error.message)
    }
  } else if (command === 'dev') {
    // ... existing dev logic ...
    if (cluster.isPrimary) {
      const configs = getTailwindConfigs()
      const tails = []
      const names = configs.map(c => c.name).join(', ')

      console.log(`🎨 \x1b[36mODAC Styles:\x1b[0m Watching for changes (${names})`)

      configs.forEach(({input, cssOutput, name, isCustom}) => {
        let tailwindProcess = null

        const startWatcher = () => {
          const localCli = path.join(process.cwd(), 'node_modules', '.bin', 'tailwindcss')
          const useLocal = fs.existsSync(localCli)
          const cmd = useLocal ? localCli : 'npx'
          const args = useLocal
            ? ['-i', input, '-o', cssOutput, '--watch=always']
            : ['@tailwindcss/cli', '-i', input, '-o', cssOutput, '--watch=always']

          tailwindProcess = spawn(cmd, args, {
            stdio: ['pipe', 'ignore', 'pipe'],
            shell: !useLocal,
            cwd: process.cwd()
          })

          tailwindProcess.stderr.on('data', chunk => {
            const raw = chunk.toString()
            const lines = raw.split('\n')
            for (const line of lines) {
              const clean = line.replace(/\x1B\[[0-9;]*[JKmsu]/g, '').trim()
              if (!clean || clean.startsWith('Done in') || clean.startsWith('≈')) continue
              process.stderr.write(`\x1b[31m[ODAC Style Error]\x1b[0m ${line}\n`)
            }
          })

          tailwindProcess.on('error', err => {
            console.error(`❌ \x1b[31m[ODAC Style Error]\x1b[0m Failed to start watcher for ${name}:`, err.message)
          })

          tailwindProcess.on('exit', code => {
            if (code !== 0 && code !== null) {
              console.warn(`⚠️  Tailwind watcher for ${name} exited unexpectedly (code ${code}). Restarting in 1s...`)
              setTimeout(startWatcher, 1000)
            }
          })
        }

        startWatcher()

        tails.push({
          kill: () => {
            if (tailwindProcess) tailwindProcess.kill()
          }
        })
      })

      const cleanup = () => {
        tails.forEach(t => {
          try {
            t.kill()
          } catch (e) {}
        })
      }
      process.on('SIGINT', cleanup)
      process.on('SIGTERM', cleanup)
      process.on('exit', cleanup)
    }

    require('../index.js')
  } else if (command === 'build') {
    console.log('🏗️  Building for production...')

    const configs = getTailwindConfigs()
    let hasError = false

    configs.forEach(({input, cssOutput, name, isCustom}) => {
      console.log(`🎨 Compiling ${name} (${isCustom ? 'Custom' : 'Default'}) CSS...`)
      try {
        execSync(`npx @tailwindcss/cli -i "${input}" -o "${cssOutput}" --minify`, {
          stdio: 'inherit',
          cwd: process.cwd()
        })
      } catch (error) {
        console.error(`❌ Build failed for ${name}:`, error.message)
        hasError = true
      }
    })

    if (hasError) {
      process.exit(1)
    } else {
      console.log('✅ All builds completed successfully!')
    }
  } else if (command === 'start') {
    process.env.NODE_ENV = 'production'
    require('../index.js')
  } else if (command === 'skills') {
    await manageSkills()
  } else {
    console.log('Usage:')
    console.log('  npx odac init            (Interactive mode)')
    console.log('  npx odac init <project>  (Quick mode)')
    console.log('  npx odac dev             (Development mode)')
    console.log('  npx odac build           (Production build)')
    console.log('  npx odac start           (Start server)')
    console.log('  npx odac skills          (Sync AI Agent skills)')
  }

  rl.close()
}

run()
