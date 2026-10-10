// Field-of-view calibration math. The camera does not report its field of view, so the user measures it:
// from a known distance, how wide a stretch of wall fills the picture edge to edge.
import { CONFIG } from '../core/config'

/** Distance from the wall the calibration steps ask for, in meters. */
export const CALIBRATION_DISTANCE_M = 1

export type FovResult = { ok: true; fovDeg: number } | { ok: false; reason: string }

/**
 * The horizontal field of view in degrees for a wall width seen at a distance: 2 * atan(width / 2 / distance).
 * Rejects numbers that cannot be right, and results outside the range the app accepts.
 */
export function fovFromWall(widthM: number, distanceM: number): FovResult {
  if (!Number.isFinite(widthM) || !Number.isFinite(distanceM) || widthM <= 0 || distanceM <= 0) {
    return { ok: false, reason: 'Enter the width and the distance as numbers greater than zero.' }
  }
  const fovDeg = (2 * Math.atan(widthM / 2 / distanceM) * 180) / Math.PI
  const { minFovDeg, maxFovDeg } = CONFIG.geometry
  if (fovDeg < minFovDeg || fovDeg > maxFovDeg) {
    return {
      ok: false,
      reason: `That gives ${fovDeg.toFixed(0)} degrees. A phone camera is between ${minFovDeg} and ${maxFovDeg}, so check the measurement.`,
    }
  }
  return { ok: true, fovDeg }
}

/** The calibration steps, in the order they are shown and spoken. */
export const CALIBRATION_STEPS: readonly string[] = [
  `Stand ${CALIBRATION_DISTANCE_M} meter from a flat wall.`,
  'Hold the phone level and sideways at eye level, facing the wall, with the center line on the middle of the picture.',
  'Have a teammate mark the wall at the left edge and the right edge of the view.',
  'Measure the distance between the two marks in meters and enter it.',
]
