// Shared contracts between modules (see docs/SDS.md). Types only: no runtime code.
// Change this file only with the project owner's approval; every track builds against it.
// Conventions: times are milliseconds from performance.now(); distances are meters;
// angles are degrees; box coordinates are normalized 0..1 in the source frame, origin top-left.

/** Normalized box in the source camera frame (not the letterboxed model input). */
export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

/** Where inference ran. WebGPU is preferred; WebAssembly is the fallback. */
export type InferenceBackend = 'webgpu' | 'wasm'

/** One class of the active model, from the generated class map (detection/classes.ts). */
export interface ClassInfo {
  id: number
  /** Model label, for example "backpack". */
  label: string
  /** Name used in spoken phrases. */
  spokenName: string
  /** Typical real-world height in meters, for the box-size distance fallback. Null if meaningless (stairs, curb). */
  typicalHeightM: number | null
  /** True if the object stands on the ground, so the ground-plane distance applies. */
  groundContact: boolean
  /** True if the app may announce this class. */
  alertable: boolean
}

/** One object found in one frame, after thresholding and scaling back to the source frame. */
export interface Detection {
  classId: number
  label: string
  confidence: number
  box: BoundingBox
}

/** Per-stage timings measured inside the detection worker. */
export interface FrameTimings {
  preprocessMs: number
  inferenceMs: number
  postprocessMs: number
}

/** Everything the detection worker returns for one frame. */
export interface FrameResult {
  frameId: number
  /** When the frame was captured on the main thread. All latency budgets start here. */
  captureTimeMs: number
  /** When the main thread received this result. */
  receivedTimeMs: number
  /** Source frame size in pixels. */
  frameWidth: number
  frameHeight: number
  /** Square model input size in pixels (320 or 416). */
  inputSize: number
  backend: InferenceBackend
  timings: FrameTimings
  /** Mean brightness of the frame, 0 (black) to 1 (white). Feeds the low-light check. */
  meanLuma: number
  detections: Detection[]
}

/** Horizontal direction as spoken: clock positions 11, 12, 1, or beyond the clock range. */
export type ClockPosition = 'far-left' | 11 | 12 | 1 | 'far-right'

export interface Clock {
  position: ClockPosition
  /** Horizontal angle from the camera axis; negative is left. */
  angleDeg: number
}

/** Vertical placement. "body" is spoken without a suffix. */
export type Elevation = 'floor' | 'body' | 'head'

/** How the distance was obtained. "min-visible" means the object touches the frame bottom, so the distance is an upper bound. */
export type DistanceSource = 'ground-plane' | 'box-size' | 'min-visible'

export type TrackStatus = 'tentative' | 'confirmed'

/** One object followed across frames, with geometry attached. */
export interface Track {
  /** Increases monotonically; never reused. */
  id: number
  classId: number
  label: string
  status: TrackStatus
  /** Smoothed box. */
  box: BoundingBox
  confidence: number
  /** Matched frames within the last three (confirmation needs 2 of 3). */
  recentHits: number
  firstSeenMs: number
  /** Capture time of the last frame that matched this track. */
  lastSeenMs: number
  clock: Clock
  /** Smoothed distance to the object along the ground, rounded later for speech. */
  distanceM: number
  distanceSource: DistanceSource
  /** Raw distance candidates, kept for field-test tuning. Null when not computable. */
  distanceGroundM: number | null
  distanceBoxM: number | null
  elevation: Elevation
  /** Overlaps the walking corridor. */
  inPath: boolean
  /** Closing in fast enough to matter, even if not yet in the corridor. */
  approaching: boolean
  /** Positive when getting closer; null until enough history exists. */
  closingSpeedMps: number | null
  /** Seconds until contact at the current closing speed; null if not closing. */
  timeToContactS: number | null
}

/** One reading of the phone's attitude, already mapped to the landscape camera axis. */
export interface OrientationSample {
  /** Camera axis angle above the horizon; negative looks down. */
  pitchDeg: number
  /** Rotation about the camera axis. */
  rollDeg: number
  timeMs: number
}

export type AlertPriority = 'urgent' | 'normal' | 'info'

