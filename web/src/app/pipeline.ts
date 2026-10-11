// Pipeline: the live path from detections to spoken alerts. Each frame result goes through the tracker (A4),
// whose tracks go to the alert policy (A5); alerts leave on the event bus, and the audio link (U1) listens.
// The audio link reports what became of each alert, which tells the policy when the next one may go.
//
//   session result -> tracker -> tracks -> policy -> bus "alert" -> audio link
//                                            ^                          |
//                                            +---- bus "alertOutcome" <-+
import { EventBus } from '../alerts/bus'
import type { AlertReason, DropRecord, PolicyResult } from '../alerts/policy'
import type { AlertTimes, TrackLookup } from '../audio/engine'
import type {
  AlertEvent,
  AlertOutcome,
  EventMap,
  FrameResult,
  HealthState,
  OrientationSample,
  Settings,
  TelemetryEvent,
  Track,
  VoiceIntent,
} from '../core/types'
import type { VoiceSource } from '../voice/control'
import type { SessionState } from './session'

export interface PipelineSession {
  onResult(listener: (result: FrameResult) => void): () => void
  subscribe(listener: () => void): () => void
  getSnapshot(): { state: SessionState }
  /** The tilt at a moment, so a frame uses the tilt from when it was captured. */
  getOrientationAt(timeMs: number): OrientationSample | null
}

export interface PipelineLink {
  handleAlert(alert: AlertEvent): void
  setSummarizer(summarizer: (() => string) | null): void
  setTrackLookup(lookup: TrackLookup | null): void
  onAlertOutcome(
    listener: (alert: AlertEvent, outcome: AlertOutcome, latencyMs: number | null, times?: AlertTimes) => void,
  ): () => void
  /** Health state after every check, and voice commands; both are only logged, so a link may leave them out. */
  onHealth?(listener: (health: HealthState) => void): () => void
  onVoice?(listener: (intent: VoiceIntent, source: VoiceSource) => void): () => void
}

export interface PipelineTracker {
  update(result: FrameResult, tilt: OrientationSample | null, settings: Pick<Settings, 'eyeHeightM' | 'horizontalFovDeg'>): Track[]
  reset(): void
}

export interface PipelinePolicy {
  update(tracks: readonly Track[], nowMs: number, frameTimeMs: number): PolicyResult
  notifyOutcome(alertId: string, outcome: AlertOutcome, nowMs: number): void
  summarize(tracks: readonly Track[]): string
  reset(): void
}

/** An alert as shown in the debug overlay, with why it was raised. */
export interface Caption {
  alert: AlertEvent
  reason: AlertReason
  atMs: number
}

export interface PipelineDeps {
  session: PipelineSession
  link: PipelineLink
  tracker: PipelineTracker
  policy: PipelinePolicy
  getSettings: () => Pick<Settings, 'eyeHeightM' | 'horizontalFovDeg'>
  now: () => number
  bus?: EventBus<EventMap>
}

const CAPTION_LIMIT = 6
// Frames from the last second give the frame rate that goes in the log.
const FPS_WINDOW_MS = 1000

// Drops that the shared AlertOutcome type can express are also announced on the bus.
const DROP_OUTCOME: Partial<Record<DropRecord['reason'], AlertOutcome>> = {
  stale: 'dropped-stale',
  'track-gone': 'dropped-track-gone',
}

export class Pipeline {
  readonly bus: EventBus<EventMap>
  private deps: PipelineDeps
  private tracks: Track[] = []
  private byId = new Map<number, Track>()
  private captions: Caption[] = []
  private lastState: SessionState | null = null
  private recentCaptures: number[] = []

  constructor(deps: PipelineDeps) {
    this.deps = deps
    this.bus = deps.bus ?? new EventBus<EventMap>()
  }

  /** The tracks from the latest frame. */
  getTracks(): readonly Track[] {
    return this.tracks
  }

  /** The latest alerts the policy sent, oldest first. */
  getCaptions(): readonly Caption[] {
    return this.captions
  }

