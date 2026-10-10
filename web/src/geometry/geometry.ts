// Geometry: turns a detection box into a clock direction, a distance in meters, a height label, and
// whether it is in the walking path. Pure functions, no DOM. Formulas are written out in docs/SDS.md section 5.
//
// Camera frame: x to the right, y down. A pixel becomes a ray (u, v) = ((px - cx) / f, (py - cy) / f),
// then is turned by -roll so the horizon is level. With the camera axis `pitch` above the horizon:
//   forward part of the ray = cos(pitch) + v * sin(pitch)
//   down part of the ray    = v * cos(pitch) - sin(pitch)
//   tan(angle below horizon) = down / forward         bearing = atan2(u, forward)
import { CONFIG } from '../core/config'
import type { BoundingBox, ClassInfo, Clock, ClockPosition, Detection, DistanceSource, Elevation, Settings } from '../core/types'

export type GeometryConfig = typeof CONFIG.geometry

export interface FrameDims {
  width: number
  height: number
}

/** Camera tilt: pitch above the horizon and roll clockwise, both in degrees. Null means no sensor. */
export interface Tilt {
  pitchDeg: number
  rollDeg: number
}

export interface CameraModel extends FrameDims {
  /** Focal length in pixels (same for both axes). */
  focalPx: number
  cx: number
  cy: number
}

export interface GeometryInput {
  box: BoundingBox
  classInfo: Pick<ClassInfo, 'typicalHeightM' | 'groundContact'>
  frame: FrameDims
  tilt: Tilt | null
  eyeHeightM: number
  horizontalFovDeg: number
}

export interface GeometryResult {
  clock: Clock
  /** Distance ahead in meters, unrounded (for smoothing); null if no estimate was possible. */
  distanceM: number | null
  /** distanceM rounded to the nearest 0.5 m, at least 0.5 m, as spoken. */
  distanceRoundedM: number | null
  distanceSource: DistanceSource | null
  /** Each method's own answer, kept for tuning. Null when the method does not apply. */
  distanceGroundM: number | null
  distanceBoxM: number | null
  elevation: Elevation
  /** Height of the box bottom and top above the floor, null when unknown. */
  bottomHeightM: number | null
  topHeightM: number | null
  /** Sideways offset from straight ahead, positive to the right. */
  lateralOffsetM: number | null
  inPath: boolean
  /** The box touches the bottom edge, so its base is cut off and distance can be underestimated. */
  touchesBottom: boolean
  /** No tilt reading: the camera was assumed level and distance prefers the box-size method. */
  degraded: boolean
}

const toRad = (deg: number) => (deg * Math.PI) / 180
const toDeg = (rad: number) => (rad * 180) / Math.PI

export function cameraModel(frame: FrameDims, horizontalFovDeg: number): CameraModel {
  return {
    ...frame,
    focalPx: frame.width / 2 / Math.tan(toRad(horizontalFovDeg) / 2),
    cx: frame.width / 2,
    cy: frame.height / 2,
  }
}

interface Ray {
  u: number
  v: number
}

/** A pixel as a ray with the roll taken out. Positive roll is a clockwise camera, undone by turning clockwise. */
function levelRay(cam: CameraModel, px: number, py: number, rollRad: number): Ray {
  const u = (px - cam.cx) / cam.focalPx
  const v = (py - cam.cy) / cam.focalPx
  return {
    u: u * Math.cos(rollRad) - v * Math.sin(rollRad),
    v: u * Math.sin(rollRad) + v * Math.cos(rollRad),
  }
}

function forwardPart(ray: Ray, pitchRad: number): number {
  return Math.cos(pitchRad) + ray.v * Math.sin(pitchRad)
}

/** Horizontal angle of a ray from straight ahead, positive to the right. */
function bearingRad(ray: Ray, pitchRad: number): number {
  return Math.atan2(ray.u, forwardPart(ray, pitchRad))
}

/** Tangent of the angle below the horizon; null if the ray points backward. */
function tanBelowHorizon(ray: Ray, pitchRad: number): number | null {
  const forward = forwardPart(ray, pitchRad)
  if (forward <= 1e-9) return null
  return (ray.v * Math.cos(pitchRad) - Math.sin(pitchRad)) / forward
}

/** Round to the nearest step, never below one step. */
export function roundDistance(meters: number, step: number = CONFIG.alerts.roundToM): number {
  return Math.max(step, Math.round(meters / step) * step)
}

function clockPosition(
  angleDeg: number,
  touchesLeft: boolean,
  touchesRight: boolean,
  cfg: GeometryConfig,
): ClockPosition {
  // Touching one side edge means the object is off to that side. A box touching both fills the
  // view, so the angle decides.
  if (touchesLeft && !touchesRight) return 'far-left'
  if (touchesRight && !touchesLeft) return 'far-right'
  if (Math.abs(angleDeg) <= cfg.clockCenterDeg) return 12
  return angleDeg > 0 ? 1 : 11
}

