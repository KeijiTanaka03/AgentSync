import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key]
}
if (args[0] === '--real-cli') {
  args.shift()
  env.AGENTSYNC_E2E = '1'
}

const child = spawn(process.execPath, args, { env, stdio: 'inherit' })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
child.on('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
