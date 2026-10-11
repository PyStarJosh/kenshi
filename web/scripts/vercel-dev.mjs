// Run `vercel dev` (the app plus web/api/locate.ts) with web/.env.local loaded.
// `vercel dev` takes its variables from the Vercel project's Development environment and ignores .env.local for
// functions, so GEMINI_API_KEY and GEMINI_MODEL would be missing. This loads the file into the environment first;
// the file's values are never printed. Extra arguments go to `vercel dev` (the default port is 3000).
//
//   npm run dev:api
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

if (existsSync('.env.local')) process.loadEnvFile('.env.local')
else console.warn('web/.env.local not found: GEMINI_API_KEY will be missing. See README, "Find (Gemini) setup".')

const args = process.argv.slice(2)
const child = spawn('npx', ['vercel', 'dev', ...(args.includes('--listen') ? [] : ['--listen', '3000']), ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
child.on('exit', (code) => process.exit(code ?? 1))
