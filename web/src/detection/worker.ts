// Detection worker: loads the ONNX model with onnxruntime-web and turns frames into Detections.
// All heavy work (preprocess, inference, postprocess) happens here, never on the main thread.
import * as ort from 'onnxruntime-web/webgpu'
import { CONFIG } from '../core/config'
import type { InferenceBackend } from '../core/types'
import { CLASSES } from './classes'
import type {
  EngineInfo,
  LoadErrorKind,
  ProviderChoice,
  WorkerRequest,
  WorkerResponse,
} from './protocol'
import { computeLetterbox, decodeDetections, nms } from './postprocess'
import type { Letterbox } from './postprocess'
import { rgbaToTensor } from './preprocess'

interface WorkerScope {
  postMessage(message: WorkerResponse): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}
const scope = self as unknown as WorkerScope

// Padding colour ultralytics uses when letterboxing.
const PAD_GRAY = 114

interface Loaded {
  session: ort.InferenceSession
  inputName: string
  outputName: string
  inputSize: number
  numClasses: number
  thresholds: Float32Array
  labels: string[]
  canvas: OffscreenCanvas
  ctx: OffscreenCanvasRenderingContext2D
  tensorData: Float32Array
}

interface PendingFrame {
  frameId: number
  captureTimeMs: number
  bitmap: ImageBitmap
}

