// Copies onnxruntime-web's WebAssembly files from node_modules into public/ort/ so they are
// served from our own origin (cross-origin isolation would block them on a CDN).
// Runs before dev and build.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules', 'onnxruntime-web', 'dist')
const target = join(root, 'public', 'ort')

// The WebGPU build of onnxruntime-web loads this loader and WebAssembly module for every provider.
const files = ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs']

mkdirSync(target, { recursive: true })
for (const name of files) {
  const from = join(source, name)
  if (!existsSync(from)) {
    console.error(`copy-ort: ${from} not found. Run npm install first.`)
    process.exit(1)
  }
  const to = join(target, name)
  if (!existsSync(to) || statSync(to).size !== statSync(from).size) copyFileSync(from, to)
}
