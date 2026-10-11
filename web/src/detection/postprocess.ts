// Pure functions that turn raw model output into Detections. No browser APIs, so they are unit-tested.
import type { BoundingBox, Detection } from '../core/types'

/**
 * How a source frame was fitted into the square model input: scaled to
 * drawWidth x drawHeight and centered, with the rest padded.
 * All values are in input pixels.
 */
export interface Letterbox {
  size: number
  drawWidth: number
  drawHeight: number
  padX: number
  padY: number
}

export function computeLetterbox(srcWidth: number, srcHeight: number, size: number): Letterbox {
  const scale = Math.min(size / srcWidth, size / srcHeight)
  const drawWidth = Math.max(1, Math.round(srcWidth * scale))
  const drawHeight = Math.max(1, Math.round(srcHeight * scale))
  return {
    size,
    drawWidth,
    drawHeight,
    padX: Math.floor((size - drawWidth) / 2),
    padY: Math.floor((size - drawHeight) / 2),
  }
}

/** Input-pixel box (x, y of the top-left corner) to a normalized source-frame box, clamped to the frame. */
export function inputBoxToSource(
  x: number,
  y: number,
  width: number,
  height: number,
  lb: Letterbox,
): BoundingBox {
  const left = clamp01((x - lb.padX) / lb.drawWidth)
  const top = clamp01((y - lb.padY) / lb.drawHeight)
  const right = clamp01((x + width - lb.padX) / lb.drawWidth)
  const bottom = clamp01((y + height - lb.padY) / lb.drawHeight)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Inverse of inputBoxToSource for boxes inside the frame (used by tests). */
export function sourceBoxToInput(box: BoundingBox, lb: Letterbox): BoundingBox {
  return {
    x: lb.padX + box.x * lb.drawWidth,
    y: lb.padY + box.y * lb.drawHeight,
    width: box.width * lb.drawWidth,
    height: box.height * lb.drawHeight,
  }
}

/**
 * Decode a channel-major output of shape [4 + numClasses, numAnchors]:
 * rows 0..3 are center x, center y, width, height in input pixels, followed by one
 * score per class (already between 0 and 1). Each anchor keeps only its best class,
 * and only if that score reaches the class threshold. Boxes are mapped back to
 * normalized source-frame coordinates.
 */
export function decodeDetections(
  output: ArrayLike<number>,
  numAnchors: number,
  numClasses: number,
  thresholds: ArrayLike<number>,
  labels: ArrayLike<string>,
  lb: Letterbox,
): Detection[] {
  const detections: Detection[] = []
  for (let i = 0; i < numAnchors; i++) {
    let bestClass = 0
    let bestScore = -Infinity
    for (let c = 0; c < numClasses; c++) {
      const score = output[(4 + c) * numAnchors + i]
      if (score > bestScore) {
        bestScore = score
        bestClass = c
      }
    }
    if (bestScore < thresholds[bestClass]) continue
    const w = output[2 * numAnchors + i]
    const h = output[3 * numAnchors + i]
    const x = output[i] - w / 2
    const y = output[numAnchors + i] - h / 2
    const box = inputBoxToSource(x, y, w, h, lb)
    if (box.width <= 0 || box.height <= 0) continue
    detections.push({ classId: bestClass, label: labels[bestClass], confidence: bestScore, box })
  }
  return detections
}

export function iou(a: BoundingBox, b: BoundingBox): number {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const inter = Math.max(0, right - left) * Math.max(0, bottom - top)
  const union = a.width * a.height + b.width * b.height - inter
  return union > 0 ? inter / union : 0
}

/** Class-aware non-max suppression: a box is dropped only by a higher-confidence box of the same class. */
export function nms(detections: Detection[], iouThreshold: number): Detection[] {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence)
  const kept: Detection[] = []
  for (const d of sorted) {
    const suppressed = kept.some((k) => k.classId === d.classId && iou(k.box, d.box) > iouThreshold)
    if (!suppressed) kept.push(d)
  }
  return kept
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
