// Motion of a track: closing speed and time to contact from timestamped history. Pure functions.
// With a distance, closing speed is the slope of distance over time and time to contact is
// distance / closing speed. Without one, time to contact is box height / its growth rate, which is
// the reciprocal of the growth rate of ln(height). Only timestamps are used, never frame counts.
import { CONFIG } from '../core/config'

export interface MotionSample {
  timeMs: number
  /** Smoothed distance, null when geometry gave none. */
  distanceM: number | null
  /** Smoothed box height, normalized. */
  height: number
}

export type TrackingConfig = typeof CONFIG.tracking
export interface AlertConfig {
  approachMinSpeedMps: number
  approachMaxTtcS: number
}

/** Least-squares slope of y over t (t in seconds); null when the points are too few or too short in time. */
function slope(points: { t: number; y: number }[], minSamples: number, minSpanS: number): number | null {
  const n = points.length
  if (n < minSamples) return null
  const span = points[n - 1].t - points[0].t
  if (span < minSpanS) return null
  let sumT = 0
  let sumY = 0
  for (const p of points) {
    sumT += p.t
    sumY += p.y
  }
  const meanT = sumT / n
  const meanY = sumY / n
  let num = 0
  let den = 0
  for (const p of points) {
    num += (p.t - meanT) * (p.y - meanY)
    den += (p.t - meanT) ** 2
  }
  return den > 0 ? num / den : null
}

function recent(samples: readonly MotionSample[], windowMs: number): MotionSample[] {
  if (samples.length === 0) return []
  const from = samples[samples.length - 1].timeMs - windowMs
  return samples.filter((s) => s.timeMs >= from)
}

/** Meters per second toward the user (positive is closer) over the window; null without enough distances. */
export function closingSpeed(samples: readonly MotionSample[], cfg: TrackingConfig = CONFIG.tracking): number | null {
  const points = recent(samples, cfg.closingSpeedWindowMs)
    .filter((s) => s.distanceM !== null)
    .map((s) => ({ t: s.timeMs / 1000, y: s.distanceM as number }))
  const s = slope(points, cfg.minMotionSamples, cfg.closingSpeedWindowMs / 2000)
  return s === null ? null : -s
}

/** Relative growth of the box height per second (0.25 means 25 % per second); null without enough history. */
export function heightGrowthRate(samples: readonly MotionSample[], cfg: TrackingConfig = CONFIG.tracking): number | null {
  const points = recent(samples, cfg.closingSpeedWindowMs)
    .filter((s) => s.height > 0)
    .map((s) => ({ t: s.timeMs / 1000, y: Math.log(s.height) }))
  return slope(points, cfg.minMotionSamples, cfg.closingSpeedWindowMs / 2000)
}

/**
 * Time to contact in seconds, or null when the object is not closing in. Uses the distance when
 * there is a closing speed, otherwise the height growth.
 */
export function timeToContact(
  distanceM: number | null,
  closingSpeedMps: number | null,
  heightGrowthPerS: number | null,
  tracking: TrackingConfig = CONFIG.tracking,
  alerts: AlertConfig = CONFIG.alerts,
): number | null {
  if (distanceM !== null && closingSpeedMps !== null) {
    return closingSpeedMps >= alerts.approachMinSpeedMps ? distanceM / closingSpeedMps : null
  }
  if (heightGrowthPerS !== null && heightGrowthPerS >= tracking.minHeightGrowthPerS) {
    return 1 / heightGrowthPerS
  }
  return null
}

/**
 * Tracks how long time to contact has stayed below the limit. Returns the time the condition began
 * (null if it does not hold now) and whether it has held for long enough to count as approaching.
 */
export function assessApproach(
  sinceMs: number | null,
  ttcS: number | null,
  withinCorridor: boolean,
  nowMs: number,
  tracking: TrackingConfig = CONFIG.tracking,
  alerts: AlertConfig = CONFIG.alerts,
): { sinceMs: number | null; approaching: boolean } {
  const holds = ttcS !== null && ttcS <= alerts.approachMaxTtcS && withinCorridor
  if (!holds) return { sinceMs: null, approaching: false }
  const start = sinceMs ?? nowMs
  return { sinceMs: start, approaching: nowMs - start >= tracking.approachHoldMs }
}
