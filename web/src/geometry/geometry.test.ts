import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import type { BoundingBox } from '../core/types'
import { cameraModel, locate, locateDetection, roundDistance } from './geometry'
import type { GeometryInput } from './geometry'

// Test camera: a square 1000 x 1000 frame with a 90 degree field of view, so the focal length is
// exactly 500 pixels and the tangent of half the field is 1. Eye height is 1.6 m unless stated.
const FRAME = { width: 1000, height: 1000 }
const FOV = 90
const EYE = 1.6
const BACKPACK = { typicalHeightM: 0.45, groundContact: true }
const LEVEL = { pitchDeg: 0, rollDeg: 0 }

function input(box: BoundingBox, overrides: Partial<GeometryInput> = {}): GeometryInput {
  return {
    box,
    classInfo: BACKPACK,
    frame: FRAME,
    tilt: LEVEL,
    eyeHeightM: EYE,
    horizontalFovDeg: FOV,
    ...overrides,
  }
}

/** A box given in pixels, normalized for the code under test. */
function pixelBox(left: number, top: number, right: number, bottom: number): BoundingBox {
  return {
    x: left / FRAME.width,
    y: top / FRAME.height,
    width: (right - left) / FRAME.width,
    height: (bottom - top) / FRAME.height,
  }
}

