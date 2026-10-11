// What the free-space path needs besides the picture (R7): the camera's tilt and field of view for the horizon, and the
// target's column for steering. Pure helpers, so the numbers handed to computeFreeSpacePath are tested without a browser.
import { horizonRow } from './freeSpacePath'
import type { PathOptions } from './freeSpacePath'

/** Sent to the detection worker with a frame to ask for a path on it. */
export interface PathInput {
  /** The camera axis above the horizon in degrees (negative looks down), or null without a tilt reading. */
  pitchDeg: number | null
  /** Horizontal field of view in degrees (the calibrated one). */
  hfovDeg: number
  /** The target's column from 0 (left edge) to 1 (right edge), or null when the target is not in view. */
  targetX: number | null
  /** Compute the path on this frame whatever the every-Nth-frame counter says (the benchmark). */
  force?: boolean
}

const toRad = (deg: number) => (deg * Math.PI) / 180

/** The size a frame is analysed at: processWidth wide (never wider than the frame), the aspect ratio kept. */
export function processSize(frameWidth: number, frameHeight: number, processWidth: number): { width: number; height: number } {
  const width = Math.max(3, Math.min(Math.round(processWidth), frameWidth))
  const height = Math.max(3, Math.round((width * frameHeight) / frameWidth))
  return { width, height }
}

/** Vertical field of view from the horizontal one and the frame shape (square pixels). */
export function verticalFovRad(hfovDeg: number, width: number, height: number): number {
  return 2 * Math.atan(Math.tan(toRad(hfovDeg) / 2) * (height / width))
}

/**
 * The target's column in the picture: 0.5 + bearing / hfov. Null when there is no bearing or the target is outside the
 * field of view (the path then goes up the widest open channel).
 */
export function targetColumn(bearingDeg: number | null, hfovDeg: number): number | null {
  if (bearingDeg === null || !Number.isFinite(bearingDeg) || !(hfovDeg > 0)) return null
  if (Math.abs(bearingDeg) > hfovDeg / 2) return null
  return 0.5 + bearingDeg / hfovDeg
}

export type PathDecision = 'left' | 'right' | 'straight' | 'none'

/**
 * Which way the line goes around something on the way to the target: left or right when the point the decision is read
 * at lies more than the dead band to that side of the target's column, straight when it is within it, none with no line.
 * With a target the line keeps to the target's column wherever the floor is open, so it leaves that column only to get
 * around an obstacle; measured from the middle of the picture instead, a target a little to one side would read as a
 * detour.
 */
export function detourDecision(lookahead: { x: number } | null, targetX: number, deadbandFrac: number): PathDecision {
  if (lookahead === null) return 'none'
  const dx = lookahead.x - targetX
  if (dx < -deadbandFrac) return 'left'
  if (dx > deadbandFrac) return 'right'
  return 'straight'
}

/**
 * The decision to act on: it changes only when a new decision has at least minVotes of the recent results; otherwise
 * the previous one stands (null before there is one). So one or two odd frames never flip it.
 */
export function stableDecision(history: readonly PathDecision[], previous: PathDecision | null, minVotes: number): PathDecision | null {
  const votes = new Map<PathDecision, number>()
  for (const decision of history) votes.set(decision, (votes.get(decision) ?? 0) + 1)
  let best: PathDecision | null = null
  let bestVotes = 0
  for (const [decision, count] of votes) {
    if (count > bestVotes) {
      best = decision
      bestVotes = count
    }
  }
  return best !== null && bestVotes >= minVotes ? best : previous
}

/**
 * The target's column to steer by: it follows the target, but moves only when the target has moved by more than the
 * dead band, so the line does not wander with every small sway of the hand.
 */
export function steadyColumn(previous: number | null, next: number | null, deadband: number): number | null {
  if (next === null) return null
  if (previous === null || Math.abs(next - previous) > deadband) return next
  return previous
}

/** The options for computeFreeSpacePath: the horizon row from the tilt, and the target column. */
export function pathOptionsFor(input: PathInput, width: number, height: number): PathOptions {
  const options: PathOptions = {}
  if (input.pitchDeg !== null && Number.isFinite(input.pitchDeg) && input.hfovDeg > 0) {
    // Looking below the horizon (negative pitch) moves the horizon up the frame.
    options.horizonRow = horizonRow(toRad(-input.pitchDeg), verticalFovRad(input.hfovDeg, width, height), height)
  }
  if (input.targetX !== null && Number.isFinite(input.targetX)) options.targetX = input.targetX
  return options
}