/** What the alert is about. Only "obstacle" alerts carry a track. */
export type AlertKind = 'obstacle' | 'summary' | 'health' | 'status' | 'help' | 'describe'

/** A request to the audio engine to play a tone and/or speak a phrase. */
export interface AlertEvent {
  id: string
  kind: AlertKind
  priority: AlertPriority
  /** Set for obstacle alerts; used to confirm the track still exists before speaking. */
  trackId: number | null
  /** Final text to speak and show in the aria-live region. */
  phrase: string
  /** Stereo pan for the lead-in tone, -1 (left) to 1 (right). Null for no tone. */
  pan: number | null
  /** Capture time of the frame that caused this alert. Staleness is measured from here. */
  frameTimeMs: number
  /** When the policy created the alert. */
  createdTimeMs: number
}

export type HealthStatus = 'healthy' | 'degraded' | 'stopped'

export type HealthIssue =
  | 'stalled'
  | 'low-fps'
  | 'low-light'
  | 'phone-lowered'
  | 'no-camera'
  | 'no-orientation'
  | 'audio-blocked'
  | 'worker-error'

export interface HealthState {
  status: HealthStatus
  /** Empty when healthy. */
  issues: HealthIssue[]
  /** Detection rate over the recent window. */
  fps: number
  /** Time since the last FrameResult. */
  lastFrameAgeMs: number
  backend: InferenceBackend | null
  /** True while the user has paused detection. */
  paused: boolean
  updatedTimeMs: number
}

/** User settings and calibration, persisted on the device. */
export interface Settings {
  /** Distance from the floor to the phone camera, in meters. */
  eyeHeightM: number
  /** Horizontal field of view of the rear camera in landscape, in degrees. */
  horizontalFovDeg: number
  /** Speech rate multiplier, 1 is normal. */
  speechRate: number
  /** Master switch for spoken feedback; tones and heartbeat stay on. */
  spokenFeedback: boolean
  /** Output volume for tones, 0 to 1. */
  toneVolume: number
  /** Output volume for the heartbeat tick, 0 to 1. */
  heartbeatVolume: number
  /** Records telemetry and shows the debug overlay. */
  testMode: boolean
}

export type VoiceIntent =
  | 'whats-around'
  | 'pause'
  | 'resume'
  | 'repeat'
  | 'slower'
  | 'faster'
  | 'help'
  /** Stretch (S6). */
  | 'describe'
  | 'unknown'

/** What happened to an alert on its way to the speaker. */
export type AlertOutcome =
  | 'queued'
  | 'started'
  | 'finished'
  | 'preempted'
  | 'dropped-stale'
  | 'dropped-track-gone'

/** Field-test log entries, one JSON object per line when exported. */
export type TelemetryEvent =
  | {
      kind: 'session'
      timeMs: number
      userAgent: string
      backend: InferenceBackend | null
      inputSize: number
      crossOriginIsolated: boolean
      settings: Settings
    }
  | {
      kind: 'frame'
      timeMs: number
      frameId: number
      timings: FrameTimings
      captureTimeMs: number
      fps: number
      /** Capture time to the end of the pipeline for this frame. */
      pipelineMs: number
      /** Inputs the replay tool needs to re-run tracking, geometry, and alert policy offline. */
      detections: Detection[]
      orientation: OrientationSample | null
    }
  | { kind: 'tracks'; timeMs: number; frameId: number; tracks: Track[] }
  | { kind: 'alert'; timeMs: number; alert: AlertEvent; outcome: AlertOutcome; latencyMs: number | null }
  | { kind: 'health'; timeMs: number; health: HealthState }
  | { kind: 'voice'; timeMs: number; intent: VoiceIntent; source: 'speech' | 'tap-fallback' | 'long-press' }
  | { kind: 'error'; timeMs: number; source: string; message: string }

/** Topics and payloads on the event bus (alerts/bus.ts). */
export interface EventMap {
  frame: FrameResult
  tracks: Track[]
  alert: AlertEvent
  alertOutcome: { alert: AlertEvent; outcome: AlertOutcome; timeMs: number }
  health: HealthState
  voice: VoiceIntent
  settings: Settings
  telemetry: TelemetryEvent
}
