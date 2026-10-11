// Frame scheduler: latest frame wins. A frame is captured only when the detector is idle,
// so frames are never queued and every frame sent is the freshest one available.
import type { FrameResult } from '../core/types'

/** Ask for a callback on the next video frame; returns a function that cancels it. */
export type FrameRequester = (callback: () => void) => () => void

export interface SchedulerOptions {
  /** Upper limit on frames sent per second. */
  maxFps: number
  /** Fraction of the minimum gap (1000 / maxFps) after which a frame is accepted, to absorb timing jitter. */
  frameGapTolerance: number
  requestFrame: FrameRequester
  /** Capture the current frame, or null if the video has no frame yet. */
  grab: () => Promise<ImageBitmap | null>
  /** Send a frame to the detector; resolves null if it was replaced by a newer one. */
  detect: (bitmap: ImageBitmap, frameId: number, captureTimeMs: number) => Promise<FrameResult | null>
  now: () => number
  onResult: (result: FrameResult) => void
  /** Called for each failed frame with the number of failures in a row. */
  onError: (error: unknown, consecutiveErrors: number) => void
}

export class FrameScheduler {
  private options: SchedulerOptions
  private running = false
  private busy = false
  private lastCaptureMs = -Infinity
  private nextFrameId = 0
  private consecutiveErrors = 0
  private cancel: (() => void) | null = null

  constructor(options: SchedulerOptions) {
    this.options = options
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.arm()
  }

  stop(): void {
    this.running = false
    this.cancel?.()
    this.cancel = null
  }

  private arm(): void {
    this.cancel = this.options.requestFrame(() => this.tick())
  }

  private tick(): void {
    if (!this.running) return
    this.arm()
    this.maybeCapture()
  }

  /** Capture now if the detector is idle and the minimum gap has passed. */
  private maybeCapture(): void {
    const t = this.options.now()
    const minGapMs = (1000 / this.options.maxFps) * this.options.frameGapTolerance
    if (this.busy || t - this.lastCaptureMs < minGapMs) return
    this.busy = true
    this.lastCaptureMs = t
    void this.process(t)
  }

  private async process(captureTimeMs: number): Promise<void> {
    try {
      const bitmap = await this.options.grab()
      if (!bitmap) return
      const result = await this.options.detect(bitmap, this.nextFrameId++, captureTimeMs)
      this.consecutiveErrors = 0
      if (result && this.running) this.options.onResult(result)
    } catch (error) {
      this.consecutiveErrors++
      this.options.onError(error, this.consecutiveErrors)
    } finally {
      this.busy = false
      // A detection that outlasts a camera frame would otherwise wait for the next one (a 70 ms
      // detector on a 30 fps camera would fall to 10 fps), so capture the newest frame right away.
      if (this.running) this.maybeCapture()
    }
  }
}

/** requestVideoFrameCallback when the browser has it (one call per new camera frame), else requestAnimationFrame. */
export function createFrameRequester(video: HTMLVideoElement): FrameRequester {
  if ('requestVideoFrameCallback' in video) {
    return (callback) => {
      const id = video.requestVideoFrameCallback(() => callback())
      return () => video.cancelVideoFrameCallback(id)
    }
  }
  return (callback) => {
    const id = requestAnimationFrame(() => callback())
    return () => cancelAnimationFrame(id)
  }
}

// HTMLMediaElement.HAVE_CURRENT_DATA: the video has at least one frame to draw.
const HAVE_CURRENT_DATA = 2

export interface BitmapGrabberDeps {
  createBitmap: (source: ImageBitmapSource) => Promise<ImageBitmap>
  createCanvas: () => HTMLCanvasElement
}

const defaultDeps: BitmapGrabberDeps = {
  createBitmap: (source) => createImageBitmap(source),
  createCanvas: () => document.createElement('canvas'),
}

/**
 * Make an ImageBitmap of the current video frame. If creating one straight from the video fails,
 * draw the frame onto a canvas and make the bitmap from that, and keep doing so.
 */
export function createBitmapGrabber(
  video: HTMLVideoElement,
  deps: BitmapGrabberDeps = defaultDeps,
): () => Promise<ImageBitmap | null> {
  let canvas: HTMLCanvasElement | null = null
  return async () => {
    if (video.readyState < HAVE_CURRENT_DATA || video.videoWidth === 0) return null
    if (!canvas) {
      try {
        return await deps.createBitmap(video)
      } catch {
        // Some browsers cannot read a video element directly; switch to the canvas route.
        canvas = deps.createCanvas()
      }
    }
    // Setting a canvas's size reallocates it, so only when the picture size changed (not on every frame).
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not draw the video frame to a canvas')
    ctx.drawImage(video, 0, 0)
    return deps.createBitmap(canvas)
  }
}
