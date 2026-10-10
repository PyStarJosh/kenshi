// End-to-end latency of alerts: frame capture to the start of the tone (NFR-3) and to the start of speech (NFR-4).
// Every alert is stamped with its frame's capture time, so each sample is one alert's full path.
import { CONFIG } from '../core/config'
import type { AlertPriority } from '../core/types'
import { percentile } from './screens/benchmarkStats'

export type LatencyStage = 'tone' | 'speech'

export interface LatencySpread {
  count: number
  p50: number
  p95: number
}

export interface LatencyView {
  /** Capture to tone start, urgent alerts only (NFR-3). */
  urgentTone: LatencySpread | null
  /** Capture to tone start, every alert. */
  tone: LatencySpread | null
  /** Capture to speech start, every alert (NFR-4). */
  speech: LatencySpread | null
}

function spread(values: readonly number[]): LatencySpread | null {
  if (values.length === 0) return null
  return { count: values.length, p50: percentile(values, 50), p95: percentile(values, 95) }
}

/** Rolling samples, newest last; the oldest are forgotten once the limit is reached. */
export class LatencyStats {
  private tone: { ms: number; urgent: boolean }[] = []
  private speech: number[] = []

  record(stage: LatencyStage, priority: AlertPriority, ms: number): void {
    const limit = CONFIG.debug.latencySamples
    if (stage === 'tone') {
      this.tone.push({ ms, urgent: priority === 'urgent' })
      if (this.tone.length > limit) this.tone.shift()
    } else {
      this.speech.push(ms)
      if (this.speech.length > limit) this.speech.shift()
    }
  }

  view(): LatencyView {
    return {
      urgentTone: spread(this.tone.filter((s) => s.urgent).map((s) => s.ms)),
      tone: spread(this.tone.map((s) => s.ms)),
      speech: spread(this.speech),
    }
  }
}

const ms = (value: number) => value.toFixed(0)

/** "p50 / p95 ms (n)" for the debug panel; a dash before the first sample. */
export function formatSpread(value: LatencySpread | null): string {
  return value ? `${ms(value.p50)} / ${ms(value.p95)} ms (${value.count})` : '-'
}
