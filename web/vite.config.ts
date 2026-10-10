import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Cross-origin isolation: multi-threaded WebAssembly in onnxruntime-web needs it.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
