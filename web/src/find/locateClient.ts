// The app's side of POST /api/locate (FR-22): encode frames, send them with a timeout, and return a typed outcome.
// It never throws to the UI. It also keeps the free tier safe: a minimum gap between calls and a per-minute cap.
// Thin: the pure parts (sizes, base64, the limiter, response checks) are tested; fetch and canvas are injected.
import { CONFIG } from '../core/config'
import type { LocateErrorCode, LocateFrame, LocateRequest, LocateResult } from '../core/types'

/** What can go wrong on the app's side, besides the function's own codes. */
export type LocateClientErrorCode = LocateErrorCode | 'too_soon' | 'limit'

export type LocateOutcome =
  | { ok: true; result: LocateResult }
  | { ok: false; error: LocateClientErrorCode; message: string; retryAfterMs: number | null }

/** A camera frame with the heading and pitch it was taken at, before encoding. */
export interface Capture {
  bitmap: ImageBitmap
  heading: number
  pitch: number
}

export interface LocatorDeps {
  fetchImpl?: typeof fetch
  /** Encode a frame to base64 JPEG; replaced in tests. */
  encode?: (bitmap: ImageBitmap) => Promise<string>
  now?: () => number
  endpoint?: string
  timeoutMs?: number
  minGapMs?: number
  maxPerMinute?: number
}

/** Size to scale a frame to so it is at most `width` wide; frames already narrower keep their size. */
export function scaledSize(width: number, height: number, targetWidth: number): { width: number; height: number } {
  if (width <= targetWidth) return { width, height }
  const scale = targetWidth / width
  return { width: targetWidth, height: Math.max(1, Math.round(height * scale)) }
}

/** Base64 of some bytes, in chunks so a large frame does not overflow the argument limit of String.fromCharCode. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

/**
 * Downscale a camera frame to about 640 px wide and encode it as base64 JPEG (no "data:" prefix). Encoding runs
 * through OffscreenCanvas.convertToBlob, which does the compression off the main thread; an older Safari without
 * OffscreenCanvas falls back to a canvas element.
 */
export async function frameToJpegBase64(
  frame: ImageBitmap,
  widthPx: number = CONFIG.find.imageWidthPx,
  quality: number = CONFIG.find.jpegQuality,
): Promise<string> {
  const { width, height } = scaledSize(frame.width, frame.height, widthPx)
  let blob: Blob | null
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No 2D canvas to encode the frame.')
    context.drawImage(frame, 0, 0, width, height)
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  } else {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No 2D canvas to encode the frame.')
    context.drawImage(frame, 0, 0, width, height)
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  }
  if (!blob) throw new Error('Could not encode the frame.')
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

export type LimitCheck = { ok: true } | { ok: false; error: 'too_soon' | 'limit'; retryAfterMs: number }

/** Keeps calls under the free tier: a minimum gap since the last call, and a cap per sliding minute. */
export class CallLimiter {
  private calls: number[] = []
  private readonly minGapMs: number
  private readonly maxPerMinute: number

  constructor(minGapMs: number, maxPerMinute: number) {
    this.minGapMs = minGapMs
    this.maxPerMinute = maxPerMinute
  }

  check(nowMs: number): LimitCheck {
    this.calls = this.calls.filter((t) => nowMs - t < 60_000)
    const last = this.calls.at(-1)
    if (last !== undefined && nowMs - last < this.minGapMs) {
      return { ok: false, error: 'too_soon', retryAfterMs: this.minGapMs - (nowMs - last) }
    }
    if (this.calls.length >= this.maxPerMinute) {
      return { ok: false, error: 'limit', retryAfterMs: 60_000 - (nowMs - this.calls[0]) }
    }
    return { ok: true }
  }

  record(nowMs: number): void {
    this.calls.push(nowMs)
  }
}

