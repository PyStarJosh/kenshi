// Pure part of preprocessing: RGBA pixels of the letterboxed canvas to a normalized CHW float tensor.
import type { Letterbox } from './postprocess'

/**
 * Fill `out` (length 3 * size * size) with RGB values in 0..1, planar (all R, then G, then B).
 * Returns the mean brightness (0..1) of the picture area only, excluding the letterbox padding.
 */
export function rgbaToTensor(rgba: Uint8ClampedArray, lb: Letterbox, out: Float32Array): number {
  const plane = lb.size * lb.size
  const x0 = lb.padX
  const x1 = lb.padX + lb.drawWidth
  const y0 = lb.padY
  const y1 = lb.padY + lb.drawHeight
  let lumaSum = 0
  for (let p = 0, y = 0; y < lb.size; y++) {
    for (let x = 0; x < lb.size; x++, p++) {
      const r = rgba[p * 4] / 255
      const g = rgba[p * 4 + 1] / 255
      const b = rgba[p * 4 + 2] / 255
      out[p] = r
      out[plane + p] = g
      out[2 * plane + p] = b
      if (x >= x0 && x < x1 && y >= y0 && y < y1) lumaSum += 0.299 * r + 0.587 * g + 0.114 * b
    }
  }
  return lumaSum / (lb.drawWidth * lb.drawHeight)
}
