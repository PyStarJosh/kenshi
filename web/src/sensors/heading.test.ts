import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import { cameraAttitude } from './attitude'
import { cameraForward, HeadingTracker, headingFromForward, pitchFromForward, wrap180, wrap360 } from './heading'

// ---- A test-only model of the phone, built from where its axes physically point, not from the code under test ----
// Earth axes: x east, y north, z up. A device has x (right edge), y (top edge) and z (out of the screen) axes.

type V = [number, number, number]
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const neg = (a: V): V => [-a[0], -a[1], -a[2]]

/** How the phone is held: the screen angle iOS reports for it. */
const HOLDS = [
  { name: 'portrait', screenAngle: 0 },
  { name: 'portrait upside down', screenAngle: 180 },
  { name: 'landscape, top to the left', screenAngle: 90 },
  { name: 'landscape, top to the right', screenAngle: 270 },
] as const
type Hold = (typeof HOLDS)[number]

/** The device axes in Earth coordinates for a camera facing `headingDeg` (compass) and `pitchDeg` above the horizon. */
function deviceAxes(headingDeg: number, pitchDeg: number, hold: Hold): { x: V; y: V; z: V } {
  const h = rad(headingDeg)
  const p = rad(pitchDeg)
  const forward: V = [Math.cos(p) * Math.sin(h), Math.cos(p) * Math.cos(h), Math.sin(p)]
  // Perpendicular to forward, in the vertical plane through it, pointing up: where the "top" of the picture points.
  const up: V = [-Math.sin(p) * Math.sin(h), -Math.sin(p) * Math.cos(h), Math.cos(p)]
  const z = neg(forward) // out of the screen, toward the user; the camera looks along -z
  switch (hold.screenAngle) {
    case 0: {
      const y = up
      return { x: cross(y, z), y, z }
    }
    case 180: {
      const y = neg(up)
      return { x: cross(y, z), y, z }
    }
    case 90: {
      const x = up // the right edge is up when the top is turned to the left
      return { x, y: cross(z, x), z }
    }
    default: {
      const x = neg(up)
      return { x, y: cross(z, x), z }
    }
  }
}

/** W3C alpha, beta, gamma (degrees) for the device axes, with gamma kept in [-90, 90] as iOS reports it. Needs cos(beta) != 0. */
function eulerFromAxes({ x, y, z }: { x: V; y: V; z: V }): { alpha: number; beta: number; gamma: number } {
  const r20 = x[2]
  const r21 = y[2]
  const r22 = z[2]
  const horizontal = Math.hypot(r20, r22) // = |cos(beta)|
  const sign = r22 >= 0 ? 1 : -1 // the sign of cos(beta), since cos(gamma) >= 0
  const beta = Math.atan2(r21, sign * horizontal)
  const gamma = sign === 1 ? Math.atan2(-r20, r22) : Math.atan2(r20, -r22)
  const alpha = Math.atan2(-y[0] * sign, y[1] * sign)
  return { alpha: deg(alpha), beta: deg(beta), gamma: deg(gamma) }
}

// Explicit 3x3 products, to prove the Euler helper above really inverts R = Rz(alpha) Rx(beta) Ry(gamma).
type M = number[][]
const mul = (a: M, b: M): M => a.map((row) => [0, 1, 2].map((c) => row[0] * b[0][c] + row[1] * b[1][c] + row[2] * b[2][c]))
const rz = (a: number): M => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]]
const rx = (a: number): M => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]]
const ry = (a: number): M => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]]
const rotation = (alpha: number, beta: number, gamma: number): M => mul(mul(rz(rad(alpha)), rx(rad(beta))), ry(rad(gamma)))

const MIN_HORIZONTAL = Math.cos(rad(CONFIG.orientation.headingMaxPitchDeg))
const angleBetween = (a: number, b: number) => Math.abs(wrap180(a - b))

const NORTH_EAST_SOUTH_WEST = [
  ['north', 0],
  ['east', 90],
  ['south', 180],
  ['west', 270],
] as const