class LoadFailure extends Error {
  kind: LoadErrorKind
  constructor(kind: LoadErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

let loaded: Loaded | null = null
let backend: InferenceBackend | null = null
let busy = false
let pending: PendingFrame | null = null

scope.onmessage = (event) => {
  const request = event.data
  if (request.type === 'init') {
    void init(request.modelUrl, request.provider)
  } else {
    submit({ frameId: request.frameId, captureTimeMs: request.captureTimeMs, bitmap: request.bitmap })
  }
}

async function init(modelUrl: string, provider: ProviderChoice): Promise<void> {
  const started = performance.now()
  try {
    const threads = configureWasm()
    const modelBytes = await fetchModel(modelUrl)
    const { session, backend: used, fallbackReason } = await createSession(modelBytes, provider)
    loaded = buildLoaded(session)
    backend = used
    const info: EngineInfo = {
      backend: used,
      fallbackReason,
      loadMs: performance.now() - started,
      threads,
      crossOriginIsolated: self.crossOriginIsolated,
      inputSize: loaded.inputSize,
    }
    scope.postMessage({ type: 'ready', info })
  } catch (error) {
    const failure =
      error instanceof LoadFailure ? error : new LoadFailure('wasm-failed', describe(error))
    scope.postMessage({ type: 'load-error', kind: failure.kind, message: failure.message })
  }
}

/** Point onnxruntime-web at our own copy of its WebAssembly files and choose the thread count. */
function configureWasm(): number {
  ort.env.wasm.wasmPaths = `${self.location.origin}${import.meta.env.BASE_URL}ort/`
  const threads = self.crossOriginIsolated
    ? Math.max(1, Math.min(CONFIG.detection.maxWasmThreads, navigator.hardwareConcurrency || 1))
    : 1
  ort.env.wasm.numThreads = threads
  return threads
}

async function fetchModel(modelUrl: string): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(modelUrl)
  } catch (error) {
    throw new LoadFailure('model-fetch-failed', `Could not fetch ${modelUrl}: ${describe(error)}`)
  }
  if (!response.ok) {
    throw new LoadFailure('model-fetch-failed', `Fetching ${modelUrl} returned ${response.status}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

async function createSession(
  modelBytes: Uint8Array,
  provider: ProviderChoice,
): Promise<{ session: ort.InferenceSession; backend: InferenceBackend; fallbackReason: string | null }> {
  let fallbackReason: string | null = null
  if (provider !== 'wasm') {
    try {
      await requireWebGpu()
      const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['webgpu'] })
      return { session, backend: 'webgpu', fallbackReason: null }
    } catch (error) {
      if (provider === 'webgpu') {
        throw new LoadFailure('webgpu-unavailable', describe(error))
      }
      fallbackReason = describe(error)
    }
  }
  try {
    const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] })
    return { session, backend: 'wasm', fallbackReason }
  } catch (error) {
    throw new LoadFailure('wasm-failed', describe(error))
  }
}

async function requireWebGpu(): Promise<void> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) throw new Error('WebGPU is not available in this browser')
  if (!(await gpu.requestAdapter())) throw new Error('No WebGPU adapter was found')
}

function buildLoaded(session: ort.InferenceSession): Loaded {
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]
  const inputDims = session.inputMetadata[0]
  const outputDims = session.outputMetadata[0]
  if (!inputDims.isTensor || !outputDims.isTensor) throw new LoadFailure('wasm-failed', 'Unexpected model signature')
  const inputSize = Number(inputDims.shape[2])
  const channels = Number(outputDims.shape[1])
  const numClasses = channels - 4
  if (numClasses !== CLASSES.length) {
    throw new LoadFailure(
      'class-mismatch',
      `Model has ${numClasses} classes but classes.ts has ${CLASSES.length}; run ml/gen_classes.py`,
    )
  }
  const canvas = new OffscreenCanvas(inputSize, inputSize)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new LoadFailure('wasm-failed', 'Could not create an OffscreenCanvas 2D context')
  const labels = CLASSES.map((c) => c.label)
  const fallback = CONFIG.detection.confidenceThreshold.default
  const thresholds = Float32Array.from(labels, (l) => CONFIG.detection.confidenceThreshold[l] ?? fallback)
  return {
    session,
    inputName,
    outputName,
    inputSize,
    numClasses,
    thresholds,
    labels,
    canvas,
    ctx,
    tensorData: new Float32Array(3 * inputSize * inputSize),
  }
}

/** Latest frame wins: while one frame runs, only the newest waiting frame is kept. */
function submit(frame: PendingFrame): void {
  if (pending) {
    pending.bitmap.close()
    scope.postMessage({ type: 'dropped', frameId: pending.frameId })
  }
  pending = frame
  if (!busy) void drain()
}

async function drain(): Promise<void> {
  busy = true
  try {
    while (pending) {
      const frame = pending
      pending = null
      await detect(frame)
    }
  } finally {
    busy = false
  }
}

async function detect(frame: PendingFrame): Promise<void> {
  const { frameId, captureTimeMs, bitmap } = frame
  try {
    if (!loaded || !backend) throw new Error('Detection engine is not initialized')
    const model = loaded
    const frameWidth = bitmap.width
    const frameHeight = bitmap.height

    const t0 = performance.now()
    const lb = computeLetterbox(frameWidth, frameHeight, model.inputSize)
    drawLetterboxed(model, bitmap, lb)
    const rgba = model.ctx.getImageData(0, 0, lb.size, lb.size).data
    const meanLuma = rgbaToTensor(rgba, lb, model.tensorData)
    const t1 = performance.now()

    const input = new ort.Tensor('float32', model.tensorData, [1, 3, lb.size, lb.size])
    const outputs = await model.session.run({ [model.inputName]: input })
    const output = outputs[model.outputName]
    const t2 = performance.now()

    const numAnchors = output.dims[2]
    const raw = decodeDetections(output.data as Float32Array, numAnchors, model.numClasses, model.thresholds, model.labels, lb)
    const detections = nms(raw, CONFIG.detection.nmsIou)
    const t3 = performance.now()

    scope.postMessage({
      type: 'result',
      result: {
        frameId,
        captureTimeMs,
        frameWidth,
        frameHeight,
        inputSize: model.inputSize,
        backend,
        timings: { preprocessMs: t1 - t0, inferenceMs: t2 - t1, postprocessMs: t3 - t2 },
        meanLuma,
        detections,
      },
    })
  } catch (error) {
    scope.postMessage({ type: 'detect-error', frameId, message: describe(error) })
  } finally {
    bitmap.close()
  }
}

function drawLetterboxed(model: Loaded, bitmap: ImageBitmap, lb: Letterbox): void {
  const { ctx } = model
  ctx.fillStyle = `rgb(${PAD_GRAY}, ${PAD_GRAY}, ${PAD_GRAY})`
  ctx.fillRect(0, 0, lb.size, lb.size)
  ctx.drawImage(bitmap, lb.padX, lb.padY, lb.drawWidth, lb.drawHeight)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
