import react from '@vitejs/plugin-react'
import { defaultClientConditions } from 'vite'
import { defineConfig } from 'vitest/config'

// Cross-origin isolation: multi-threaded WebAssembly in onnxruntime-web needs it.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
