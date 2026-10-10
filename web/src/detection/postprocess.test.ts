import { describe, expect, test } from 'vitest'
import type { BoundingBox, Detection } from '../core/types'
import {
  computeLetterbox,
  decodeDetections,
  inputBoxToSource,
  iou,
  nms,
  sourceBoxToInput,
} from './postprocess'

function det(classId: number, confidence: number, box: BoundingBox): Detection {
  return { classId, label: `c${classId}`, confidence, box }
}

describe('computeLetterbox', () => {
  test('pads the short side of a wide frame equally top and bottom', () => {
    expect(computeLetterbox(1280, 720, 320)).toEqual({
      size: 320,
      drawWidth: 320,
      drawHeight: 180,
      padX: 0,
      padY: 70,
    })
  })

  test('a square frame needs no padding', () => {
    expect(computeLetterbox(500, 500, 416)).toEqual({
      size: 416,
      drawWidth: 416,
      drawHeight: 416,
      padX: 0,
      padY: 0,
    })
  })
})

describe('letterbox mapping', () => {
  const frames: [number, number, number][] = [
    [1280, 720, 320],
    [720, 1280, 416],
    [641, 479, 320],
  ]

  test.each(frames)('round trip is exact for a %i x %i frame at size %i', (w, h, size) => {
    const lb = computeLetterbox(w, h, size)
    const source: BoundingBox = { x: 0.2, y: 0.3, width: 0.4, height: 0.5 }
    const input = sourceBoxToInput(source, lb)
    const back = inputBoxToSource(input.x, input.y, input.width, input.height, lb)
    expect(back.x).toBeCloseTo(source.x, 12)
    expect(back.y).toBeCloseTo(source.y, 12)
    expect(back.width).toBeCloseTo(source.width, 12)
    expect(back.height).toBeCloseTo(source.height, 12)
  })

  test('boxes that extend into the padding are clamped to the frame', () => {
    const lb = computeLetterbox(1280, 720, 320)
    const box = inputBoxToSource(-10, 0, 400, 320, lb)
    expect(box).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})

describe('decodeDetections', () => {
  // 3 anchors, 3 classes. Channel-major: cx, cy, w, h, then one row per class.
  const numAnchors = 3
  const numClasses = 3
  const labels = ['a', 'b', 'c']
  const thresholds = [0.5, 0.5, 0.6]
  const lb = computeLetterbox(320, 320, 320)

  function output(rows: number[][]): Float32Array {
    return Float32Array.from(rows.flat())
  }

  test('keeps boxes above their class threshold and maps them to the frame', () => {
    const out = output([
      [160, 40, 100], // cx
      [160, 40, 100], // cy
      [80, 20, 20], // w
      [80, 20, 20], // h
      [0.1, 0.2, 0.1], // class a
      [0.9, 0.3, 0.1], // class b
      [0.1, 0.1, 0.55], // class c, below its 0.6 threshold
    ])
    const found = decodeDetections(out, numAnchors, numClasses, thresholds, labels, lb)
    expect(found).toHaveLength(1)
    expect(found[0].classId).toBe(1)
    expect(found[0].label).toBe('b')
    expect(found[0].confidence).toBeCloseTo(0.9, 6)
    expect(found[0].box.x).toBeCloseTo(0.375, 6)
    expect(found[0].box.y).toBeCloseTo(0.375, 6)
    expect(found[0].box.width).toBeCloseTo(0.25, 6)
    expect(found[0].box.height).toBeCloseTo(0.25, 6)
  })

  test('a score exactly at the threshold is kept', () => {
    const out = output([[160], [160], [80], [80], [0.5], [0.1], [0.1]])
    expect(decodeDetections(out, 1, numClasses, thresholds, labels, lb)).toHaveLength(1)
  })

  test('maps boxes through the letterbox padding of a wide frame', () => {
    const wide = computeLetterbox(1280, 720, 320) // 320 x 180, padY 70
    // Box centered in the picture area: input center (160, 160), 160 wide and 90 tall.
    const out = output([[160], [160], [160], [90], [0.9], [0.1], [0.1]])
    const [d] = decodeDetections(out, 1, numClasses, thresholds, labels, wide)
    expect(d.box.x).toBeCloseTo(0.25, 6)
    expect(d.box.y).toBeCloseTo(0.25, 6)
    expect(d.box.width).toBeCloseTo(0.5, 6)
    expect(d.box.height).toBeCloseTo(0.5, 6)
  })

  test('drops boxes that lie entirely in the padding', () => {
    const wide = computeLetterbox(1280, 720, 320)
    const out = output([[160], [20], [40], [20], [0.9], [0.1], [0.1]])
    expect(decodeDetections(out, 1, numClasses, thresholds, labels, wide)).toHaveLength(0)
  })
})

describe('iou', () => {
  const a: BoundingBox = { x: 0, y: 0, width: 0.5, height: 0.5 }

  test('identical boxes give 1', () => {
    expect(iou(a, a)).toBeCloseTo(1, 12)
  })

  test('disjoint boxes give 0', () => {
    expect(iou(a, { x: 0.6, y: 0.6, width: 0.2, height: 0.2 })).toBe(0)
  })

  test('half-overlapping boxes give 1/3', () => {
    expect(iou(a, { x: 0.25, y: 0, width: 0.5, height: 0.5 })).toBeCloseTo(1 / 3, 12)
  })
})

describe('nms', () => {
  const box: BoundingBox = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }
  const nearby: BoundingBox = { x: 0.12, y: 0.12, width: 0.4, height: 0.4 }

  test('suppresses the lower-confidence of two overlapping same-class boxes', () => {
    const kept = nms([det(0, 0.6, nearby), det(0, 0.9, box)], 0.45)
    expect(kept).toHaveLength(1)
    expect(kept[0].confidence).toBe(0.9)
  })

  test('keeps overlapping boxes of different classes', () => {
    const kept = nms([det(0, 0.9, box), det(1, 0.8, nearby)], 0.45)
    expect(kept.map((d) => d.classId)).toEqual([0, 1])
  })

  test('keeps same-class boxes that do not overlap enough', () => {
    const far: BoundingBox = { x: 0.6, y: 0.6, width: 0.3, height: 0.3 }
    expect(nms([det(0, 0.9, box), det(0, 0.8, far)], 0.45)).toHaveLength(2)
  })

  test('returns boxes ordered by confidence and does not modify its input', () => {
    const input = [det(0, 0.5, box), det(1, 0.9, far())]
    const copy = [...input]
    expect(nms(input, 0.45).map((d) => d.confidence)).toEqual([0.9, 0.5])
    expect(input).toEqual(copy)
  })

  function far(): BoundingBox {
    return { x: 0.7, y: 0.7, width: 0.2, height: 0.2 }
  }
})
