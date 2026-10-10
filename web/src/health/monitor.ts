// Health monitor: a pure state machine over frame arrivals, brightness, pitch, and error signals.
// It never reads the clock itself; callers pass performance.now() times, so tests use fake ones.
import { CONFIG } from '../core/config'
import type { FrameResult, HealthIssue, HealthState, HealthStatus, InferenceBackend, OrientationSample } from '../core/types'

/** What the audio engine should say. Warnings are urgent; recovery is said once. */
export type HealthAnnouncement =
  | { kind: 'warning'; issue: HealthIssue; phrase: string }
  | { kind: 'recovered'; phrase: string }

export interface HealthUpdate {
  state: HealthState
  announcements: HealthAnnouncement[]
}

export type RunState = 'running' | 'paused' | 'stopped'

/** Signals that come from outside the frame loop and hold until cleared. */
export type HealthFault = 'no-camera' | 'worker-error' | 'audio-blocked'

/** Most important first: this order decides which warning repeats. */
const PRIORITY: HealthIssue[] = [
  'no-camera',
  'worker-error',
  'stalled',
  'audio-blocked',
  'low-light',
  'phone-lowered',
  'low-fps',
  'no-orientation',
]
const STOPPING: ReadonlySet<HealthIssue> = new Set(['no-camera', 'worker-error', 'stalled'])

export const HEALTH_PHRASES = {
  stalled: 'Detection stalled.',
  'low-fps': 'Detection is slow.',
  'low-light': 'Too dark to detect reliably.',
  phoneLowered: 'Raise the phone to eye level.',
  phoneRaised: 'Lower the phone to eye level.',
  'no-camera': 'The camera stopped. Detection is off.',
  'worker-error': 'The detector failed. Detection is off.',
  'audio-blocked': 'Sound is off. Tap the screen to restore it.',
  'no-orientation': 'Motion sensor unavailable. Distances will be less accurate.',
  recovered: 'Detection back.',
} as const

export class HealthMonitor {
  private cfg = CONFIG.health
  private run: RunState = 'stopped'
  private runSinceMs = 0
  /** The fps window is judged only once it holds this much time without a stall. */
  private fpsSinceMs = 0
  private frameTimes: number[] = []
  private lastFrameMs: number | null = null
  private backend: InferenceBackend | null = null
  private darkSinceMs: number | null = null
  private tiltSinceMs: number | null = null
  private tiltUp = false
  private faults = new Set<HealthFault>()
  /** Issues that were announced and have not recovered yet. */
  private active = new Set<HealthIssue>()
  /** When each active issue's condition last turned false. */
  private clearSinceMs = new Map<HealthIssue, number>()
  private lastWarningMs = -Infinity

  /** Running, paused, or stopped. Any change starts the checks fresh and drops warnings silently. */
  setRunState(run: RunState, nowMs: number): void {
    if (run === this.run) return
    this.run = run
    this.runSinceMs = nowMs
    this.fpsSinceMs = nowMs
    this.frameTimes = []
    this.lastFrameMs = null
    this.darkSinceMs = null
    this.active.clear()
    this.clearSinceMs.clear()
    this.lastWarningMs = -Infinity
  }

  recordFrame(result: FrameResult): void {
    if (this.run !== 'running') return
    const t = result.receivedTimeMs
    this.lastFrameMs = t
    this.frameTimes.push(t)
    this.backend = result.backend
    if (result.meanLuma < this.cfg.lowLightLuma) this.darkSinceMs ??= t
    else this.darkSinceMs = null
  }

  recordOrientation(sample: OrientationSample): void {
    const lowered = sample.pitchDeg < this.cfg.phoneLoweredPitchDeg
    const raised = sample.pitchDeg > this.cfg.phoneRaisedPitchDeg
    if (lowered || raised) {
      this.tiltSinceMs ??= sample.timeMs
      this.tiltUp = raised
    } else {
      this.tiltSinceMs = null
    }
  }

  setFault(fault: HealthFault, on: boolean): void {
    if (on) this.faults.add(fault)
    else this.faults.delete(fault)
  }

  update(nowMs: number): HealthUpdate {
    const cfg = this.cfg
    const windowStart = nowMs - cfg.fpsWindowMs
    while (this.frameTimes.length > 0 && this.frameTimes[0] <= windowStart) this.frameTimes.shift()
    const fps = (this.frameTimes.length * 1000) / cfg.fpsWindowMs
    const running = this.run === 'running'
    const lastFrameAgeMs = running ? nowMs - (this.lastFrameMs ?? this.runSinceMs) : 0

    const raw = new Set<HealthIssue>(this.faults)
    if (running) {
      const stalled = lastFrameAgeMs > cfg.stalledAfterMs
      if (stalled) {
        raw.add('stalled')
        this.fpsSinceMs = nowMs
      } else if (nowMs - this.fpsSinceMs >= cfg.fpsWindowMs && fps < cfg.lowFpsThreshold) {
        raw.add('low-fps')
      }
      if (this.darkSinceMs !== null && nowMs - this.darkSinceMs >= cfg.lowLightHoldMs) raw.add('low-light')
      if (this.tiltSinceMs !== null && nowMs - this.tiltSinceMs >= cfg.phoneLoweredHoldMs) raw.add('phone-lowered')
    }

    const announcements: HealthAnnouncement[] = []
    const hadIssues = this.active.size > 0
    for (const issue of PRIORITY) {
      if (raw.has(issue)) {
        this.clearSinceMs.delete(issue)
        if (!this.active.has(issue)) {
          this.active.add(issue)
          announcements.push(this.warning(issue))
        }
      } else if (this.active.has(issue)) {
        const since = this.clearSinceMs.get(issue) ?? nowMs
        this.clearSinceMs.set(issue, since)
        if (nowMs - since >= cfg.recoverAfterMs) {
          this.active.delete(issue)
          this.clearSinceMs.delete(issue)
        }
      }
    }

    const issues = PRIORITY.filter((issue) => this.active.has(issue))
    if (announcements.length > 0) {
      this.lastWarningMs = nowMs
    } else if (issues.length > 0 && nowMs - this.lastWarningMs >= cfg.warningRepeatMs) {
      announcements.push(this.warning(issues[0]))
      this.lastWarningMs = nowMs
    } else if (hadIssues && issues.length === 0) {
      announcements.push({ kind: 'recovered', phrase: HEALTH_PHRASES.recovered })
    }

    let status: HealthStatus = 'healthy'
    if (!running || issues.some((issue) => STOPPING.has(issue))) status = 'stopped'
    else if (issues.length > 0) status = 'degraded'

    return {
      state: {
        status,
        issues,
        fps,
        lastFrameAgeMs,
        backend: this.backend,
        paused: this.run === 'paused',
        updatedTimeMs: nowMs,
      },
      announcements,
    }
  }

  private warning(issue: HealthIssue): HealthAnnouncement {
    const phrase =
      issue === 'phone-lowered'
        ? this.tiltUp
          ? HEALTH_PHRASES.phoneRaised
          : HEALTH_PHRASES.phoneLowered
        : HEALTH_PHRASES[issue]
    return { kind: 'warning', issue, phrase }
  }
}
