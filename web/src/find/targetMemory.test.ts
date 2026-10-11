import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import { roundDistance } from '../geometry/geometry'
import { ageMs, bearing, boxCenterX, estimateTargetDistance, inView, isStale, observe, remember } from './targetMemory'

const HFOV = 65

describe('observe', () => {
  test('a box in the middle of the frame is where the camera points', () => {
    expect(observe(120, 0.5, HFOV)).toBe(120)
  })

  test('a box at the right or left edge is half a field of view away', () => {
    expect(observe(120, 1, HFOV)).toBeCloseTo(152.5, 9)
    expect(observe(120, 0, HFOV)).toBeCloseTo(87.5, 9)
  })

  test('a box a quarter of the way across is a quarter of the field of view to the right', () => {
    expect(observe(0, 0.75, HFOV)).toBeCloseTo(16.25, 9)
  })

  test('works with unwrapped headings, below zero or above 360', () => {
    expect(observe(-30, 0.25, HFOV)).toBeCloseTo(-46.25, 9)
    expect(observe(725, 0.5, HFOV)).toBe(725)
  })

  test('stays within 1.5 degrees of the exact pinhole direction for a 65 degree field of view', () => {
    const half = Math.tan((HFOV / 2) * (Math.PI / 180))
    for (let x = 0; x <= 1; x += 0.05) {
      const exact = (Math.atan((2 * x - 1) * half) * 180) / Math.PI
      expect(Math.abs(observe(0, x, HFOV) - exact)).toBeLessThan(1.5)
    }
  })

  test('boxCenterX is the middle of the box', () => {
    expect(boxCenterX({ x0: 0.2, y0: 0, x1: 0.6, y1: 1 })).toBeCloseTo(0.4, 9)
  })
})

describe('bearing', () => {
  const at = (heading: number) => ({ heading })

  test('positive means turn right, negative means turn left', () => {
    expect(bearing(at(130), 100)).toBe(30)
    expect(bearing(at(70), 100)).toBe(-30)
  })

  test('is zero when facing the target', () => {
    expect(bearing(at(100), 100)).toBe(0)
  })

  test('takes the short way around north', () => {
    expect(bearing(at(10), 350)).toBe(20)
    expect(bearing(at(350), 10)).toBe(-20)
    expect(bearing(at(370), 10)).toBe(0) // unwrapped headings a turn apart are the same direction
    expect(bearing(at(-10), 725)).toBe(-15) // -10 is 350 and 725 is 5
  })

  test('exactly behind is +180, never -180', () => {
    expect(bearing(at(280), 100)).toBe(180)
    expect(bearing(at(-80), 100)).toBe(180)
  })

  test('always lands in (-180, 180]', () => {
    for (let target = -720; target <= 720; target += 37) {
      for (let current = -400; current <= 400; current += 53) {
        const b = bearing(at(target), current)
        expect(b).toBeGreaterThan(-180)
        expect(b).toBeLessThanOrEqual(180)
      }
    }
  })
})

describe('inView', () => {
  test('inside the field of view, the edges included', () => {
    expect(inView(0, HFOV)).toBe(true)
    expect(inView(32.5, HFOV)).toBe(true)
    expect(inView(-32.5, HFOV)).toBe(true)
  })

  test('outside it', () => {
    expect(inView(32.6, HFOV)).toBe(false)
    expect(inView(-32.6, HFOV)).toBe(false)
    expect(inView(180, HFOV)).toBe(false)
  })
})

describe('staleness', () => {
  const memory = { seenAt: 1000 }

  test('age counts from when it was seen and never goes negative', () => {
    expect(ageMs(memory, 4000)).toBe(3000)
    expect(ageMs(memory, 500)).toBe(0)
  })

  test('is stale only after the limit, and the default is the configured one', () => {
    expect(isStale(memory, 1000 + 5000, 5000)).toBe(false)
    expect(isStale(memory, 1000 + 5001, 5000)).toBe(true)
    expect(isStale(memory, 1000 + CONFIG.find.memoryMaxAgeMs)).toBe(false)
    expect(isStale(memory, 1001 + CONFIG.find.memoryMaxAgeMs)).toBe(true)
  })
})

