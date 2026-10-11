import { describe, expect, test } from 'vitest'
import type { FreeSpaceResult } from '../../core/types'
import { drawPath, linePoints, LINE_COLOR, maskRect, maskToRgba } from './overlayDraw'
import type { OverlayContext } from './overlayDraw'

const path = (patch: Partial<FreeSpaceResult> = {}): FreeSpaceResult => ({
  points: [
    { x: 0.5, y: 0.75 },
    { x: 0.625, y: 0.5 },
    { x: 0.75, y: 0.25 },
  ],
  lookahead: { x: 0.625, y: 0.5 },
  decision: 'right',
  processWidth: 320,
  processHeight: 180,
  roiStartRow: 72,
  freeMask: new Uint8Array(320 * 108),
  ...patch,
})

describe('maskToRgba', () => {
  test('free floor is green at the given opacity, the rest is clear', () => {
    const rgba = maskToRgba(new Uint8Array([1, 0, 1]), 0.35)
    expect(Array.from(rgba)).toEqual([11, 122, 57, 89, 11, 122, 57, 0, 11, 122, 57, 89])
  })

  test('the opacity is held between 0 and 1', () => {
    expect(maskToRgba(new Uint8Array([1]), 3)[3]).toBe(255)
    expect(maskToRgba(new Uint8Array([1]), -1)[3]).toBe(0)
  })
})

describe('where things land: the same fractions of the picture as the detection boxes', () => {
  test('the mask covers the rows from the first analysed row down, over the full width', () => {
    expect(maskRect({ processHeight: 180, roiStartRow: 72 }, 200, 100)).toEqual({ x: 0, y: 40, width: 200, height: 60 })
    expect(maskRect({ processHeight: 180, roiStartRow: 0 }, 200, 100)).toEqual({ x: 0, y: 0, width: 200, height: 100 })
  })

  test('a point at x, y of the frame is at the same fraction of the canvas', () => {
    expect(linePoints([{ x: 0.5, y: 0.25 }, { x: 1, y: 1 }], 400, 200)).toEqual([
      { x: 200, y: 50 },
      { x: 400, y: 200 },
    ])
  })
})

function recorder() {
  const calls: string[] = []
  const ctx: OverlayContext = {
    clearRect: (...a) => calls.push(`clear ${a.join(' ')}`),
    drawImage: (_image, ...a) => calls.push(`image ${a.join(' ')}`),
    beginPath: () => calls.push('begin'),
    moveTo: (...a) => calls.push(`move ${a.join(' ')}`),
    lineTo: (...a) => calls.push(`line ${a.join(' ')}`),
    stroke: () => calls.push('stroke'),
    lineWidth: 0,
    strokeStyle: '',
    lineJoin: 'miter',
    lineCap: 'butt',
  }
  return { calls, ctx }
}

describe('drawPath', () => {
  const style = { opacity: 0.35, lineWidthPx: 4 }

  test('clears, tints the floor, then draws the line in yellow 4 pixels wide', () => {
    const { calls, ctx } = recorder()
    drawPath(ctx, 200, 100, path(), {}, style)
    expect(calls).toEqual(['clear 0 0 200 100', 'image 0 40 200 60', 'begin', 'move 100 75', 'line 125 50', 'line 150 25', 'stroke'])
    expect(ctx.lineWidth).toBe(4)
    expect(ctx.strokeStyle).toBe(LINE_COLOR)
    expect(LINE_COLOR).toBe('#ffeb3b')
  })

  test('with no path it only clears', () => {
    const { calls, ctx } = recorder()
    drawPath(ctx, 200, 100, null, {}, style)
    expect(calls).toEqual(['clear 0 0 200 100'])
  })

  test('with no mask image it draws the line alone', () => {
    const { calls, ctx } = recorder()
    drawPath(ctx, 200, 100, path(), null, style)
    expect(calls.some((c) => c.startsWith('image'))).toBe(false)
    expect(calls).toContain('stroke')
  })

  test('a single point is not a line', () => {
    const { calls, ctx } = recorder()
    drawPath(ctx, 200, 100, path({ points: [{ x: 0.5, y: 0.9 }] }), {}, style)
    expect(calls).not.toContain('stroke')
  })
})
