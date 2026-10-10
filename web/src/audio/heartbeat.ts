// Heartbeat: a quiet tick while detection is healthy, so silence never reads as "nothing ahead" (SR-1).
import type { HealthState } from '../core/types'

export interface HeartbeatInput {
  nowMs: number
  /** Time of the last tick; -Infinity before the first. */
  lastTickMs: number
  intervalMs: number
  health: HealthState | null
  /** Speech is waiting or playing. */
  speaking: boolean
  /** performance.now() time when the last tone ends. */
  toneBusyUntilMs: number
}

/** A tick is due when detection is healthy and running, the interval has passed, and nothing else is sounding. */
export function heartbeatDue(input: HeartbeatInput): boolean {
  const { health } = input
  if (!health || health.status !== 'healthy' || health.paused) return false
  if (input.speaking || input.nowMs < input.toneBusyUntilMs) return false
  return input.nowMs - input.lastTickMs >= input.intervalMs
}
