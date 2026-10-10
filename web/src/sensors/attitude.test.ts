import { describe, expect, test } from 'vitest'
import { cameraAttitude, normalizeScreenAngle, smoothAngle } from './attitude'

describe('cameraAttitude', () => {
  test('held sideways with the camera level reads zero pitch and zero roll', () => {
    // Landscape, screen angle 90: the device x axis points up, so gamma is -90 and beta is 0.
    const a = cameraAttitude(0, -90, 90)
    expect(a.pitchDeg).toBeCloseTo(0, 9)
    expect(a.rollDeg).toBeCloseTo(0, 9)
  })

  test('held sideways the other way (screen angle 270) is also level at gamma +90', () => {
    const a = cameraAttitude(0, 90, 270)
    expect(a.pitchDeg).toBeCloseTo(0, 9)
    expect(a.rollDeg).toBeCloseTo(0, 9)
  })

  test('held upright with the camera level reads zero', () => {
    const a = cameraAttitude(90, 0, 0)
    expect(a.pitchDeg).toBeCloseTo(0, 9)
    expect(a.rollDeg).toBeCloseTo(0, 9)
  })

  test('upright, beta 80 means the camera looks 10 degrees down', () => {
    // up part of z = cos(80) = 0.17365; pitch = asin(-0.17365) = -10 degrees
    const a = cameraAttitude(80, 0, 0)
    expect(a.pitchDeg).toBeCloseTo(-10, 6)
    expect(a.rollDeg).toBeCloseTo(0, 6)
  })

  test('upright, beta 100 means the camera looks 10 degrees up', () => {
    expect(cameraAttitude(100, 0, 0).pitchDeg).toBeCloseTo(10, 6)
  })

  test('sideways, gamma -80 means the camera looks 10 degrees down', () => {
    // up part of z = cos(0) * cos(-80) = 0.17365
    expect(cameraAttitude(0, -80, 90).pitchDeg).toBeCloseTo(-10, 6)
  })

  test('sideways, gamma -100 means the camera looks 10 degrees up', () => {
    expect(cameraAttitude(0, -100, 90).pitchDeg).toBeCloseTo(10, 6)
  })

  test('sideways, beta 5 is a roll of 5 degrees with no pitch', () => {
    // imageUp = x up = -cos(5)*sin(-90) = cos(5); imageRight = -y up = -sin(5); roll = atan2(sin 5, cos 5)
    const a = cameraAttitude(5, -90, 90)
    expect(a.rollDeg).toBeCloseTo(5, 6)
    expect(a.pitchDeg).toBeCloseTo(0, 6)
  })

  test('sideways, beta -5 rolls the other way', () => {
    expect(cameraAttitude(-5, -90, 90).rollDeg).toBeCloseTo(-5, 6)
  })

  test('pitch and roll together stay independent in landscape', () => {
    const a = cameraAttitude(5, -80, 90)
    // z up = cos(5) * cos(-80) = 0.17298 -> pitch = -9.96 degrees
    expect(a.pitchDeg).toBeCloseTo(-Math.asin(Math.cos((5 * Math.PI) / 180) * Math.cos((80 * Math.PI) / 180)) * (180 / Math.PI), 6)
    expect(a.rollDeg).toBeGreaterThan(4)
    expect(a.rollDeg).toBeLessThan(6)
  })

  test('upside-down screen angle 180 flips the picture, not the pitch', () => {
    const upright = cameraAttitude(80, 0, 0)
    const flipped = cameraAttitude(80, 0, 180)
    expect(flipped.pitchDeg).toBeCloseTo(upright.pitchDeg, 9)
  })

  test('never returns NaN at the extremes', () => {
    for (const [b, g, s] of [[180, 0, 0], [-180, 90, 90], [0, 0, 0], [90, 90, 270]]) {
      const a = cameraAttitude(b, g, s)
      expect(Number.isFinite(a.pitchDeg)).toBe(true)
      expect(Number.isFinite(a.rollDeg)).toBe(true)
    }
  })
})

describe('normalizeScreenAngle', () => {
  test.each([
    [0, 0],
    [90, 90],
    [180, 180],
    [270, 270],
    [-90, 270],
    [360, 0],
    [89, 90],
    [-1, 0],
    [450, 90],
  ])('%i becomes %i', (input, expected) => {
    expect(normalizeScreenAngle(input)).toBe(expected)
  })
})

describe('smoothAngle', () => {
  test('moves part of the way toward the new reading', () => {
    expect(smoothAngle(0, 10, 0.25)).toBeCloseTo(2.5, 9)
  })

  test('alpha 1 jumps straight to the new reading', () => {
    expect(smoothAngle(10, -20, 1)).toBeCloseTo(-20, 9)
  })

  test('goes the short way across the 180 degree wrap', () => {
    const next = smoothAngle(170, -170, 0.5)
    expect(Math.abs(next)).toBeCloseTo(180, 9)
  })
})
