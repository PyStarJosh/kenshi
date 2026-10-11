// Pure math: turn DeviceOrientation angles into the rear camera's pitch and roll for the way the
// screen is currently turned. No browser APIs, so it is unit-tested.
//
// The W3C convention rotates the device by alpha (about vertical), then beta (about the device's
// x axis), then gamma (about its y axis). Only the vertical (up) part of each device axis matters
// for pitch and roll, and alpha does not affect it:
//   up part of the device x axis (right edge):  -cos(beta) * sin(gamma)
//   up part of the device y axis (top edge):     sin(beta)
// Pitch is the camera's forward vector (the device -z axis) taken from heading.ts, the same vector the
// heading comes from, so the two share one source of truth.
//
// Held sideways (landscape) the angles are well behaved. Held upright (portrait) with the camera
// level, beta is near 90 degrees where the Euler angles are ill-conditioned, so roll is noisy there.

import { cameraForward, pitchFromForward } from './heading'

export interface Attitude {
  /** Camera axis angle above the horizon in degrees; negative looks down. */
  pitchDeg: number
  /** Rotation about the camera axis in degrees; positive is clockwise as seen from behind the phone. */
  rollDeg: number
}

const toRad = (deg: number) => (deg * Math.PI) / 180
const toDeg = (rad: number) => (rad * 180) / Math.PI

/** Round any screen angle to 0, 90, 180, or 270. */
export function normalizeScreenAngle(angle: number): 0 | 90 | 180 | 270 {
  const turns = Math.round((((angle % 360) + 360) % 360) / 90) % 4
  return (turns * 90) as 0 | 90 | 180 | 270
}

/**
 * betaDeg and gammaDeg come from a DeviceOrientationEvent. screenAngle is screen.orientation.angle:
 * 0 upright, 90 turned counterclockwise (top of the phone to the left), 180 upside down, 270 turned clockwise.
 */
export function cameraAttitude(betaDeg: number, gammaDeg: number, screenAngle: number): Attitude {
  const beta = toRad(betaDeg)
  const gamma = toRad(gammaDeg)
  const xUp = -Math.cos(beta) * Math.sin(gamma)
  const yUp = Math.sin(beta)

  // Which device axis is "up" and which is "right" in the picture the user sees.
  let imageUp: number
  let imageRight: number
  switch (normalizeScreenAngle(screenAngle)) {
    case 0:
      imageUp = yUp
      imageRight = xUp
      break
    case 90:
      imageUp = xUp
      imageRight = -yUp
      break
    case 180:
      imageUp = -yUp
      imageRight = -xUp
      break
    case 270:
      imageUp = -xUp
      imageRight = yUp
      break
  }

  // Alpha turns the camera about the vertical, so it cannot change the pitch: any value (0) gives the same.
  const pitchDeg = pitchFromForward(cameraForward(0, betaDeg, gammaDeg))
  const rollDeg = toDeg(Math.atan2(-imageRight, imageUp))
  return { pitchDeg, rollDeg }
}

/** Move an angle toward a new reading by factor alpha (0..1), taking the short way around 360 degrees. */
export function smoothAngle(previousDeg: number, nextDeg: number, alpha: number): number {
  const delta = ((((nextDeg - previousDeg) % 360) + 540) % 360) - 180
  return previousDeg + alpha * delta
}
