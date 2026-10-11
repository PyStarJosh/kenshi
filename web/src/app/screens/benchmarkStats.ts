import { CONFIG } from '../../core/config'
import type { FrameResult } from '../../core/types'

/** Nearest-rank percentile (p from 0 to 100) of a non-empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('percentile of an empty list')
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

export interface Spread {
  p50: number
  p95: number
}

export interface BenchmarkStats {
  preprocess: Spread
  inference: Spread
  postprocess: Spread
  /** Sum of the three worker stages for each frame. */
  total: Spread
  /** Time from sending the frame to receiving the result, including thread transfer. */
  roundTrip: Spread
  /** The free-space path stage (R7) when it ran on every timed frame; null when it did not run. */
  path: Spread | null
  /** The worker total per frame with the path added on one frame in `every` (what the live app does). */
  totalWithPath: Spread | null
}

function spread(values: number[]): Spread {
  return { p50: percentile(values, 50), p95: percentile(values, 95) }
}

export function summarize(
  results: readonly FrameResult[],
  roundTripMs: readonly number[],
  every: number = CONFIG.freeSpace.everyNthFrame,
): BenchmarkStats {
  const pathTimes = results.map((r) => r.timings.pathMs)
  const hasPath = pathTimes.length > 0 && pathTimes.every((t) => t !== undefined)
  const detection = results.map((r) => r.timings.preprocessMs + r.timings.inferenceMs + r.timings.postprocessMs)
  return {
    path: hasPath ? spread(pathTimes as number[]) : null,
    totalWithPath: hasPath
      ? spread(detection.map((t, i) => t + (i % Math.max(1, every) === 0 ? (pathTimes[i] as number) : 0)))
      : null,
    preprocess: spread(results.map((r) => r.timings.preprocessMs)),
    inference: spread(results.map((r) => r.timings.inferenceMs)),
    postprocess: spread(results.map((r) => r.timings.postprocessMs)),
    total: spread(results.map((r) => r.timings.preprocessMs + r.timings.inferenceMs + r.timings.postprocessMs)),
    roundTrip: spread([...roundTripMs]),
  }
}