export function locate(input: GeometryInput, cfg: GeometryConfig = CONFIG.geometry): GeometryResult {
  const { box, classInfo, frame, tilt, eyeHeightM: eye } = input
  const cam = cameraModel(frame, input.horizontalFovDeg)
  const degraded = tilt === null
  const pitch = toRad(tilt?.pitchDeg ?? 0)
  const roll = toRad(tilt?.rollDeg ?? 0)

  const left = box.x * frame.width
  const right = (box.x + box.width) * frame.width
  const top = box.y * frame.height
  const bottom = (box.y + box.height) * frame.height
  const centerPx = (left + right) / 2
  const middlePx = (top + bottom) / 2
  const margin = cfg.edgeTouchMargin
  const touchesLeft = box.x <= margin
  const touchesRight = box.x + box.width >= 1 - margin
  const touchesTop = box.y <= margin
  const touchesBottom = box.y + box.height >= 1 - margin

  // Direction of the box center.
  const bearing = bearingRad(levelRay(cam, centerPx, middlePx, roll), pitch)
  const angleDeg = toDeg(bearing)
  const clock: Clock = {
    position: clockPosition(angleDeg, touchesLeft, touchesRight, cfg),
    angleDeg,
  }

  // Distance candidates.
  const minDepression = Math.tan(toRad(cfg.minDepressionDeg))
  const inRange = (d: number | null): number | null =>
    d !== null && Number.isFinite(d) && d >= cfg.minValidDistanceM && d <= cfg.maxValidDistanceM ? d : null

  const tanBottom = tanBelowHorizon(levelRay(cam, centerPx, bottom, roll), pitch)
  const tanTop = tanBelowHorizon(levelRay(cam, centerPx, top, roll), pitch)

  // Ground plane: the base rests on the floor and is visible and clearly below the horizon.
  const groundM =
    classInfo.groundContact && !touchesBottom && tanBottom !== null && tanBottom >= minDepression
      ? inRange(eye / tanBottom)
      : null

  // Box size: typical height times focal length over the box height in pixels.
  const boxHeightPx = box.height * frame.height
  const boxM =
    classInfo.typicalHeightM !== null && boxHeightPx > 0
      ? inRange((classInfo.typicalHeightM * cam.focalPx) / boxHeightPx)
      : null
  const boxReliable = !touchesTop && !touchesBottom

  // Nearest floor the camera can see: an object cut off at the bottom edge is no farther than this.
  const tanFrameBottom = tanBelowHorizon(levelRay(cam, centerPx, frame.height, roll), pitch)
  const minVisibleM =
    tanFrameBottom !== null && tanFrameBottom >= minDepression ? inRange(eye / tanFrameBottom) : null

  let distanceM: number | null = null
  let distanceSource: DistanceSource | null = null
  if (degraded && boxReliable && boxM !== null) {
    // Without a tilt reading the ground plane is a guess, so trust the box size where it is sound.
    distanceM = boxM
    distanceSource = 'box-size'
  } else if (groundM !== null) {
    distanceM = groundM
    distanceSource = 'ground-plane'
  } else if (touchesBottom) {
    // Base cut off: both estimates tend to be too far, so take the nearer of the two.
    if (boxM !== null && (minVisibleM === null || boxM <= minVisibleM)) {
      distanceM = boxM
      distanceSource = 'box-size'
    } else if (minVisibleM !== null) {
      distanceM = minVisibleM
      distanceSource = 'min-visible'
    }
  } else if (boxM !== null) {
    distanceM = boxM
    distanceSource = 'box-size'
  }

  // Heights above the floor, from the distance and the angles to the top and bottom edges.
  const heightAt = (tan: number | null): number | null =>
    distanceM !== null && tan !== null ? eye - distanceM * tan : null
  const topHeightM = heightAt(tanTop)
  const bottomHeightM = heightAt(tanBottom)

  let elevation: Elevation = 'body'
  if (!touchesTop && topHeightM !== null && topHeightM <= cfg.floorTopMaxM) {
    elevation = 'floor'
  } else if (
    !touchesBottom &&
    bottomHeightM !== null &&
    bottomHeightM >= cfg.headBottomMinM &&
    bottomHeightM <= cfg.headBottomMaxM
  ) {
    elevation = 'head'
  }

  const lateralOffsetM = distanceM !== null ? distanceM * Math.tan(bearing) : null
  const inPath =
    distanceM !== null &&
    lateralOffsetM !== null &&
    distanceM <= cfg.corridorDepthM &&
    Math.abs(lateralOffsetM) <= cfg.corridorHalfWidthM

  return {
    clock,
    distanceM,
    distanceRoundedM: distanceM !== null ? roundDistance(distanceM) : null,
    distanceSource,
    distanceGroundM: groundM,
    distanceBoxM: boxM,
    elevation,
    bottomHeightM,
    topHeightM,
    lateralOffsetM,
    inPath,
    touchesBottom,
    degraded,
  }
}

/** Convenience for a Detection: looks up its class and reads the user's eye height and field of view. */
export function locateDetection(
  detection: Detection,
  classes: readonly ClassInfo[],
  frame: FrameDims,
  tilt: Tilt | null,
  settings: Pick<Settings, 'eyeHeightM' | 'horizontalFovDeg'>,
  cfg: GeometryConfig = CONFIG.geometry,
): GeometryResult {
  const classInfo = classes[detection.classId] ?? { typicalHeightM: null, groundContact: true }
  return locate(
    {
      box: detection.box,
      classInfo,
      frame,
      tilt,
      eyeHeightM: settings.eyeHeightM,
      horizontalFovDeg: settings.horizontalFovDeg,
    },
    cfg,
  )
}
