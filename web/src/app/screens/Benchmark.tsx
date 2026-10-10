// Benchmark screen (open the app with ?bench): measures real inference speed on this device.
import { useEffect, useRef, useState } from 'react'
import { CONFIG } from '../../core/config'
import type { Detection, FrameResult } from '../../core/types'
import { DetectionEngine } from '../../detection/engine'
import type { EngineInfo, ProviderChoice } from '../../detection/protocol'
import { summarize } from './benchmarkStats'
import type { BenchmarkStats, Spread } from './benchmarkStats'
import './Benchmark.css'

type ModelSize = 320 | 416
type Phase = 'idle' | 'loading' | 'warmup' | 'timed' | 'done' | 'error'

const SAMPLE_URL = `${import.meta.env.BASE_URL}samples/bus.jpg`
const modelUrl = (size: ModelSize) => `${import.meta.env.BASE_URL}models/yolo26n-${size}.onnx`
const ms = (value: number) => value.toFixed(1)

function statusText(phase: Phase, done: number, total: number, error: string | null): string {
  switch (phase) {
    case 'idle':
      return 'Choose a model and provider, then press Run.'
    case 'loading':
      return 'Loading the model.'
    case 'warmup':
    case 'timed':
      return `${phase === 'warmup' ? 'Warming up' : 'Timing'}: ${done} of ${total} inferences.`
    case 'done':
      return 'Benchmark finished.'
    case 'error':
      return `Benchmark failed: ${error ?? 'unknown error'}`
  }
}

function drawDetections(canvas: HTMLCanvasElement, image: ImageBitmap, detections: Detection[]): void {
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(image, 0, 0)
  const line = Math.max(2, Math.round(image.width / 300))
  ctx.lineWidth = line
  ctx.font = `${Math.round(line * 7)}px system-ui, sans-serif`
  ctx.textBaseline = 'top'
  for (const d of detections) {
    const x = d.box.x * image.width
    const y = d.box.y * image.height
    ctx.strokeStyle = '#ffeb3b'
    ctx.strokeRect(x, y, d.box.width * image.width, d.box.height * image.height)
    const label = `${d.label} ${d.confidence.toFixed(2)}`
    const pad = line * 2
    const width = ctx.measureText(label).width + pad * 2
    ctx.fillStyle = '#000000cc'
    ctx.fillRect(x, y, width, line * 9)
    ctx.fillStyle = '#ffeb3b'
    ctx.fillText(label, x + pad, y + line)
  }
}

function SpreadRow({ name, spread }: { name: string; spread: Spread }) {
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>{ms(spread.p50)}</td>
      <td>{ms(spread.p95)}</td>
    </tr>
  )
}

export default function Benchmark() {
  const [size, setSize] = useState<ModelSize>(320)
  const [provider, setProvider] = useState<ProviderChoice>('auto')
  const [phase, setPhase] = useState<Phase>('idle')
  const [done, setDone] = useState(0)
  const [info, setInfo] = useState<EngineInfo | null>(null)
  const [stats, setStats] = useState<BenchmarkStats | null>(null)
  const [detections, setDetections] = useState<Detection[]>([])
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<DetectionEngine | null>(null)

  useEffect(() => () => engineRef.current?.terminate(), [])

  const { warmupRuns, timedRuns } = CONFIG.benchmark
  const running = phase === 'loading' || phase === 'warmup' || phase === 'timed'

  async function run() {
    engineRef.current?.terminate()
    setInfo(null)
    setStats(null)
    setDetections([])
    setError(null)
    setDone(0)
    setPhase('loading')
    const engine = new DetectionEngine()
    engineRef.current = engine
    try {
      setInfo(await engine.init(modelUrl(size), provider))
      const response = await fetch(SAMPLE_URL)
      if (!response.ok) throw new Error(`Could not load the sample image (${response.status})`)
      const blob = await response.blob()

      const timed: FrameResult[] = []
      const roundTrips: number[] = []
      let last: FrameResult | null = null
      for (let i = 0; i < warmupRuns + timedRuns; i++) {
        setPhase(i < warmupRuns ? 'warmup' : 'timed')
        const bitmap = await createImageBitmap(blob)
        const sent = performance.now()
        const result = await engine.detect(bitmap, i, sent)
        const roundTrip = performance.now() - sent
        if (!result) throw new Error('The benchmark was stopped')
        last = result
        if (i >= warmupRuns) {
          timed.push(result)
          roundTrips.push(roundTrip)
        }
        setDone(i + 1)
      }
      if (!last) throw new Error('No inference ran')
      setStats(summarize(timed, roundTrips))
      setDetections(last.detections)
      const image = await createImageBitmap(blob)
      if (canvasRef.current) drawDetections(canvasRef.current, image, last.detections)
      image.close()
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }

  return (
    <main className="bench">
      <h1>Navigator benchmark</h1>
      <div className="bench-controls">
        <label>
          Model size
          <select value={size} disabled={running} onChange={(e) => setSize(Number(e.target.value) as ModelSize)}>
            <option value={320}>320</option>
            <option value={416}>416</option>
          </select>
        </label>
        <label>
          Provider
          <select
            value={provider}
            disabled={running}
            onChange={(e) => setProvider(e.target.value as ProviderChoice)}
          >
            <option value="auto">auto</option>
            <option value="webgpu">webgpu</option>
            <option value="wasm">wasm</option>
          </select>
        </label>
        <button type="button" disabled={running} onClick={() => void run()}>
          Run
        </button>
      </div>
      <p role="status" aria-live="polite">
        {statusText(phase, done, warmupRuns + timedRuns, error)}
      </p>

      {info && (
        <dl className="bench-info">
          <dt>Provider</dt>
          <dd>{info.backend}</dd>
          {info.fallbackReason && (
            <>
              <dt>WebGPU skipped because</dt>
              <dd>{info.fallbackReason}</dd>
            </>
          )}
          <dt>crossOriginIsolated</dt>
          <dd>{String(info.crossOriginIsolated)}</dd>
          <dt>WebAssembly threads</dt>
          <dd>{info.threads}</dd>
          <dt>Model input</dt>
          <dd>{info.inputSize}</dd>
          <dt>Load time (ms)</dt>
          <dd>{ms(info.loadMs)}</dd>
        </dl>
      )}

      {stats && (
        <table className="bench-stats">
          <caption>
            Milliseconds over {timedRuns} timed inferences after {warmupRuns} warm-up
          </caption>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">p50</th>
              <th scope="col">p95</th>
            </tr>
          </thead>
          <tbody>
            <SpreadRow name="Preprocess" spread={stats.preprocess} />
            <SpreadRow name="Inference" spread={stats.inference} />
            <SpreadRow name="Postprocess" spread={stats.postprocess} />
            <SpreadRow name="Total (worker)" spread={stats.total} />
            <SpreadRow name="Round trip" spread={stats.roundTrip} />
          </tbody>
        </table>
      )}

      <canvas ref={canvasRef} className="bench-canvas" hidden={phase !== 'done'} aria-label="Sample image with detected boxes" />
      {phase === 'done' && (
        <p className="bench-detections">
          {detections.length === 0
            ? 'No objects detected.'
            : `Detected: ${detections.map((d) => `${d.label} ${d.confidence.toFixed(2)}`).join(', ')}`}
        </p>
      )}
    </main>
  )
}
