// Pure math: the rear camera's forward vector in Earth coordinates, and the heading and pitch taken from it.
// One vector is the single source of truth for both, so the camera's pitch and its heading can never disagree.
//
// W3C DeviceOrientation: the device turns by alpha about the vertical (counterclockwise seen from above), then
// beta about its x axis, then gamma about its y axis, so the device-to-Earth rotation is R = Rz(alpha) Rx(beta) Ry(gamma).
// Earth axes: x east, y north, z up. The rear camera looks along the device's -z axis, so the forward vector is
// minus the third column of R:
//   fx = -(cos a * sin g + sin a * sin b * cos g)
//   fy = -(sin a * sin g - cos a * sin b * cos g)
//   fz = -(cos b * cos g)
// Heading = atan2(fx, fy): 0 north, 90 east, clockwise like a compass, so turning right increases it. Nothing
// here looks at the screen orientation: the camera axis is fixed to the device, so portrait and both landscapes
// need no special cases. On iOS alpha has an arbitrary zero, so a heading is only good as a difference.

export interface Vec3 {
  /** East. */
  x: number
  /** North. */
  y: number
  /** Up. */
  z: number
}

const toRad = (deg: number) => (deg * Math.PI) / 180
const toDeg = (rad: number) => (rad * 180) / Math.PI

/** Any angle in degrees to [0, 360). */
export function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** The signed difference-style angle in (-180, 180]: positive is clockwise (to the right). */
export function wrap180(deg: number): number {
  const wrapped = wrap360(deg + 180) - 180
  return wrapped === -180 ? 180 : wrapped
}

/** Where the rear camera points, as a unit vector in Earth coordinates, from DeviceOrientation angles in degrees. */
export function cameraForward(alphaDeg: number, betaDeg: number, gammaDeg: number): Vec3 {
  const a = toRad(alphaDeg)
  const b = toRad(betaDeg)
  const g = toRad(gammaDeg)
  const sa = Math.sin(a)
  const ca = Math.cos(a)
  const sb = Math.sin(b)
  const cb = Math.cos(b)
  const sg = Math.sin(g)
  const cg = Math.cos(g)
  return {
    x: -(ca * sg + sa * sb * cg),
    y: -(sa * sg - ca * sb * cg),
    z: -(cb * cg),
  }
}

/** Camera axis angle above the horizon in degrees; negative looks down. */
export function pitchFromForward(forward: Vec3): number {
  return toDeg(Math.asin(Math.max(-1, Math.min(1, forward.z))))
}

/**
 * Compass-style heading in [0, 360), or null when the camera looks so steeply up or down that its direction on the
 * ground is not defined (the horizontal part of the vector is shorter than minHorizontal).
 */
export function headingFromForward(forward: Vec3, minHorizontal: number): number | null {
  if (Math.hypot(forward.x, forward.y) < minHorizontal) return null
  return wrap360(toDeg(Math.atan2(forward.x, forward.y)))
}

/**
 * Turns the stream of raw headings (each in [0, 360)) into one continuous heading that does not jump at north,
 * and smooths it lightly. The result is "unwrapped": turning right through north keeps counting 358, 359, 360, 361.
 * While the camera looks straight up or down (raw heading null) the last value is held.
 */
export class HeadingTracker {
  private readonly smoothing: number
  private lastRaw: number | null = null
  private unwrapped = 0
  private smoothed: number | null = null

  /** smoothing is 0..1: 1 follows the sensor exactly, smaller is steadier but lags more. */
  constructor(smoothing: number) {
    this.smoothing = smoothing
  }

  update(rawDeg: number | null): number | null {
    if (rawDeg === null) return this.smoothed
    if (this.lastRaw === null || this.smoothed === null) {
      this.unwrapped = rawDeg
      this.smoothed = rawDeg
    } else {
      this.unwrapped += wrap180(rawDeg - this.lastRaw)
      this.smoothed += this.smoothing * (this.unwrapped - this.smoothed)
    }
    this.lastRaw = rawDeg
    return this.smoothed
  }

  reset(): void {
    this.lastRaw = null
    this.unwrapped = 0
    this.smoothed = null
  }
}
