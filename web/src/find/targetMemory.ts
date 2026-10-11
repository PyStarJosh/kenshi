// Target memory (FR-24): where the target was last seen, kept as a heading so guidance continues when the
// target is out of view. Pure functions; the caller passes the time. The heading is the camera's unwrapped
// yaw (sensors/heading.ts), whose zero is arbitrary, so only differences are used.
import { CONFIG } from '../core/config'
import type { LocateBox } from '../core/types'
import { locate, roundDistance } from '../geometry/geometry'
import type { FrameDims } from '../geometry/geometry'
import { wrap180 } from '../sensors/heading'

export interface TargetMemory {
  label: string
  /** The target's direction on the ground, as a camera heading in degrees. */
  heading: number
  /** Estimated distance in meters, rounded to 0.5, or null when no estimate was possible. */
  distanceM: number | null
  /** performance.now() when it was seen. */
  seenAt: number
  /** What found it: the Gemini locate call or the on-device detector. */
  source: 'gemini' | 'yolo'
  /**
   * The target's box ran off the bottom of the frame when it was last seen: its base was out of view, so distanceM is
   * only an upper bound, and the target may soon slip out of the frame altogether.
   */
  clipped?: boolean
}

/**
 * The target's heading from where its box sits in a frame: the heading the camera had when the frame was taken,
 * plus how far the box center is from the middle of the picture. boxCenterX is 0 (left edge) to 1 (right edge)
 * and hfovDeg the camera's horizontal field of view. A straight-line mapping: exact at the middle and the
 * edges, and within about 1.5 degrees in between for a 65 degree field of view.
 */
export function observe(frameHeading: number, boxCenterX: number, hfovDeg: number): number {
  return frameHeading + (boxCenterX - 0.5) * hfovDeg
}

/** The center of a box, 0 to 1 across the frame. */
export function boxCenterX(box: LocateBox): number {
  return (box.x0 + box.x1) / 2
}

/** How far to turn to face the target, in degrees in (-180, 180]; positive means to the right. */
export function bearing(memory: Pick<TargetMemory, 'heading'>, currentHeading: number): number {
  return wrap180(memory.heading - currentHeading)
}

/** True when the bearing falls inside the camera's field of view (the edges count as inside). */
export function inView(bearingDeg: number, hfovDeg: number): boolean {
  return Math.abs(bearingDeg) <= hfovDeg / 2
}

export function ageMs(memory: Pick<TargetMemory, 'seenAt'>, nowMs: number): number {
  return Math.max(0, nowMs - memory.seenAt)
}

/** A memory older than the limit is dropped: gyroscope heading drifts, so an old direction is not trusted. */
export function isStale(
  memory: Pick<TargetMemory, 'seenAt'>,
  nowMs: number,
  maxAgeMs: number = CONFIG.find.memoryMaxAgeMs,
): boolean {
  return ageMs(memory, nowMs) > maxAgeMs
}

export interface TargetDistanceInput {
  /** The target's box in the frame, as fractions from the top-left. */
  box: LocateBox
  /** The size of the frame the box is in (only its shape matters). */
  frame: FrameDims
  /** The target's bottom edge rests on the floor, so the ground-plane method applies. */
  onFloor: boolean
  /** Gemini's rough guess in meters, or null. */
  geminiDistanceM: number | null
  /** The camera pitch when the frame was taken. Null means no tilt reading. */
  pitchDeg: number | null
  eyeHeightM: number
  horizontalFovDeg: number
  /** Roll at capture; not sent to the locate function, so 0 unless known. */
  rollDeg?: number
  /** A typical height of the target in meters, for the box-size fallback; null when unknown. */
  typicalHeightM?: number | null
}

export type TargetDistanceSource = 'ground-plane' | 'gemini' | 'box-size'

/**
 * Distance to the target, best method first: the ground plane from the box's bottom row and the pitch at capture
 * (only when it rests on the floor), then Gemini's own guess, then the box-size method (only when a typical height is
 * known). Rounded to 0.5 m like the rest of the app; null when none applies.
 */
export function estimateTargetDistance(input: TargetDistanceInput): {
  distanceM: number | null
  source: TargetDistanceSource | null
} {
  const { box, frame, onFloor, geminiDistanceM, pitchDeg } = input
  const result = locate({
    box: { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 },
    classInfo: { groundContact: onFloor, typicalHeightM: input.typicalHeightM ?? null },
    frame,
    tilt: pitchDeg === null ? null : { pitchDeg, rollDeg: input.rollDeg ?? 0 },
    eyeHeightM: input.eyeHeightM,
    horizontalFovDeg: input.horizontalFovDeg,
  })
  const { minValidDistanceM, maxValidDistanceM } = CONFIG.geometry
  if (onFloor && result.distanceGroundM !== null) {
    return { distanceM: roundDistance(result.distanceGroundM), source: 'ground-plane' }
  }
  if (geminiDistanceM !== null && geminiDistanceM >= minValidDistanceM && geminiDistanceM <= maxValidDistanceM) {
    return { distanceM: roundDistance(geminiDistanceM), source: 'gemini' }
  }
  if (result.distanceBoxM !== null) return { distanceM: roundDistance(result.distanceBoxM), source: 'box-size' }
  return { distanceM: null, source: null }
}

/** Build the memory record for a target just found in a frame. */
export function remember(args: {
  label: string
  frameHeading: number
  box: LocateBox
  hfovDeg: number
  distanceM: number | null
  nowMs: number
  source: 'gemini' | 'yolo'
  clipped?: boolean
}): TargetMemory {
  return {
    label: args.label,
    heading: observe(args.frameHeading, boxCenterX(args.box), args.hfovDeg),
    distanceM: args.distanceM,
    seenAt: args.nowMs,
    source: args.source,
    ...(args.clipped === undefined ? {} : { clipped: args.clipped }),
  }
}
