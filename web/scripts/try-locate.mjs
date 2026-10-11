// Try the locate function by hand with a JPEG. Needs the function running (npx vercel dev, or a deployment) and a
// real GEMINI_API_KEY there. Sends the picture to Google Gemini, so use a picture you are happy to share.
//
//   node scripts/try-locate.mjs <image.jpg> "<target>" [base url]
//   node scripts/try-locate.mjs public/samples/bus.jpg "bus" http://localhost:3000
import { readFileSync } from 'node:fs'

const [file, target, base = 'http://localhost:3000'] = process.argv.slice(2)
if (!file || !target) {
  console.error('Usage: node scripts/try-locate.mjs <image.jpg> "<target>" [base url]')
  process.exit(1)
}
const frame = readFileSync(file).toString('base64')
const started = performance.now()
const response = await fetch(`${base}/api/locate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ target, frames: [frame] }),
})
console.log(`${response.status} in ${Math.round(performance.now() - started)} ms`)
console.log(await response.text())