  /** Start listening to the session and connect the audio link. Returns a function that undoes it. */
  attach(): () => void {
    const { session, link, policy } = this.deps
    const syncState = () => {
      const state = session.getSnapshot().state
      if (state === this.lastState) return
      this.lastState = state
      this.telemetry({ kind: 'run-state', timeMs: this.deps.now(), state })
      if (state !== 'running') this.reset() // after a pause or a stop the old tracks no longer exist
    }
    syncState()
    link.setTrackLookup((id) => this.byId.get(id) ?? null)
    link.setSummarizer(() => policy.summarize(this.tracks))
    const stops: ((() => void) | undefined)[] = [
      session.onResult((result) => this.process(result)),
      session.subscribe(syncState),
      link.onAlertOutcome((alert, outcome, latencyMs, times) => {
        const timeMs = this.deps.now()
        this.bus.publish('alertOutcome', { alert, outcome, timeMs })
        this.telemetry({
          kind: 'alert',
          timeMs,
          alert,
          outcome,
          latencyMs,
          toneStartMs: times?.toneStartMs ?? null,
          speechStartMs: times?.speechStartMs ?? null,
        })
      }),
      link.onHealth?.((health) => this.telemetry({ kind: 'health', timeMs: this.deps.now(), health })),
      link.onVoice?.((intent, source) => this.telemetry({ kind: 'voice', timeMs: this.deps.now(), intent, source })),
      this.bus.subscribe('alert', (alert) => link.handleAlert(alert)),
      this.bus.subscribe('alertOutcome', ({ alert, outcome, timeMs }) => policy.notifyOutcome(alert.id, outcome, timeMs)),
    ]
    return () => {
      for (const stop of stops) stop?.()
      link.setTrackLookup(null)
      link.setSummarizer(null)
    }
  }

  private process(result: FrameResult): void {
    const { session, tracker, policy, getSettings, now } = this.deps
    // Pair the frame with the tilt at the moment it was captured, not the moment it finished.
    const orientation = session.getOrientationAt(result.captureTimeMs)
    const tracks = tracker.update(result, orientation, getSettings())
    this.tracks = tracks
    this.byId = new Map(tracks.map((t) => [t.id, t]))
    this.bus.publish('frame', result)
    this.bus.publish('tracks', tracks)

    const nowMs = now()
    const { emitted, drops } = policy.update(tracks, nowMs, result.captureTimeMs)
    // The log gets the frame before anything it caused, so a replay sees the same order.
    this.logFrame(result, orientation, tracks, nowMs)
    for (const drop of drops) {
      this.telemetry({ kind: 'drop', timeMs: nowMs, alert: drop.alert, trackId: drop.trackId, reason: drop.reason })
      const outcome = DROP_OUTCOME[drop.reason]
      if (outcome) this.bus.publish('alertOutcome', { alert: drop.alert, outcome, timeMs: nowMs })
    }
    for (const { alert, reason } of emitted) {
      this.captions = [...this.captions, { alert, reason, atMs: nowMs }].slice(-CAPTION_LIMIT)
      this.telemetry({ kind: 'alert', timeMs: nowMs, alert, outcome: 'queued', latencyMs: null })
      this.bus.publish('alert', alert)
    }
  }

  /** Hand the log (when Test mode has one running) a record of what happened. Free when nobody listens. */
  private telemetry(event: TelemetryEvent): void {
    this.bus.publish('telemetry', event)
  }

  private logFrame(result: FrameResult, orientation: OrientationSample | null, tracks: Track[], nowMs: number): void {
    this.recentCaptures = [...this.recentCaptures.filter((t) => result.captureTimeMs - t < FPS_WINDOW_MS), result.captureTimeMs]
    this.telemetry({
      kind: 'frame',
      timeMs: nowMs,
      frameId: result.frameId,
      timings: result.timings,
      captureTimeMs: result.captureTimeMs,
      receivedTimeMs: result.receivedTimeMs,
      frameWidth: result.frameWidth,
      frameHeight: result.frameHeight,
      meanLuma: result.meanLuma,
      fps: this.recentCaptures.length,
      pipelineMs: this.deps.now() - result.captureTimeMs,
      detections: result.detections,
      orientation,
    })
    this.telemetry({ kind: 'tracks', timeMs: nowMs, frameId: result.frameId, tracks })
  }

  private reset(): void {
    this.deps.tracker.reset()
    this.deps.policy.reset()
    this.tracks = []
    this.byId.clear()
    this.recentCaptures = []
  }
}
