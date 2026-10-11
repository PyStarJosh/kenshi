import { describe, expect, test } from 'vitest'
import { pathOptionsFor, processSize, targetColumn, verticalFovRad } from './pathInput'

describe('processSize', () => {
  test('is processWidth wide with the aspect ratio kept', () => {
    expect(processSize(1280, 720, 320)).toEqual({ width: 320, height: 180 })
    expect(processSize(1920, 1080, 320)).toEqual({ width: 320, height: 180 })
    expect(processSize(720, 1280, 320)).toEqual({ width: 320, height: 569 })
  })

  test('never larger than the frame', () => {
    expect(processSize(200, 100, 320)).toEqual({ width: 200, height: 100 })
  })

  test('never smaller than the filters can use', () => {
    expect(processSize(1280, 4, 320).height).toBeGreaterThanOrEqual(3)
  })
})

describe('verticalFovRad', () => {
  test('follows from the horizontal one and the shape of the frame', () => {
    expect(verticalFovRad(65, 1280, 720)).toBeCloseTo(0.688, 2) // about 39.4 degrees
    expect(verticalFovRad(65, 100, 100)).toBeCloseTo((65 * Math.PI) / 180, 9) // a square frame: the same
  })
})

describe('targetColumn', () => {
  test('is 0.5 plus the bearing over the field of view', () => {
    expect(targetColumn(0, 65)).toBe(0.5)
    expect(targetColumn(16.25, 65)).toBeCloseTo(0.75, 9)
    expect(targetColumn(-16.25, 65)).toBeCloseTo(0.25, 9)
  })

  test('the edges of the picture are 0 and 1', () => {
    expect(targetColumn(32.5, 65)).toBeCloseTo(1, 9)
    expect(targetColumn(-32.5, 65)).toBeCloseTo(0, 9)
  })

  test('null when the target is out of view or unknown', () => {
    expect(targetColumn(40, 65)).toBeNull()
    expect(targetColumn(-90, 65)).toBeNull()
    expect(targetColumn(null, 65)).toBeNull()
    expect(targetColumn(Number.NaN, 65)).toBeNull()
    expect(targetColumn(10, 0)).toBeNull()
  })
})

describe('pathOptionsFor', () => {
  const input = { pitchDeg: 0, hfovDeg: 65, targetX: null }

  test('a level camera has the horizon at the middle of the picture', () => {
    expect(pathOptionsFor(input, 320, 180).horizonRow).toBeCloseTo(90, 9)
  })

  test('looking down moves the horizon up the picture, looking up moves it down', () => {
    const down = pathOptionsFor({ ...input, pitchDeg: -20 }, 320, 180).horizonRow as number
    const up = pathOptionsFor({ ...input, pitchDeg: 20 }, 320, 180).horizonRow as number
    expect(down).toBeLessThan(90)
    expect(up).toBeGreaterThan(90)
    expect(90 - down).toBeCloseTo(up - 90, 9) // the same distance either way for the same angle
  })

  test('20 degrees down on a 65 degree lens is about 91 rows above the middle at 180 rows', () => {
    // focal = 90 / tan(vfov / 2); the horizon moves focal * tan(20 degrees)
    const vfov = verticalFovRad(65, 320, 180)
    const expected = 90 - (90 / Math.tan(vfov / 2)) * Math.tan((20 * Math.PI) / 180)
    expect(pathOptionsFor({ ...input, pitchDeg: -20 }, 320, 180).horizonRow).toBeCloseTo(expected, 9)
  })

  test('with no tilt reading there is no horizon, so the fixed 40 percent start is used', () => {
    expect(pathOptionsFor({ ...input, pitchDeg: null }, 320, 180)).toEqual({})
    expect(pathOptionsFor({ ...input, pitchDeg: Number.NaN }, 320, 180).horizonRow).toBeUndefined()
  })

  test('the target column is passed on only when there is one', () => {
    expect(pathOptionsFor({ ...input, targetX: 0.7 }, 320, 180).targetX).toBe(0.7)
    expect(pathOptionsFor({ ...input, targetX: null }, 320, 180).targetX).toBeUndefined()
    expect(pathOptionsFor({ ...input, targetX: Number.NaN }, 320, 180).targetX).toBeUndefined()
  })
})
