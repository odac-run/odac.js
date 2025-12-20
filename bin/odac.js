#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { execSync } = require('node:child_process')

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

        // 1. Validate Target Directory
        if (fs.existsSync(targetDir)) {
            const files = fs.readdirSync(targetDir)
            const isNotEmpty = files.some(file =>
                !['.git', '.DS_Store', '.gitignore', '.idea', '.vscode'].includes(file)
            )

            if (isNotEmpty) {
                console.error(`❌ Error: Directory "${projectName === '.' ? 'Current directory' : projectName}" is not empty.`)
                console.error('   Please run in an empty directory or specify a new project name.')
                process.exit(1)
            }
        } else {
            fs.mkdirSync(targetDir, { recursive: true })
        }

        // 4. Copy Template
        console.log(`🚀 Initializing new Odac project in: ${targetDir}`)
        const templateDir = path.resolve(__dirname, '../template')

        try {
            // Recursive copy
            fs.cpSync(templateDir, targetDir, { recursive: true })

            // Update package.json
            const pkgPath = path.join(targetDir, 'package.json')
            const frameworkPkg = require('../package.json')

            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
            pkg.name = projectName === '.' ? path.basename(targetDir) : projectName
            pkg.version = '0.0.1'

            // Inject framework dependency
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
            console.log('\n🚀 Starting server...')

            try {
                execSync('npm run dev', {
                    stdio: 'inherit',
                    cwd: targetDir
                })
            } catch (err) {
                // User probably cancelled with Ctrl+C
                console.log('\n👋 Server stopped.')
            }

        } catch (error) {
            console.error('❌ Error initializing project:', error.message)
        }

    } else if (command === 'dev') {
        // Start the framework
        require('../index.js')
    } else {
        console.log('Usage:')
        console.log('  npx odac init            (Interactive mode)')
        console.log('  npx odac init <project>  (Quick mode)')
    }

    rl.close()
}

run()
