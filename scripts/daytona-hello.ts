// Smoke test for Daytona: create a sandbox, run Hello World, print the output, delete the sandbox.
// Run: npm run daytona-hello   (needs DAYTONA_API_KEY in .env)
import { Daytona } from '@daytona/sdk'

if (!process.env.DAYTONA_API_KEY) {
  console.error('DAYTONA_API_KEY is not set. Create one at https://app.daytona.io/dashboard/keys and add it to .env')
  process.exit(1)
}

const daytona = new Daytona() // reads DAYTONA_API_KEY (and optional DAYTONA_API_URL / DAYTONA_TARGET) from env

console.log('Creating sandbox...')
const sandbox = await daytona.create({ language: 'typescript' })
console.log(`Sandbox ${sandbox.id} created`)

try {
  const response = await sandbox.process.codeRun('console.log("Hello World from Daytona!")')
  if (response.exitCode !== 0) {
    throw new Error(`Hello World failed (exit ${response.exitCode}): ${response.result}`)
  }
  console.log('Output:', response.result.trim())
} finally {
  console.log('Deleting sandbox...')
  await daytona.delete(sandbox)
  console.log('Sandbox deleted')
}
