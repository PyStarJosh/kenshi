// Camera pitch for the phone-lowered check. A stopgap until the orientation sensor (step A3) publishes
// OrientationSample; it then replaces watchPitch, and the monitor keeps taking the same samples.
import type { OrientationSample } from '../core/types'

const DEG = Math.PI / 180

/**
 * Angle of the rear camera axis above the horizon, from DeviceOrientationEvent beta and gamma.
 * The camera looks along the device's -z axis, whose upward component is -cos(beta) * cos(gamma),
 * so the result is the same in portrait and both landscape orientations.
 */
export function cameraPitchDeg(betaDeg: number, gammaDeg: number): number {
  const up = -Math.cos(betaDeg * DEG) * Math.cos(gammaDeg * DEG)
  return Math.asin(Math.max(-1, Math.min(1, up))) / DEG
}

type PermissionRequester = { requestPermission?: () => Promise<'granted' | 'denied'> }

/**
 * Listen to device orientation. Call inside a tap: iOS asks for motion permission then.
 * Returns a function that stops listening.
 */
export function watchPitch(
  onSample: (sample: OrientationSample) => void,
  onError: (message: string) => void,
): () => void {
  if (typeof DeviceOrientationEvent === 'undefined') {
    onError('This browser has no motion sensor access.')
    return () => {}
  }
  const listener = (event: DeviceOrientationEvent) => {
    if (event.beta === null || event.gamma === null) return
    onSample({ pitchDeg: cameraPitchDeg(event.beta, event.gamma), rollDeg: 0, timeMs: performance.now() })
  }
  const permission = DeviceOrientationEvent as unknown as PermissionRequester
  if (permission.requestPermission) {
    permission
      .requestPermission()
      .then((answer) => {
        if (answer === 'granted') window.addEventListener('deviceorientation', listener)
        else onError('Motion access was denied.')
      })
      .catch((error: unknown) => onError(`Motion access failed: ${String(error)}`))
  } else {
    window.addEventListener('deviceorientation', listener)
  }
  return () => window.removeEventListener('deviceorientation', listener)
}