describe('estimateTargetDistance', () => {
  const frame = { width: 1280, height: 720 }
  const focalPx = 640 / Math.tan((HFOV / 2) * (Math.PI / 180))
  const eye = 1.6
  const base = {
    box: { x0: 0.4, y0: 0.5, x1: 0.6, y1: 0.8 },
    frame,
    onFloor: true,
    geminiDistanceM: 3.2,
    pitchDeg: 0 as number | null,
    eyeHeightM: eye,
    horizontalFovDeg: HFOV,
  }

  test('on the floor, level: the ground plane from the box bottom row, rounded to 0.5 m', () => {
    // The bottom row is 0.8 * 720 - 360 = 216 px below the middle; tan(angle below the horizon) = 216 / focal.
    const exact = eye / (216 / focalPx)
    expect(exact).toBeCloseTo(7.44, 1)
    expect(estimateTargetDistance(base)).toEqual({ distanceM: 7.5, source: 'ground-plane' })
  })

  test('on the floor with the camera pitched: uses the pitch at capture', () => {
    // 10 degrees down: tan(below horizon) = (v cos p - sin p) / (cos p + v sin p) with p = -10 degrees and v = 216 / focal.
    const p = (-10 * Math.PI) / 180
    const v = 216 / focalPx
    const tanBelow = (v * Math.cos(p) - Math.sin(p)) / (Math.cos(p) + v * Math.sin(p))
    const expected = roundDistance(eye / tanBelow)
    expect(expected).toBeLessThan(7.5) // looking down puts the same pixels farther below the horizon, so nearer
    expect(estimateTargetDistance({ ...base, pitchDeg: -10 })).toEqual({ distanceM: expected, source: 'ground-plane' })
  })

  test('not on the floor: Gemini\'s guess, rounded to 0.5 m', () => {
    expect(estimateTargetDistance({ ...base, onFloor: false, geminiDistanceM: 3.2 })).toEqual({ distanceM: 3, source: 'gemini' })
    expect(estimateTargetDistance({ ...base, onFloor: false, geminiDistanceM: 3.3 })).toEqual({ distanceM: 3.5, source: 'gemini' })
  })

  test('on the floor but the box is cut off at the bottom: Gemini\'s guess', () => {
    const cutOff = { ...base, box: { x0: 0.4, y0: 0.5, x1: 0.6, y1: 1 } }
    expect(estimateTargetDistance(cutOff)).toEqual({ distanceM: 3, source: 'gemini' })
  })

  test('no usable guess from Gemini: the box-size method, if a typical height is known', () => {
    // 0.9 m tall target, box 0.3 of the frame height = 216 px: distance = 0.9 * focal / 216.
    const expected = roundDistance((0.9 * focalPx) / 216)
    const input = { ...base, onFloor: false, geminiDistanceM: null, typicalHeightM: 0.9 }
    expect(estimateTargetDistance(input)).toEqual({ distanceM: expected, source: 'box-size' })
    for (const bad of [0, -2, 500, Number.NaN]) {
      expect(estimateTargetDistance({ ...input, geminiDistanceM: bad }).source).toBe('box-size')
    }
  })

  test('nothing to go on: null', () => {
    expect(estimateTargetDistance({ ...base, onFloor: false, geminiDistanceM: null })).toEqual({ distanceM: null, source: null })
  })

  test('without a tilt reading it does not claim the ground plane', () => {
    const result = estimateTargetDistance({ ...base, pitchDeg: null })
    expect(result.source).not.toBeNull()
  })

  test('never rounds below 0.5 m', () => {
    expect(estimateTargetDistance({ ...base, onFloor: false, geminiDistanceM: 0.31 }).distanceM).toBe(0.5)
  })
})

describe('remember', () => {
  test('stores the target heading from the box, with its label, distance, time and source', () => {
    const memory = remember({
      label: 'chair',
      frameHeading: 200,
      box: { x0: 0.6, y0: 0.2, x1: 0.8, y1: 0.9 },
      hfovDeg: HFOV,
      distanceM: 3,
      nowMs: 5000,
      source: 'gemini',
    })
    expect(memory).toEqual({ label: 'chair', heading: 200 + 0.2 * HFOV, distanceM: 3, seenAt: 5000, source: 'gemini' })
    expect(bearing(memory, 200)).toBeCloseTo(13, 9)
  })
})
