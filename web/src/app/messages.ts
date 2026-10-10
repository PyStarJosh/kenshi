// Short sentences for the status line (and, from step U1, for speech). Camera errors carry their own.
import { CameraError } from '../camera/camera'
import { DetectionLoadError } from '../detection/engine'
import type { LoadErrorKind } from '../detection/protocol'

export const MESSAGES = {
  idle: 'Not started. Press Start to begin.',
  starting: 'Starting the camera and loading the detector.',
  resuming: 'Restarting the camera.',
  running: 'Detection is running. Keep using your white cane.',
  paused: 'Paused. Press Resume to continue.',
  pausedHidden: 'Paused because the page was hidden.',
  cameraStopped: 'The camera stopped. Press Resume to try again.',
  unknownFailure: 'Something went wrong while starting, so press Start to try again.',
} as const

const LOAD_ERRORS: Record<LoadErrorKind, string> = {
  'model-fetch-failed': 'Could not load the detector, so check the connection and press Start.',
  'webgpu-unavailable': 'This browser cannot use WebGPU, so press Start to try again.',
  'wasm-failed': 'The detector could not start on this device.',
  'class-mismatch': 'The detector model does not match its class list.',
}

const WAKE_LOCK_PROBLEM = 'the screen may lock and stop the camera'
const TILT_PROBLEM = 'the tilt sensor is unavailable, so distances will be less accurate'

/** The status sentence while running, naming anything that is not working. */
export function runningMessage(options: { wakeLockHeld: boolean; tiltAvailable: boolean }): string {
  const problems: string[] = []
  if (!options.wakeLockHeld) problems.push(WAKE_LOCK_PROBLEM)
  if (!options.tiltAvailable) problems.push(TILT_PROBLEM)
  if (problems.length === 0) return MESSAGES.running
  return `Detection is running, but ${problems.join(', and ')}. Keep using your white cane.`
}

/** The sentence to show when starting failed; the camera problem comes first if both failed. */
export function describeStartFailure(camera: unknown, detector: unknown): string {
  for (const error of [camera, detector]) {
    if (error instanceof CameraError) return error.spoken
    if (error instanceof DetectionLoadError) return LOAD_ERRORS[error.kind]
  }
  return MESSAGES.unknownFailure
}

export function describeDetectionStopped(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Detection stopped after repeated errors: ${detail}`
}