const CODES: readonly LocateErrorCode[] = ['bad_request', 'timeout', 'quota', 'auth', 'bad_response', 'network']

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** True when the value has the shape of a LocateResult (a found result must carry a frame index and a box). */
export function isLocateResult(value: unknown): value is LocateResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.found !== 'boolean' || !isNumber(v.confidence) || !isNumber(v.latencyMs)) return false
  if (typeof v.label !== 'string' || typeof v.onFloor !== 'boolean') return false
  if (v.distanceM !== null && !isNumber(v.distanceM)) return false
  if (v.signHint !== null && typeof v.signHint !== 'string') return false
  if (!v.found) return v.frameIndex === null && v.box === null
  const box = v.box as Record<string, unknown> | null
  return (
    Number.isInteger(v.frameIndex) &&
    typeof box === 'object' &&
    box !== null &&
    ['x0', 'y0', 'x1', 'y1'].every((k) => isNumber(box[k]) && (box[k] as number) >= 0 && (box[k] as number) <= 1)
  )
}

const failure = (error: LocateClientErrorCode, message: string, retryAfterMs: number | null = null): LocateOutcome => ({
  ok: false,
  error,
  message,
  retryAfterMs,
})

export class Locator {
  private readonly limiter: CallLimiter
  private readonly fetchImpl: typeof fetch
  private readonly encode: (bitmap: ImageBitmap) => Promise<string>
  private readonly now: () => number
  private readonly endpoint: string
  private readonly timeoutMs: number
  private inFlight = false

  constructor(deps: LocatorDeps = {}) {
    const find = CONFIG.find
    this.limiter = new CallLimiter(deps.minGapMs ?? find.minGapMs, deps.maxPerMinute ?? find.maxPerMinute)
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init))
    this.encode = deps.encode ?? ((bitmap) => frameToJpegBase64(bitmap))
    this.now = deps.now ?? (() => performance.now())
    this.endpoint = deps.endpoint ?? '/api/locate'
    this.timeoutMs = deps.timeoutMs ?? find.requestTimeoutMs
  }

  /** Ask where the target is. Every failure comes back as { ok: false }; nothing is thrown. */
  async locate(target: string, captures: readonly Capture[]): Promise<LocateOutcome> {
    const { maxFrames, maxTargetChars } = CONFIG.find
    const name = target.trim()
    if (name.length === 0 || name.length > maxTargetChars) return failure('bad_request', 'The target name must be 1 to 60 characters.')
    if (captures.length < 1 || captures.length > maxFrames) return failure('bad_request', 'Send one to eight frames.')

    const limit = this.limiter.check(this.now())
    if (!limit.ok) return failure(limit.error, 'Too many searches too fast.', limit.retryAfterMs)
    if (this.inFlight) return failure('too_soon', 'A search is already running.', this.timeoutMs)
    this.inFlight = true
    this.limiter.record(this.now())
    try {
      return await this.send({ target: name, frames: await this.encodeAll(captures) })
    } catch {
      return failure('bad_request', 'Could not prepare the pictures.')
    } finally {
      this.inFlight = false
    }
  }

  private encodeAll(captures: readonly Capture[]): Promise<LocateFrame[]> {
    return Promise.all(
      captures.map(async (c) => ({ jpeg: await this.encode(c.bitmap), heading: c.heading, pitch: c.pitch })),
    )
  }

  private async send(request: LocateRequest): Promise<LocateOutcome> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return failure('timeout', 'The request timed out.')
      return failure('network', 'Could not reach the server.')
    } finally {
      clearTimeout(timer)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return failure(response.ok ? 'bad_response' : 'network', 'The reply was not JSON.')
    }
    if (!response.ok) {
      const code = (body as { error?: unknown } | null)?.error
      return failure(CODES.find((c) => c === code) ?? 'network', `The server answered ${response.status}.`)
    }
    if (!isLocateResult(body)) return failure('bad_response', 'The reply had the wrong shape.')
    return { ok: true, result: body }
  }
}
