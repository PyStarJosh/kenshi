// Exponential smoothing. Factors in config are per frame at a reference frame period; alphaFor scales
// them to the real time between frames, so the result does not depend on the frame rate.
import type { BoundingBox } from '../core/types'

/** The factor to use for a step of dtMs, equivalent to `alpha` per refMs. */
export function alphaFor(alpha: number, dtMs: number, refMs: number): number {
  if (dtMs <= 0) return alpha
  return 1 - Math.pow(1 - alpha, dtMs / refMs)
}

export function ema(previous: number, next: number, alpha: number): number {
  return previous + alpha * (next - previous)
}

export function smoothBox(previous: BoundingBox, next: BoundingBox, alpha: number): BoundingBox {
  return {
    x: ema(previous.x, next.x, alpha),
    y: ema(previous.y, next.y, alpha),
    width: ema(previous.width, next.width, alpha),
    height: ema(previous.height, next.height, alpha),
  }
}