describe('hand-computed cases (level phone unless stated)', () => {
  test('a backpack straight ahead at 2 m', () => {
    // base: 1.6 m below the eye at 2 m -> tan = 0.8 -> 500 + 0.8 * 500 = 900 px
    // top: 0.45 m high -> (1.6 - 0.45) / 2 = 0.575 -> 787.5 px; 0.3 m wide -> 75 px
    const r = locate(input(pixelBox(462.5, 787.5, 537.5, 900)))
    expect(r.distanceGroundM).toBeCloseTo(2, 9)
    expect(r.distanceBoxM).toBeCloseTo(2, 9) // 0.45 * 500 / 112.5
    expect(r.distanceM).toBeCloseTo(2, 9)
    expect(r.distanceSource).toBe('ground-plane')
    expect(r.distanceRoundedM).toBe(2)
    expect(r.clock.position).toBe(12)
    expect(r.clock.angleDeg).toBeCloseTo(0, 6)
    expect(r.bottomHeightM).toBeCloseTo(0, 9)
    expect(r.topHeightM).toBeCloseTo(0.45, 9)
    expect(r.elevation).toBe('floor')
    expect(r.lateralOffsetM).toBeCloseTo(0, 9)
    expect(r.inPath).toBe(true)
    expect(r.degraded).toBe(false)
  })

  test('the same backpack 30 degrees to the right', () => {
    // u = tan(30 deg) = 0.57735 -> center at 500 + 288.675 = 788.675 px
    const center = 500 + 500 * Math.tan((30 * Math.PI) / 180)
    const r = locate(input(pixelBox(center - 37.5, 787.5, center + 37.5, 900)))
    expect(r.clock.angleDeg).toBeCloseTo(30, 6)
    expect(r.clock.position).toBe(1)
    expect(r.distanceM).toBeCloseTo(2, 9)
    expect(r.lateralOffsetM).toBeCloseTo(2 * Math.tan((30 * Math.PI) / 180), 9) // 1.1547 m
    expect(r.inPath).toBe(false) // beyond the 0.5 m half-width
  })

  test('the same backpack 30 degrees to the left is 11 o clock and negative offset', () => {
    const center = 500 - 500 * Math.tan((30 * Math.PI) / 180)
    const r = locate(input(pixelBox(center - 37.5, 787.5, center + 37.5, 900)))
    expect(r.clock.position).toBe(11)
    expect(r.clock.angleDeg).toBeCloseTo(-30, 6)
    expect(r.lateralOffsetM!).toBeLessThan(-1.1)
  })

  test('phone pitched 10 degrees down: ground distance still 2 m', () => {
    // Pitch -10 deg. Base ray: tan(below horizon) = 0.8 solves (v + 0.176327) / (1 - 0.176327 v) = 0.8,
    // so v = 0.546589 -> 773.29 px. Top (height 0.45 m): tan = 0.575 -> v = 0.361971 -> 680.99 px.
    const tilt = { pitchDeg: -10, rollDeg: 0 }
    const r = locate(input(pixelBox(462.5, 680.99, 537.5, 773.29), { tilt }))
    expect(r.distanceSource).toBe('ground-plane')
    expect(r.distanceM).toBeCloseTo(2, 2)
    expect(r.topHeightM).toBeCloseTo(0.45, 2)
    expect(r.elevation).toBe('floor')
  })

  test('ignoring the 10 degree pitch would give a different distance', () => {
    // Same box with no tilt reading: box size is used instead and lands near 2.44 m, not 2 m.
    const r = locate(input(pixelBox(462.5, 680.99, 537.5, 773.29), { tilt: null }))
    expect(r.degraded).toBe(true)
    expect(r.distanceSource).toBe('box-size')
    expect(r.distanceM).toBeCloseTo((0.45 * 500) / (773.29 - 680.99), 6)
    expect(Math.abs(r.distanceM! - 2)).toBeGreaterThan(0.3)
  })

  test('phone rolled 5 degrees: the base of an object 2 m ahead still reads 2 m', () => {
    // Roll 5 deg clockwise moves the base point to u = 1.6 sin5 / 2 = 0.069725, v = 1.6 cos5 / 2 = 0.796956,
    // i.e. pixel (534.86, 898.48). Turning back by 5 deg gives v = 0.8 and u = 0 exactly.
    const r = locate(input(pixelBox(529.86, 780, 539.86, 898.48), { tilt: { pitchDeg: 0, rollDeg: 5 } }))
    expect(r.distanceGroundM).toBeCloseTo(2, 3)
    expect(r.distanceSource).toBe('ground-plane')
  })

  test('without the roll correction the same box would read farther', () => {
    const box = pixelBox(529.86, 780, 539.86, 898.48)
    const corrected = locate(input(box, { tilt: { pitchDeg: 0, rollDeg: 5 } })).distanceGroundM!
    const uncorrected = locate(input(box, { tilt: LEVEL })).distanceGroundM!
    expect(corrected).toBeCloseTo(2, 3)
    // v = 0.796956 instead of 0.8: 1.6 / 0.796956 = 2.0077 m
    expect(uncorrected).toBeCloseTo(1.6 / 0.796956, 4)
  })

  test('a box touching the bottom edge cannot use the ground method', () => {
    // A person (1.7 m) 1 m ahead: top at (1.6 - 1.7) / 1 = -0.1 -> 450 px; the feet are below the frame.
    // The box is cut at 1000 px, so it is 550 px tall: box size = 1.7 * 500 / 550 = 1.5455 m.
    // The nearest floor in view is at 1.6 / 1.0 = 1.6 m, so the nearer value, 1.5455 m, is kept.
    const person = { typicalHeightM: 1.7, groundContact: true }
    const r = locate(input(pixelBox(400, 450, 600, 1000), { classInfo: person }))
    expect(r.touchesBottom).toBe(true)
    expect(r.distanceGroundM).toBeNull()
    expect(r.distanceSource).toBe('box-size')
    expect(r.distanceM).toBeCloseTo(1.5455, 3)
  })

  test('a cut-off object with no known height falls back to the nearest visible floor', () => {
    const stairs = { typicalHeightM: null, groundContact: true }
    const r = locate(input(pixelBox(400, 450, 600, 1000), { classInfo: stairs }))
    expect(r.distanceSource).toBe('min-visible')
    expect(r.distanceM).toBeCloseTo(1.6, 6) // 1.6 / tan(45 deg) at the bottom of the frame
  })

  test('a head-height sign 3 m ahead', () => {
    // Bottom at 1.3 m: (1.6 - 1.3) / 3 = 0.1 -> 550 px. Top at 1.9 m: (1.6 - 1.9) / 3 = -0.1 -> 450 px.
    // Not on the floor, so box size: 0.6 * 500 / 100 = 3 m.
    const sign = { typicalHeightM: 0.6, groundContact: false }
    const r = locate(input(pixelBox(475, 450, 525, 550), { classInfo: sign }))
    expect(r.distanceGroundM).toBeNull()
    expect(r.distanceSource).toBe('box-size')
    expect(r.distanceM).toBeCloseTo(3, 9)
    expect(r.bottomHeightM).toBeCloseTo(1.3, 9)
    expect(r.topHeightM).toBeCloseTo(1.9, 9)
    expect(r.elevation).toBe('head')
    expect(r.inPath).toBe(true)
  })

  test('something whose bottom edge is above head height gets no label', () => {
    // Bottom at 2.5 m, top at 3.1 m, 3 m ahead.
    const high = { typicalHeightM: 0.6, groundContact: false }
    const top = 500 + 500 * ((1.6 - 3.1) / 3)
    const bottom = 500 + 500 * ((1.6 - 2.5) / 3)
    const r = locate(input(pixelBox(475, top, 525, bottom), { classInfo: high }))
    expect(r.bottomHeightM).toBeCloseTo(2.5, 6)
    expect(r.elevation).toBe('body')
  })

  test('a person standing 3 m ahead has no height label', () => {
    // Feet at 1.6 / 3 -> 766.7 px, head at 1.7 m: (1.6 - 1.7) / 3 -> 483.3 px.
    const person = { typicalHeightM: 1.7, groundContact: true }
    const r = locate(input(pixelBox(450, 483.33, 550, 766.67), { classInfo: person }))
    expect(r.distanceM).toBeCloseTo(3, 2)
    expect(r.elevation).toBe('body')
  })
})

