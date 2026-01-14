#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { execSync, spawn } = require('node:child_process')

const command = process.argv[2]
const args = process.argv.slice(3)

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

const ask = question => new Promise(resolve => rl.question(question, answer => resolve(answer.trim())))

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
        const cssInput = path.join(process.cwd(), 'view/css/app.css')
        if (fs.existsSync(cssInput)) {
            const cssOutput = path.join(process.cwd(), 'public/css/app.css')
            const cssOutputDir = path.dirname(cssOutput)

            if (!fs.existsSync(cssOutputDir)) fs.mkdirSync(cssOutputDir, { recursive: true })

            console.log('🎨 Starting Tailwind CSS...')
            const tailwind = spawn('npx', ['@tailwindcss/cli', '-i', cssInput, '-o', cssOutput, '--watch'], {
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
    } else {
        console.log('Usage:')
        console.log('  npx odac init            (Interactive mode)')
        console.log('  npx odac init <project>  (Quick mode)')
    }

    rl.close()
}

run()
