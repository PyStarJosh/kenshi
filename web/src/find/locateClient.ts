// The app's side of POST /api/locate (FR-22): encode frames, send them with a timeout, and return a typed result or
// throw a LocateError. Thin: the pure parts (sizes, base64, response checks) are tested; fetch and canvas are injected
// or isolated so the rest needs no browser.
import { CONFIG } from '../core/config'
import type { LocateErrorKind, LocateRequest, LocateResult } from './locateTypes'

export class LocateError extends Error {
  readonly kind: LocateErrorKind
  constructor(kind: LocateErrorKind, message: string) {
    super(message)
    this.name = 'LocateError'
    this.kind = kind
  }
}

const KINDS: readonly LocateErrorKind[] = [
  'bad-request',
  'not-configured',
  'rate-limited',
  'unavailable',
  'bad-reply',
  'timeout',
  'network',
]

export interface LocateDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  endpoint?: string
}

/** Size to scale a frame to so its longer side is at most maxSide; frames already small enough keep their size. */
export function scaledSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxSide) return { width, height }
  const scale = maxSide / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Base64 of some bytes, in chunks so a large frame does not overflow the argument limit of String.fromCharCode. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

/** Downscale a camera frame and encode it as base64 JPEG (no "data:" prefix), ready for a LocateRequest. */
export async function frameToJpegBase64(
  frame: ImageBitmap,
  maxSide: number = CONFIG.find.maxImageSidePx,
  quality: number = CONFIG.find.jpegQuality,
): Promise<string> {
  const { width, height } = scaledSize(frame.width, frame.height, maxSide)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new LocateError('bad-request', 'No 2D canvas to encode the frame.')
  context.drawImage(frame, 0, 0, width, height)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

function isLocateResult(value: unknown): value is LocateResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.found === false) return true
  if (v.found !== true) return false
  const box = v.box as Record<string, unknown> | undefined
  return (
    Number.isInteger(v.frameIndex) &&
    typeof v.label === 'string' &&
    typeof v.confidence === 'number' &&
    typeof box === 'object' &&
    box !== null &&
    ['x', 'y', 'width', 'height'].every((k) => typeof box[k] === 'number' && Number.isFinite(box[k] as number))
  )
}

/** Ask the function where the target is. Throws LocateError for every failure, never anything else. */
export async function locateTarget(request: LocateRequest, deps: LocateDeps = {}): Promise<LocateResult> {
  const { maxFrames, maxTargetChars, requestTimeoutMs } = CONFIG.find
  if (request.frames.length < 1 || request.frames.length > maxFrames || request.target.trim().length === 0) {
    throw new LocateError('bad-request', 'Send a target and one to eight frames.')
  }
  if (request.target.length > maxTargetChars) throw new LocateError('bad-request', 'The target name is too long.')

  const fetchImpl = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? requestTimeoutMs)
  let response: Response
  try {
    response = await fetchImpl(deps.endpoint ?? '/api/locate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new LocateError('timeout', 'The request timed out.')
    throw new LocateError('network', 'Could not reach the server.')
  } finally {
    clearTimeout(timer)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new LocateError(response.ok ? 'bad-reply' : 'unavailable', 'The reply was not JSON.')
  }
  if (!response.ok) {
    const error = (body as { error?: unknown } | null)?.error
    const kind = KINDS.find((k) => k === error) ?? 'unavailable'
    throw new LocateError(kind, `The server answered ${response.status}.`)
  }
  if (!isLocateResult(body)) throw new LocateError('bad-reply', 'The reply had the wrong shape.')
  return body
}
