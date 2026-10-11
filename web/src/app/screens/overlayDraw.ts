// Drawing the free-space path over the camera picture (R7, FR-28): the free floor tinted green and the line in yellow. The
// overlay canvas covers the picture exactly (as the detection boxes do), so a point at x, y from 0 to 1 is drawn at the same
// fraction of the canvas, with no other mapping.
import type { FreeSpaceResult } from '../../core/types'

/** Free floor green (the Find screen's green), and the line's yellow. */
const FLOOR_RGB = [11, 122, 57] as const
export const LINE_COLOR = '#ffeb3b'

/** RGBA pixels for a mask: the free floor in green at this opacity, the rest clear. */
export function maskToRgba(
  mask: Uint8Array,
  opacity: number,
  out: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(mask.length * 4),
): Uint8ClampedArray<ArrayBuffer> {
  const alpha = Math.round(Math.min(Math.max(opacity, 0), 1) * 255)
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    const free = mask[i] !== 0
    out[j] = FLOOR_RGB[0]
    out[j + 1] = FLOOR_RGB[1]
    out[j + 2] = FLOOR_RGB[2]
    out[j + 3] = free ? alpha : 0
  }
  return out
}

/** Where the mask lands on a canvas of this size: the rows below the first analysed row, over the full width. */
export function maskRect(path: Pick<FreeSpaceResult, 'processHeight' | 'roiStartRow'>, canvasWidth: number, canvasHeight: number) {
  const top = (path.roiStartRow / path.processHeight) * canvasHeight
  return { x: 0, y: top, width: canvasWidth, height: canvasHeight - top }
}

/** The line as canvas pixels, bottom to top. */
export function linePoints(points: readonly { x: number; y: number }[], canvasWidth: number, canvasHeight: number) {
  return points.map((p) => ({ x: p.x * canvasWidth, y: p.y * canvasHeight }))
}

export interface OverlayStyle {
  opacity: number
  lineWidthPx: number
}

/** The pieces of a canvas the drawing needs, so it can be tested with a recording stand-in. */
export interface OverlayContext {
  clearRect(x: number, y: number, w: number, h: number): void
  drawImage(image: never, dx: number, dy: number, dw: number, dh: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  lineWidth: number
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineJoin: CanvasLineJoin
  lineCap: CanvasLineCap
}

/**
 * Clear the canvas, then draw the path: the mask (already painted on `maskImage`, a small canvas the size of the mask) and
 * the line. With no path, it only clears.
 */
export function drawPath(
  ctx: OverlayContext,
  canvasWidth: number,
  canvasHeight: number,
  path: FreeSpaceResult | null,
  maskImage: unknown,
  style: OverlayStyle,
): void {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)
  if (path === null) return
  if (maskImage !== null) {
    const rect = maskRect(path, canvasWidth, canvasHeight)
    ctx.drawImage(maskImage as never, rect.x, rect.y, rect.width, rect.height)
  }
  const line = linePoints(path.points, canvasWidth, canvasHeight)
  if (line.length < 2) return
  ctx.beginPath()
  ctx.moveTo(line[0].x, line[0].y)
  for (let i = 1; i < line.length; i++) ctx.lineTo(line[i].x, line[i].y)
  ctx.lineWidth = style.lineWidthPx
  ctx.strokeStyle = LINE_COLOR
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()
}
