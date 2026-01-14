#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { execSync, spawn } = require('node:child_process')
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
 * @returns {{ input: string, cssOutput: string, isCustom: boolean }}
 */
function getTailwindConfig() {
    const userCssInput = path.join(process.cwd(), 'view/css/app.css')
    const cacheDir = path.join(process.cwd(), 'storage/.cache')
    const defaultCssInput = path.join(cacheDir, 'tailwind.css')
    const cssOutput = path.join(process.cwd(), 'public/assets/css/app.css')

    let input
    let isCustom = false

    if (fs.existsSync(userCssInput)) {
        input = userCssInput
        isCustom = true
    } else {
        fs.mkdirSync(cacheDir, { recursive: true })
        if (!fs.existsSync(defaultCssInput)) {
            fs.writeFileSync(defaultCssInput, '@import "tailwindcss";')
        }
        input = defaultCssInput
    }

    const cssOutputDir = path.dirname(cssOutput)
    fs.mkdirSync(cssOutputDir, { recursive: true })

    return { input, cssOutput, isCustom }
}

async function run() {
    if (command === 'init') {
        const projectName = args[0] || '.'
        const targetDir = path.resolve(process.cwd(), projectName)

        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })

        console.log(`🚀 Initializing new Odac project in: ${targetDir}`)
        const templateDir = path.resolve(__dirname, '../template')

        try {
            fs.cpSync(templateDir, targetDir, { recursive: true })

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
            const { input, cssOutput, isCustom } = getTailwindConfig()
            console.log(`🎨 Starting Tailwind CSS (${isCustom ? 'Custom' : 'Default'})...`)

            const tailwind = spawn('npx', ['@tailwindcss/cli', '-i', input, '-o', cssOutput, '--watch'], {
                stdio: 'inherit',
                shell: true,
                cwd: process.cwd()
            })

            const cleanup = () => {
                try {
                    tailwind.kill()
                } catch (e) {}
            }
            process.on('SIGINT', cleanup)
            process.on('SIGTERM', cleanup)
            process.on('exit', cleanup)
        }
        
        require('../index.js')
    } else if (command === 'build') {
        console.log('🏗️  Building for production...')
        
        const { input, cssOutput, isCustom } = getTailwindConfig()
        console.log(`🎨 Compiling ${isCustom ? 'Custom' : 'Default'} CSS...`)

        try {
            execSync(`npx @tailwindcss/cli -i ${input} -o ${cssOutput} --minify`, {
                stdio: 'inherit',
                cwd: process.cwd()
            })
            console.log('✅ Build completed successfully!')
        } catch (error) {
            console.error('❌ Build failed:', error.message)
            process.exit(1)
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