describe('the test model itself', () => {
  test.each(HOLDS)('the Euler angles for $name rebuild the same device axes', (hold) => {
    for (const heading of [0, 37, 90, 200, 301]) {
      for (const pitch of [-40, -15, 20, 45]) {
        const axes = deviceAxes(heading, pitch, hold)
        const { alpha, beta, gamma } = eulerFromAxes(axes)
        expect(Math.abs(gamma)).toBeLessThanOrEqual(90 + 1e-9)
        const r = rotation(alpha, beta, gamma)
        for (const [column, axis] of [[0, axes.x], [1, axes.y], [2, axes.z]] as const) {
          for (let row = 0; row < 3; row++) expect(r[row][column]).toBeCloseTo(axis[row], 9)
        }
      }
    }
  })
})

describe('cameraForward', () => {
  test('is a unit vector and equals minus the device z axis of the rotation matrix', () => {
    for (const [alpha, beta, gamma] of [[0, 0, 0], [30, 70, -10], [200, -120, 45], [359, 100, 80]]) {
      const f = cameraForward(alpha, beta, gamma)
      expect(Math.hypot(f.x, f.y, f.z)).toBeCloseTo(1, 9)
      const r = rotation(alpha, beta, gamma)
      expect(f.x).toBeCloseTo(-r[0][2], 9)
      expect(f.y).toBeCloseTo(-r[1][2], 9)
      expect(f.z).toBeCloseTo(-r[2][2], 9)
    }
  })
})

describe('heading from deviceorientation angles', () => {
  test.each(HOLDS)('$name: facing north, east, south and west, level or tilted', (hold) => {
    // Portrait held exactly level has beta = 90, where alpha and gamma cannot be told apart; it is tested on its own below.
    const pitches = hold.screenAngle === 0 || hold.screenAngle === 180 ? [-30, -15, 20, 40] : [-30, -15, 0, 20, 40]
    for (const [, compass] of NORTH_EAST_SOUTH_WEST) {
      for (const pitch of pitches) {
        const { alpha, beta, gamma } = eulerFromAxes(deviceAxes(compass, pitch, hold))
        const heading = headingFromForward(cameraForward(alpha, beta, gamma), MIN_HORIZONTAL)
        expect(heading).not.toBeNull()
        expect(angleBetween(heading!, compass)).toBeLessThan(1e-6)
        expect(pitchFromForward(cameraForward(alpha, beta, gamma))).toBeCloseTo(pitch, 6)
      }
    }
  })

  test('portrait held exactly level: heading is minus (alpha + gamma), whatever the split', () => {
    // beta = 90: forward = (-sin(alpha + gamma), cos(alpha + gamma), 0).
    const cases: [number, number, number][] = [[0, 0, 0], [270, 0, 90], [180, 0, 180], [90, 0, 270], [100, 30, 230], [100, -30, 290]]
    for (const [alpha, gamma, expected] of cases) {
      const heading = headingFromForward(cameraForward(alpha, 90, gamma), MIN_HORIZONTAL)
      expect(angleBetween(heading!, expected)).toBeLessThan(1e-9)
    }
  })

  test('turning the phone to the right (alpha falls) raises the heading, in every hold', () => {
    for (const hold of HOLDS) {
      const before = eulerFromAxes(deviceAxes(100, -15, hold))
      const after = eulerFromAxes(deviceAxes(190, -15, hold))
      const a = headingFromForward(cameraForward(before.alpha, before.beta, before.gamma), MIN_HORIZONTAL)!
      const b = headingFromForward(cameraForward(after.alpha, after.beta, after.gamma), MIN_HORIZONTAL)!
      expect(wrap180(b - a)).toBeCloseTo(90, 6)
    }
  })

  test('tilting up and down while facing east does not move the heading', () => {
    for (const hold of HOLDS) {
      for (let pitch = -60; pitch <= 60; pitch += 5) {
        if (Math.abs(pitch) < 1e-9 && hold.screenAngle % 180 === 0) continue
        const { alpha, beta, gamma } = eulerFromAxes(deviceAxes(90, pitch, hold))
        const heading = headingFromForward(cameraForward(alpha, beta, gamma), MIN_HORIZONTAL)
        expect(angleBetween(heading!, 90)).toBeLessThan(1e-6)
      }
    }
  })

  test('has no heading when the camera looks almost straight up or down', () => {
    expect(headingFromForward(cameraForward(0, 0, 0), MIN_HORIZONTAL)).toBeNull() // flat on a table, camera down
    expect(headingFromForward(cameraForward(0, 180, 0), MIN_HORIZONTAL)).toBeNull() // flat, face down... camera up
    const steep = eulerFromAxes(deviceAxes(40, CONFIG.orientation.headingMaxPitchDeg + 3, HOLDS[2]))
    expect(headingFromForward(cameraForward(steep.alpha, steep.beta, steep.gamma), MIN_HORIZONTAL)).toBeNull()
    const ok = eulerFromAxes(deviceAxes(40, CONFIG.orientation.headingMaxPitchDeg - 3, HOLDS[2]))
    expect(headingFromForward(cameraForward(ok.alpha, ok.beta, ok.gamma), MIN_HORIZONTAL)).not.toBeNull()
  })

  test('pitch comes from the same vector as the existing attitude code', () => {
    for (const [beta, gamma, screen] of [[80, 0, 0], [100, 0, 0], [5, -80, 90], [-5, 80, 270], [0, -100, 90]]) {
      expect(cameraAttitude(beta, gamma, screen).pitchDeg).toBeCloseTo(pitchFromForward(cameraForward(123, beta, gamma)), 9)
    }
  })
})