describe('clock positions', () => {
  // A small box low in the frame, centered at a given horizontal angle, not touching any edge.
  function atAngle(deg: number) {
    const center = 500 + 500 * Math.tan((deg * Math.PI) / 180)
    return locate(input(pixelBox(center - 10, 800, center + 10, 900)))
  }

  test.each([
    [0, 12],
    [14, 12],
    [-14, 12],
    [16, 1],
    [-16, 11],
    [40, 1],
    [-40, 11],
  ])('%i degrees reads as %s', (deg, expected) => {
    expect(atAngle(deg).clock.position).toBe(expected)
  })

  test('a box touching the left edge is far left', () => {
    expect(locate(input(pixelBox(0, 800, 100, 900))).clock.position).toBe('far-left')
  })

  test('a box touching the right edge is far right', () => {
    expect(locate(input(pixelBox(900, 800, 1000, 900))).clock.position).toBe('far-right')
  })

  test('a box just inside the edge margin is far, one just outside is not', () => {
    const margin = CONFIG.geometry.edgeTouchMargin * FRAME.width // 20 px
    expect(locate(input(pixelBox(margin, 800, margin + 100, 900))).clock.position).toBe('far-left')
    expect(locate(input(pixelBox(margin + 1, 800, margin + 101, 900))).clock.position).toBe(11)
  })

  test('a wide box touching both edges and centered is straight ahead', () => {
    expect(locate(input(pixelBox(0, 700, 1000, 900))).clock.position).toBe(12)
  })})

