import { expect, test } from 'vitest'
import { cameraPitchDeg } from './pitch'

test('camera pitch is the same held upright in portrait or either landscape', () => {
  expect(cameraPitchDeg(90, 0)).toBeCloseTo(0)
  expect(cameraPitchDeg(0, 90)).toBeCloseTo(0)
  expect(cameraPitchDeg(0, -90)).toBeCloseTo(0)
})

test('flat on a table, the camera looks straight down', () => {
  expect(cameraPitchDeg(0, 0)).toBeCloseTo(-90)
})

test('tilting the top of a portrait phone back points the camera up', () => {
  expect(cameraPitchDeg(120, 0)).toBeCloseTo(30)
  expect(cameraPitchDeg(45, 0)).toBeCloseTo(-45)
})

test('landscape, lowered 40 degrees', () => {
  // Rotated to landscape (gamma -90 + 40 = -50): the camera axis drops 40 degrees below the horizon.
  expect(cameraPitchDeg(0, -50)).toBeCloseTo(-40)
})