describe('wrap360 and wrap180', () => {
  test('wrap360 gives [0, 360)', () => {
    expect(wrap360(0)).toBe(0)
    expect(wrap360(360)).toBe(0)
    expect(wrap360(-1)).toBe(359)
    expect(wrap360(725)).toBe(5)
  })

  test('wrap180 gives (-180, 180] with 180 kept positive', () => {
    expect(wrap180(180)).toBe(180)
    expect(wrap180(-180)).toBe(180)
    expect(wrap180(190)).toBe(-170)
    expect(wrap180(-190)).toBe(170)
    expect(wrap180(360)).toBe(0)
    expect(wrap180(10 - 350)).toBe(20)
  })
})

describe('HeadingTracker', () => {
  test('the first reading is returned as is', () => {
    expect(new HeadingTracker(0.4).update(123)).toBe(123)
  })

  test('crossing north keeps counting up instead of jumping', () => {
    const tracker = new HeadingTracker(1) // no smoothing, to see the unwrapping alone
    const seen = [350, 355, 359, 2, 6, 11].map((raw) => tracker.update(raw)!)
    expect(seen).toEqual([350, 355, 359, 362, 366, 371])
  })

  test('crossing north the other way counts down below zero', () => {
    const tracker = new HeadingTracker(1)
    expect([10, 3, 358, 350].map((raw) => tracker.update(raw)!)).toEqual([10, 3, -2, -10])
  })

  test('four full turns to the right add 1440 degrees', () => {
    const tracker = new HeadingTracker(1)
    let last = tracker.update(0)!
    for (let step = 1; step <= 4 * 36; step++) last = tracker.update(wrap360(step * 10))!
    expect(last).toBeCloseTo(1440, 9)
  })

  test('a 90 degree turn to the right moves the heading by +90, however the phone is held', () => {
    for (const hold of HOLDS) {
      const tracker = new HeadingTracker(CONFIG.orientation.headingSmoothing)
      let first: number | null = null
      let last: number | null = null
      for (let compass = 200; compass <= 290; compass += 3) {
        const { alpha, beta, gamma } = eulerFromAxes(deviceAxes(compass, -10, hold))
        last = tracker.update(headingFromForward(cameraForward(alpha, beta, gamma), MIN_HORIZONTAL))
        first ??= last
      }
      for (let i = 0; i < 40; i++) last = tracker.update(290) // let the smoothing settle
      expect(last! - first!).toBeCloseTo(90, 3)
    }
  })

  test('smoothing moves part of the way toward a new heading and settles on it', () => {
    const tracker = new HeadingTracker(0.4)
    tracker.update(100)
    expect(tracker.update(110)).toBeCloseTo(104, 9)
    let value = 0
    for (let i = 0; i < 40; i++) value = tracker.update(110)!
    expect(value).toBeCloseTo(110, 4)
  })

  test('a null reading (looking straight up or down) holds the last heading', () => {
    const tracker = new HeadingTracker(1)
    expect(tracker.update(null)).toBeNull()
    tracker.update(80)
    expect(tracker.update(null)).toBe(80)
    expect(tracker.update(85)).toBe(85)
  })

  test('reset forgets everything, so the next reading starts fresh', () => {
    const tracker = new HeadingTracker(0.4)
    tracker.update(10)
    tracker.update(300)
    tracker.reset()
    expect(tracker.update(200)).toBe(200)
  })
})
