import { describe, expect, test } from 'vitest'
import type { GeometryResult } from '../../geometry/geometry'
import { clockText, geometryLabel } from './geometryLabel'

const base: GeometryResult = {
  clock: { position: 12, angleDeg: 0 },
  distanceM: 2.1,
  distanceRoundedM: 2,
  distanceSource: 'ground-plane',
  distanceGroundM: 2.1,
  distanceBoxM: null,
  elevation: 'body',
  bottomHeightM: 0,
  topHeightM: 1,
  lateralOffsetM: 0,
  inPath: false,
  touchesBottom: false,
  degraded: false,
}

describe('clockText', () => {
  test.each([
    [11, "11 o'clock"],
    [12, "12 o'clock"],
    [1, "1 o'clock"],
    ['far-left', 'far left'],
    ['far-right', 'far right'],
  ] as const)('%s reads %s', (position, expected) => {
    expect(clockText(position)).toBe(expected)
  })
})

describe('geometryLabel', () => {
  test('direction, rounded distance, and method', () => {
    expect(geometryLabel(base)).toBe("12 o'clock | 2.0 m ground")
  })

  test('adds the height label and the path flag', () => {
    expect(geometryLabel({ ...base, elevation: 'floor', inPath: true })).toBe("12 o'clock | 2.0 m ground | floor | IN PATH")
    expect(geometryLabel({ ...base, elevation: 'head' })).toBe("12 o'clock | 2.0 m ground | head height")
  })

  test('names the other methods', () => {
    expect(geometryLabel({ ...base, distanceSource: 'box-size' })).toContain('2.0 m box')
    expect(geometryLabel({ ...base, distanceSource: 'min-visible' })).toContain('2.0 m at most')
  })

  test('shows a question mark when there is no distance', () => {
    expect(geometryLabel({ ...base, distanceM: null, distanceRoundedM: null, distanceSource: null })).toBe(
      "12 o'clock | distance ?",
    )
  })
})
