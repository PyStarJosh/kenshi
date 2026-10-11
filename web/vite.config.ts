import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defaultClientConditions } from 'vite'
import { defineConfig } from 'vitest/config'

// Cross-origin isolation: multi-threaded WebAssembly in onnxruntime-web needs it.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// Stamped into every test log, so a log says which build produced it. Vercel provides the commit; locally ask git.
function gitCommit(): string {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA
  if (fromEnv) return fromEnv.slice(0, 7)
  try {
    const hash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== ''
    return dirty ? `${hash}-dirty` : hash
  } catch {
    return 'unknown'
  }
}

const appVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
  },
  // The detection worker uses dynamic imports, which need ES module output.
  worker: { format: 'es' },
  resolve: {
    // Use onnxruntime-web without its WebAssembly embedded; we serve those files ourselves from public/ort/.
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
  },
  server: {
    host: true,
    // Lets a phone reach the dev server through ngrok.
    allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev'],
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
})
