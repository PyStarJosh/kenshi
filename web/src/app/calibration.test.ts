import { describe, expect, test } from 'vitest'
import { CALIBRATION_STEPS, fovFromWall } from './calibration'
import type { FovResult } from './calibration'

function degrees(result: FovResult): number {
  if (!result.ok) throw new Error(`expected a field of view, got: ${result.reason}`)
  return result.fovDeg
}

describe('fovFromWall', () => {
  test('a wall as wide as it is far is 90 degrees', () => {
    expect(degrees(fovFromWall(2, 1))).toBeCloseTo(90, 9)
  })

  test('1.2 m wide at 1 m is 61.93 degrees (2 * atan 0.6)', () => {
    expect(degrees(fovFromWall(1.2, 1))).toBeCloseTo(61.9275, 3)
  })

  test('the distance matters: 2.4 m at 2 m is the same field of view as 1.2 m at 1 m', () => {
    expect(degrees(fovFromWall(2.4, 2))).toBeCloseTo(degrees(fovFromWall(1.2, 1)), 9)
  })

  test.each([
    [0, 1],
    [-1, 1],
    [1, 0],
    [Number.NaN, 1],
    [1, Number.POSITIVE_INFINITY],
  ])('rejects width %f at distance %f', (width, distance) => {
    expect(fovFromWall(width, distance).ok).toBe(false)
  })

  test('rejects a result outside the accepted range, with the number in the message', () => {
    const tooNarrow = fovFromWall(0.2, 1) // 11.4 degrees
    expect(tooNarrow.ok).toBe(false)
    if (!tooNarrow.ok) expect(tooNarrow.reason).toMatch(/11 degrees/)
    expect(fovFromWall(10, 1).ok).toBe(false) // 157 degrees
  })
})

describe('calibration steps', () => {
  test('there are written steps and each is a single sentence for speech', () => {
    expect(CALIBRATION_STEPS.length).toBeGreaterThanOrEqual(4)
    for (const step of CALIBRATION_STEPS) {
      expect(step.endsWith('.')).toBe(true)
      expect(step.match(/\./g)).toHaveLength(1)
    }
  })
})