describe('when the distance method does not apply', () => {
  test('a floating object with its bottom above the horizon uses box size', () => {
    // Bottom at 450 px is above the horizon (500 px): no ground plane.
    const r = locate(input(pixelBox(450, 300, 550, 450)))
    expect(r.distanceGroundM).toBeNull()
    expect(r.distanceSource).toBe('box-size')
  })

  test('a base only 2 degrees below the horizon is too close to the horizon for the ground method', () => {
    const y = 500 + 500 * Math.tan((2 * Math.PI) / 180)
    const r = locate(input(pixelBox(450, 400, 550, y)))
    expect(r.distanceGroundM).toBeNull()
    expect(r.distanceSource).toBe('box-size')
  })

  test('a base 4 degrees below the horizon uses the ground method', () => {
    const y = 500 + 500 * Math.tan((4 * Math.PI) / 180) // D = 1.6 / tan(4 deg) = 22.9 m: beyond range
    const r = locate(input(pixelBox(450, 400, 550, y)))
    expect(r.distanceGroundM).toBeNull() // outside the 10 m limit
  })

  test('an object more than 10 m away has no distance and is not in the path', () => {
    const y = 500 + 500 * (EYE / 12)
    const r = locate(input(pixelBox(498, y - 10, 502, y), { classInfo: { typicalHeightM: null, groundContact: true } }))
    expect(r.distanceM).toBeNull()
    expect(r.distanceRoundedM).toBeNull()
    expect(r.inPath).toBe(false)
    expect(r.elevation).toBe('body')
    expect(r.lateralOffsetM).toBeNull()
  })

  test('without a tilt reading the camera is assumed level, geometry is degraded, and the clock still works', () => {
    const r = locate(input(pixelBox(462.5, 787.5, 537.5, 900), { tilt: null }))
    expect(r.degraded).toBe(true)
    expect(r.clock.position).toBe(12)
    expect(r.distanceM).toBeCloseTo(2, 6) // box size agrees here because the phone is level
  })

  test('degraded geometry falls back to the ground plane for a class with no known height', () => {
    const stairs = { typicalHeightM: null, groundContact: true }
    const r = locate(input(pixelBox(462.5, 787.5, 537.5, 900), { tilt: null, classInfo: stairs }))
    expect(r.degraded).toBe(true)
    expect(r.distanceSource).toBe('ground-plane')
    expect(r.distanceM).toBeCloseTo(2, 6)
  })
})

describe('walking path', () => {
  // Ground-method boxes at a given forward distance and sideways offset, level phone.
  function at(forward: number, lateral: number) {
    const base = 500 + (500 * EYE) / forward
    const top = 500 + (500 * (EYE - 0.45)) / forward
    const center = 500 + (500 * lateral) / forward
    const half = (500 * 0.15) / forward
    return locate(input(pixelBox(center - half, top, center + half, base)))
  }

  test.each([
    [3, 0.4, true],
    [3, -0.4, true],
    [3, 0.6, false],
    [3, -0.6, false],
    [3.9, 0, true],
    [4.5, 0, false],
  ])('%f m ahead and %f m to the side: in path is %s', (forward, lateral, expected) => {
    const r = at(forward, lateral)
    expect(r.distanceM).toBeCloseTo(forward, 6)
    expect(r.lateralOffsetM).toBeCloseTo(lateral, 6)
    expect(r.inPath).toBe(expected)
  })
})

