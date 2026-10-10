import { describe, expect, test } from 'vitest'
import { DetectionEngine, DetectionLoadError } from './engine'
import type { WorkerLike } from './engine'
import type { EngineInfo, WorkerRequest, WorkerResponse } from './protocol'

class FakeWorker implements WorkerLike {
  sent: WorkerRequest[] = []
  terminated = false
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  postMessage(message: WorkerRequest): void {
    this.sent.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  reply(message: WorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>)
  }
}

const info: EngineInfo = {
  backend: 'wasm',
  fallbackReason: null,
  loadMs: 12,
  threads: 4,
  crossOriginIsolated: true,
  inputSize: 320,
}

function setup() {
  const worker = new FakeWorker()
  return { worker, engine: new DetectionEngine(() => worker) }
}

const bitmap = { width: 1, height: 1, close() {} } as unknown as ImageBitmap

function result(frameId: number): WorkerResponse {
  return {
    type: 'result',
    result: {
      frameId,
      captureTimeMs: 5,
      frameWidth: 1280,
      frameHeight: 720,
      inputSize: 320,
      backend: 'wasm',
      timings: { preprocessMs: 1, inferenceMs: 2, postprocessMs: 3 },
      meanLuma: 0.5,
      detections: [],
    },
  }
}

describe('init', () => {
  test('resolves with what the worker reports', async () => {
    const { worker, engine } = setup()
    const promise = engine.init('/models/m.onnx', 'wasm')
    expect(worker.sent[0]).toEqual({ type: 'init', modelUrl: '/models/m.onnx', provider: 'wasm' })
    worker.reply({ type: 'ready', info })
    await expect(promise).resolves.toEqual(info)
  })

  test.each(['model-fetch-failed', 'webgpu-unavailable', 'wasm-failed'] as const)(
    'rejects with a typed %s error',
    async (kind) => {
      const { worker, engine } = setup()
      const promise = engine.init('/m.onnx')
      worker.reply({ type: 'load-error', kind, message: 'boom' })
      const error = await promise.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DetectionLoadError)
      expect((error as DetectionLoadError).kind).toBe(kind)
    },
  )

  test('a worker crash while loading rejects as a wasm-failed error', async () => {
    const { worker, engine } = setup()
    const promise = engine.init('/m.onnx')
    worker.onerror?.({ message: 'crashed' } as ErrorEvent)
    await expect(promise).rejects.toMatchObject({ kind: 'wasm-failed' })
  })
})

describe('detect', () => {
  test('resolves with the result and stamps the receive time', async () => {
    const { worker, engine } = setup()
    const promise = engine.detect(bitmap, 7, 5)
    expect(worker.sent[0]).toMatchObject({ type: 'detect', frameId: 7, captureTimeMs: 5 })
    worker.reply(result(7))
    const frame = await promise
    expect(frame?.frameId).toBe(7)
    expect(frame?.receivedTimeMs).toBeGreaterThan(0)
  })

  test('resolves null when the worker dropped the frame for a newer one', async () => {
    const { worker, engine } = setup()
    const first = engine.detect(bitmap, 1, 0)
    const second = engine.detect(bitmap, 2, 1)
    worker.reply({ type: 'dropped', frameId: 1 })
    worker.reply(result(2))
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toMatchObject({ frameId: 2 })
  })

  test('rejects when the worker reports an inference error', async () => {
    const { worker, engine } = setup()
    const promise = engine.detect(bitmap, 3, 0)
    worker.reply({ type: 'detect-error', frameId: 3, message: 'bad tensor' })
    await expect(promise).rejects.toThrow('bad tensor')
  })
})

describe('terminate', () => {
  test('stops the worker, resolves waiting frames with null, and blocks further use', async () => {
    const { worker, engine } = setup()
    const waiting = engine.detect(bitmap, 1, 0)
    engine.terminate()
    expect(worker.terminated).toBe(true)
    await expect(waiting).resolves.toBeNull()
    expect(() => engine.detect(bitmap, 2, 0)).toThrow('terminated')
  })
})
