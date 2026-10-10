// Messages between the main thread (engine.ts) and the detection worker (worker.ts).
import type { FrameResult, InferenceBackend } from '../core/types'

/** Which provider the caller wants. "auto" tries WebGPU, then WebAssembly. */
export type ProviderChoice = 'auto' | InferenceBackend

export type LoadErrorKind =
  | 'model-fetch-failed'
  | 'webgpu-unavailable'
  | 'wasm-failed'
  | 'class-mismatch'

export type WorkerRequest =
  | { type: 'init'; modelUrl: string; provider: ProviderChoice }
  | { type: 'detect'; frameId: number; captureTimeMs: number; bitmap: ImageBitmap }

/** What a successful init reports. */
export interface EngineInfo {
  /** The provider that actually loaded. */
  backend: InferenceBackend
  /** Why WebGPU was skipped when "auto" fell back to WebAssembly; null otherwise. */
  fallbackReason: string | null
  loadMs: number
  /** WebAssembly threads configured (1 when not cross-origin isolated). */
  threads: number
  crossOriginIsolated: boolean
  /** Square model input size read from the model. */
  inputSize: number
}

/** The worker cannot know when the main thread received a result, so engine.ts adds that. */
export type WorkerFrameResult = Omit<FrameResult, 'receivedTimeMs'>

export type WorkerResponse =
  | { type: 'ready'; info: EngineInfo }
  | { type: 'load-error'; kind: LoadErrorKind; message: string }
  | { type: 'result'; result: WorkerFrameResult }
  /** A newer frame arrived while this one waited, so it was discarded (latest frame wins). */
  | { type: 'dropped'; frameId: number }
  | { type: 'detect-error'; frameId: number; message: string }
