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
    } catch (error) {
      console.error('❌ Error initializing project:', error.message)
    }
  } else if (command === 'dev') {
    if (cluster.isPrimary) {
      const configs = getTailwindConfigs()
      const tails = []

      configs.forEach(({input, cssOutput, name, isCustom}) => {
        let tailwindProcess = null

        const startWatcher = () => {
          const localCli = path.join(process.cwd(), 'node_modules', '.bin', 'tailwindcss')
          const useLocal = fs.existsSync(localCli)
          const cmd = useLocal ? localCli : 'npx'
          const args = useLocal ? ['-i', input, '-o', cssOutput, '--watch'] : ['@tailwindcss/cli', '-i', input, '-o', cssOutput, '--watch']

          console.log(`🎨 Starting Tailwind CSS for ${name} (${isCustom ? 'Custom' : 'Default'})...`)
          console.log(`📂 Watching directory: ${process.cwd()}`)

          tailwindProcess = spawn(cmd, args, {
            stdio: 'inherit',
            shell: !useLocal, // Valid for npm/npx compatibility if local not found
            cwd: process.cwd()
          })

          tailwindProcess.on('error', err => {
            console.error(`❌ Tailwind watcher failed to start for ${name}:`, err.message)
          })

          tailwindProcess.on('exit', code => {
            if (code !== 0 && code !== null) {
              console.warn(`⚠️  Tailwind watcher for ${name} exited unexpectedly (code ${code}). Restarting in 1s...`)
              setTimeout(startWatcher, 1000)
            }
          })
        }

        startWatcher()

        // Push a wrapper compatible with the cleanup function
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
  } else {
    console.log('Usage:')
    console.log('  npx odac init            (Interactive mode)')
    console.log('  npx odac init <project>  (Quick mode)')
    console.log('  npx odac dev             (Development mode)')
    console.log('  npx odac build           (Production build)')
    console.log('  npx odac start           (Start server)')
  }

  rl.close()
}

run()
