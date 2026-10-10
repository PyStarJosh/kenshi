// Main-thread wrapper around the detection worker with a typed protocol and typed load errors.
import type { FrameResult } from '../core/types'
import type {
  EngineInfo,
  LoadErrorKind,
  ProviderChoice,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

export class DetectionLoadError extends Error {
  kind: LoadErrorKind
  constructor(kind: LoadErrorKind, message: string) {
    super(message)
    this.name = 'DetectionLoadError'
    this.kind = kind
  }
}

/** The subset of Worker that the engine uses; tests substitute a fake. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

export type WorkerFactory = () => WorkerLike

const createDefaultWorker: WorkerFactory = () =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as WorkerLike

interface PendingDetect {
  resolve: (result: FrameResult | null) => void
  reject: (error: Error) => void
}

export class DetectionEngine {
  private worker: WorkerLike | null
  private pendingInit: { resolve: (info: EngineInfo) => void; reject: (error: Error) => void } | null = null
  private pendingDetect = new Map<number, PendingDetect>()

  constructor(createWorker: WorkerFactory = createDefaultWorker) {
    this.worker = createWorker()
    this.worker.onmessage = (event) => this.handle(event.data)
    this.worker.onerror = (event) => this.fail(new Error(event.message || 'Detection worker crashed'))
  }

  /** Load the model. Rejects with a DetectionLoadError whose kind says what went wrong. */
  init(modelUrl: string, provider: ProviderChoice = 'auto'): Promise<EngineInfo> {
    const worker = this.requireWorker()
    return new Promise((resolve, reject) => {
      this.pendingInit = { resolve, reject }
      worker.postMessage({ type: 'init', modelUrl, provider })
    })
  }

  /**
   * Send one frame. The bitmap is transferred and closed by the worker.
   * Resolves with null if a newer frame replaced this one before it ran.
   */
  detect(bitmap: ImageBitmap, frameId: number, captureTimeMs: number): Promise<FrameResult | null> {
    const worker = this.requireWorker()
    return new Promise((resolve, reject) => {
      this.pendingDetect.set(frameId, { resolve, reject })
      worker.postMessage({ type: 'detect', frameId, captureTimeMs, bitmap }, [bitmap])
    })
  }

  /** Stop the worker. Waiting detect calls resolve with null. */
  terminate(): void {
    this.worker?.terminate()
    this.worker = null
    for (const pending of this.pendingDetect.values()) pending.resolve(null)
    this.pendingDetect.clear()
    this.pendingInit?.reject(new Error('Detection engine was terminated'))
    this.pendingInit = null
  }

  private requireWorker(): WorkerLike {
    if (!this.worker) throw new Error('Detection engine was terminated')
    return this.worker
  }

  private handle(message: WorkerResponse): void {
    switch (message.type) {
      case 'ready':
        this.pendingInit?.resolve(message.info)
        this.pendingInit = null
        break
      case 'load-error':
        this.pendingInit?.reject(new DetectionLoadError(message.kind, message.message))
        this.pendingInit = null
        break
      case 'result':
        this.settle(message.result.frameId, { ...message.result, receivedTimeMs: performance.now() })
        break
      case 'dropped':
        this.settle(message.frameId, null)
        break
      case 'detect-error':
        this.pendingDetect.get(message.frameId)?.reject(new Error(message.message))
        this.pendingDetect.delete(message.frameId)
        break
    }
  }

  private settle(frameId: number, result: FrameResult | null): void {
    this.pendingDetect.get(frameId)?.resolve(result)
    this.pendingDetect.delete(frameId)
  }

  /** The worker itself crashed: fail everything waiting. */
  private fail(error: Error): void {
    this.pendingInit?.reject(new DetectionLoadError('wasm-failed', error.message))
    this.pendingInit = null
    for (const pending of this.pendingDetect.values()) pending.reject(error)
    this.pendingDetect.clear()
  }
}
