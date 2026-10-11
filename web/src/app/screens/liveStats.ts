import { CONFIG } from '../../core/config'
import type { FrameResult } from '../../core/types'
import { percentile } from './benchmarkStats'

export interface LiveStatsView {
  /** Detection results per second over the recent window. */
  fps: number
  inferenceP50: number
  inferenceP95: number
  /** Capture to result on the main thread: how far the detections lag behind the picture. */
  latencyP50: number
  latencyP95: number
}

interface Sample {
  receivedTimeMs: number
  inferenceMs: number
  latencyMs: number
}

/** Rolling statistics for the debug overlay. */
export class LiveStats {
  private samples: Sample[] = []

  push(result: FrameResult): void {
    this.samples.push({
      receivedTimeMs: result.receivedTimeMs,
      inferenceMs: result.timings.inferenceMs,
      latencyMs: result.receivedTimeMs - result.captureTimeMs,
    })
    if (this.samples.length > CONFIG.debug.statsSamples) this.samples.shift()
  }

  view(nowMs: number): LiveStatsView {
    if (this.samples.length === 0) return { fps: 0, inferenceP50: 0, inferenceP95: 0, latencyP50: 0, latencyP95: 0 }
    const inference = this.samples.map((s) => s.inferenceMs)
    const latency = this.samples.map((s) => s.latencyMs)
    const recent = this.samples.filter((s) => nowMs - s.receivedTimeMs <= CONFIG.health.fpsWindowMs)
    let fps = 0
    if (recent.length >= 2) {
      const span = recent[recent.length - 1].receivedTimeMs - recent[0].receivedTimeMs
      fps = span > 0 ? ((recent.length - 1) * 1000) / span : 0
    }
    return {
      fps,
      inferenceP50: percentile(inference, 50),
      inferenceP95: percentile(inference, 95),
      latencyP50: percentile(latency, 50),
      latencyP95: percentile(latency, 95),
    }
  }
}
