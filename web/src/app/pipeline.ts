// Pipeline: the one orchestrator of the live path. Each frame result goes through the tracker (A4); the
// tracks go on the event bus for the route (R7) and nothing announces them: the detector is silent, so the
// user is never read a list of objects. Alerts that other modules put on the bus (Find guidance, R4/R5) are
// handed to the audio link (U1), which reports what became of each one. The same link supplies the health
// monitor's state and the user's voice commands, which go on the bus too. Modules meet only through
// types.ts, the bus, and the small interfaces below.
//
//   session result -> tracker -> bus "frame", bus "tracks"
//   a frame result with a free-space path (R7) -> bus "path"; the recent decisions are kept for Find guidance
//   bus "alert" -> audio link -> bus "alertOutcome"
//   audio link -> bus "health", bus "voice", bus "findRequest", bus "findCancel"
//   a frame counts as healthy (health monitor) only after it went through the whole chain
import { EventBus } from '../alerts/bus'
import type { TrackLookup } from '../audio/engine'
import { CONFIG } from '../core/config'
import type {
  AlertEvent,
  AlertOutcome,
  EventMap,
  FindRequest,
  FrameResult,
  FreeSpaceResult,
  HealthState,
  OrientationSample,
  Settings,
  Track,
  VoiceIntent,
} from '../core/types'
import { stableDecision } from '../geometry/pathInput'
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
  setTrackLookup(lookup: TrackLookup | null): void
  onAlertOutcome(listener: (alert: AlertEvent, outcome: AlertOutcome) => void): () => void
  /** A frame result that went through the whole pipeline; the health monitor counts only those. */
  recordFrame(result: FrameResult): void
  onVoiceIntent(listener: (intent: VoiceIntent) => void): () => void
  onHealth(listener: (health: HealthState) => void): () => void
  /** A voice request to find something, or to cancel the search; the Find runner listens for them on the bus. */
  onFindRequest(listener: (request: FindRequest) => void): () => void
  onFindCancel(listener: () => void): () => void
}

export interface PipelineTracker {
  /** The orientation carries the heading, so the tracker can follow a turn between frames. */
  update(result: FrameResult, tilt: OrientationSample | null, settings: Pick<Settings, 'eyeHeightM' | 'horizontalFovDeg'>): Track[]
  reset(): void
}

export interface PipelineDeps {
  session: PipelineSession
  link: PipelineLink
  tracker: PipelineTracker
  getSettings: () => Pick<Settings, 'eyeHeightM' | 'horizontalFovDeg'>
  now: () => number
  bus?: EventBus<EventMap>
}

export class Pipeline {
  readonly bus: EventBus<EventMap>
  private deps: PipelineDeps
  private tracks: Track[] = []
  private byId = new Map<number, Track>()
  private lastState: SessionState | null = null
  private pathDecisions: FreeSpaceResult['decision'][] = []
  private pathDecision: FreeSpaceResult['decision'] | null = null
  private pathAtMs = -Infinity

  constructor(deps: PipelineDeps) {
    this.deps = deps
    this.bus = deps.bus ?? new EventBus<EventMap>()
  }

  /** The tracks from the latest frame. */
  getTracks(): readonly Track[] {
    return this.tracks
  }

  /**
   * What the path line says about the way ahead, or null when it has no opinion: a decision that has held a clear
   * majority of the last few results, if the newest is recent. "None" (no open path found) is no opinion.
   */
  getPathDecision(nowMs: number): 'left' | 'right' | 'straight' | null {
    if (this.pathDecision === null || nowMs - this.pathAtMs > CONFIG.freeSpace.maxAgeMs) return null
    return this.pathDecision === 'none' ? null : this.pathDecision
  }

  /** Start listening to the session and connect the audio link. Returns a function that undoes it. */
  attach(): () => void {
    const { session, link } = this.deps
    const syncState = () => {
      const state = session.getSnapshot().state
      if (state === this.lastState) return
      this.lastState = state
      if (state !== 'running') this.reset() // after a pause or a stop the old tracks no longer exist
    }
    syncState()
    link.setTrackLookup((id) => this.byId.get(id) ?? null)
    const stops: ((() => void) | undefined)[] = [
      session.onResult((result) => this.process(result)),
      session.subscribe(syncState),
      link.onAlertOutcome((alert, outcome) => this.bus.publish('alertOutcome', { alert, outcome, timeMs: this.deps.now() })),
      link.onVoiceIntent((intent) => this.bus.publish('voice', intent)),
      link.onHealth((health) => this.bus.publish('health', health)),
      link.onFindRequest((request) => this.bus.publish('findRequest', request)),
      link.onFindCancel(() => this.bus.publish('findCancel', undefined)),
      this.bus.subscribe('alert', (alert) => link.handleAlert(alert)),
    ]
    return () => {
      for (const stop of stops) stop?.()
      link.setTrackLookup(null)
    }
  }

  private process(result: FrameResult): void {
    // If run() throws, the frame is not counted as healthy, so a pipeline that keeps failing ends in the stalled
    // warning (SR-5, SR-8); the session also sees the failure and stops the loop after repeated ones.
    this.run(result)
    this.deps.link.recordFrame(result)
  }

  private run(result: FrameResult): void {
    const { session, tracker, getSettings } = this.deps
    // Pair the frame with the tilt at the moment it was captured, not the moment it finished.
    const orientation = session.getOrientationAt(result.captureTimeMs)
    const tracks = tracker.update(result, orientation, getSettings())
    this.tracks = tracks
    this.byId = new Map(tracks.map((t) => [t.id, t]))
    this.bus.publish('frame', result)
    this.bus.publish('tracks', tracks)
    if (result.freeSpace) this.recordPath(result.freeSpace)
  }

  private recordPath(path: FreeSpaceResult): void {
    this.pathDecisions.push(path.decision)
    if (this.pathDecisions.length > CONFIG.freeSpace.decisionHistory) this.pathDecisions.shift()
    this.pathDecision = stableDecision(this.pathDecisions, this.pathDecision, CONFIG.freeSpace.decisionMinVotes)
    this.pathAtMs = this.deps.now()
    this.bus.publish('path', path)
  }

  private reset(): void {
    this.deps.tracker.reset()
    this.tracks = []
    this.byId.clear()
    this.pathDecisions = []
    this.pathDecision = null
  }
}