describe('round trip against an independent 3D projection', () => {
  const cam = cameraModel(FRAME, FOV)

  /** Project a world point (forward, right, height above floor) through a camera with pitch and roll. */
  function project(forward: number, right: number, height: number, pitchDeg: number, rollDeg: number) {
    const p = (pitchDeg * Math.PI) / 180
    const rho = (rollDeg * Math.PI) / 180
    // Camera axes in (forward, right, up): forward tilted up by pitch; down perpendicular to it.
    const f = [Math.cos(p), 0, Math.sin(p)]
    const r0 = [0, 1, 0]
    const d0 = [Math.sin(p), 0, -Math.cos(p)]
    // A clockwise roll tips the right axis down.
    const r = r0.map((value, i) => value * Math.cos(rho) + d0[i] * Math.sin(rho))
    const d = d0.map((value, i) => -r0[i] * Math.sin(rho) + value * Math.cos(rho))
    const w = [forward, right, height - EYE]
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const depth = dot(w, f)
    return { x: cam.cx + (cam.focalPx * dot(w, r)) / depth, y: cam.cy + (cam.focalPx * dot(w, d)) / depth }
  }

  /** Bounding box of a 0.3 m wide, 0.45 m tall object standing on the floor. */
  function backpackBox(forward: number, lateral: number, pitch: number, roll: number): BoundingBox {
    const corners = [
      project(forward, lateral - 0.15, 0, pitch, roll),
      project(forward, lateral + 0.15, 0, pitch, roll),
      project(forward, lateral - 0.15, 0.45, pitch, roll),
      project(forward, lateral + 0.15, 0.45, pitch, roll),
    ]
    const xs = corners.map((c) => c.x)
    const ys = corners.map((c) => c.y)
    return pixelBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))
  }

  const cases: Array<[number, number, number, number]> = []
  for (const forward of [2, 3, 4])
    for (const lateral of [0, 0.8, -1.2])
      for (const pitch of [0, -10, -20, 5])
        for (const roll of [0, 5, -8]) cases.push([forward, lateral, pitch, roll])

  test('recovers the distance, bearing, and height for every visible case', () => {
    let checked = 0
    for (const [forward, lateral, pitch, roll] of cases) {
      const box = backpackBox(forward, lateral, pitch, roll)
      const inside = box.x > 0.03 && box.x + box.width < 0.97 && box.y > 0.03 && box.y + box.height < 0.96
      if (!inside) continue
      checked++
      const r = locate(input(box, { tilt: { pitchDeg: pitch, rollDeg: roll } }))
      const label = `forward ${forward}, lateral ${lateral}, pitch ${pitch}, roll ${roll}`
      expect(r.distanceSource, label).toBe('ground-plane')
      // An axis-aligned box around a rolled object reaches slightly below its base, so allow 2.5%.
      expect(Math.abs(r.distanceM! - forward) / forward, label).toBeLessThan(0.025)
      const bearing = (Math.atan(lateral / forward) * 180) / Math.PI
      expect(Math.abs(r.clock.angleDeg - bearing), label).toBeLessThan(0.7)
      expect(r.elevation, label).toBe('floor')
    }
    expect(checked).toBeGreaterThan(40)
  })
})

describe('locateDetection', () => {
  test('looks up the class and uses the settings', () => {
    const classes = [{ id: 0, label: 'backpack', spokenName: 'backpack', typicalHeightM: 0.45, groundContact: true, alertable: true }]
    const detection = { classId: 0, label: 'backpack', confidence: 0.9, box: pixelBox(462.5, 787.5, 537.5, 900) }
    const r = locateDetection(detection, classes, FRAME, LEVEL, { eyeHeightM: EYE, horizontalFovDeg: FOV })
    expect(r.distanceM).toBeCloseTo(2, 9)
  })

  test('an unknown class id still gets a ground-plane distance', () => {
    const detection = { classId: 999, label: '?', confidence: 0.9, box: pixelBox(462.5, 787.5, 537.5, 900) }
    const r = locateDetection(detection, [], FRAME, LEVEL, { eyeHeightM: EYE, horizontalFovDeg: FOV })
    expect(r.distanceSource).toBe('ground-plane')
  })

  test('a taller person (eye height 1.8) reads farther for the same base row', () => {
    const detection = { classId: 999, label: '?', confidence: 0.9, box: pixelBox(462.5, 787.5, 537.5, 900) }
    const r = locateDetection(detection, [], FRAME, LEVEL, { eyeHeightM: 1.8, horizontalFovDeg: FOV })
    expect(r.distanceM).toBeCloseTo(2.25, 9) // 1.8 / 0.8
  })
})

describe('roundDistance', () => {
  test.each([
    [1.74, 1.5],
    [1.76, 2],
    [0.2, 0.5],
    [0.74, 0.5],
    [0.76, 1],
    [2.25, 2.5],
    [3, 3],
    [3.9, 4],
  ])('%f rounds to %f', (input, expected) => {
    expect(roundDistance(input)).toBe(expected)
  })
})
