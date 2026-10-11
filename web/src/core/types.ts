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
  /** The free-space path stage (R7), on the frames where it ran. */
  pathMs?: number
}

/** The free-space path for one frame (R7, FR-28): a walking line through open floor, in image space. */
export interface FreeSpaceResult {
  /** The line from the bottom of the frame up, in 0 to 1 coordinates of the full frame (y points down). Empty: no path. */
  points: { x: number; y: number }[]
  /** The point on the line used for the turn decision, or null. */
  lookahead: { x: number; y: number } | null
  /** Which way the line goes ahead; 'none' when there is no open path. */
  decision: 'left' | 'right' | 'straight' | 'none'
  /** The size the frame was analysed at, and the first analysed row in those pixels. */
  processWidth: number
  processHeight: number
  roiStartRow: number
  /** Open floor connected to the user (1) or not (0): processWidth x (processHeight - roiStartRow), row-major. */
  freeMask: Uint8Array
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
  /** Present on the frames where the path stage ran (every few frames, only while Find or ?debug asks for it). */
  freeSpace?: FreeSpaceResult
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
  /** Raw distance candidates, kept for tuning and the debug overlay. Null when not computable. */
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
  /**
   * Where the rear camera points on the ground, in degrees clockwise like a compass, unwrapped (turning right
   * through north keeps counting up) and lightly smoothed. Its zero is arbitrary on iOS, so only differences
   * mean anything. Absent when the device sends no alpha or the camera looks straight up or down.
   */
  headingDeg?: number
  timeMs: number
}

export type AlertPriority = 'urgent' | 'normal' | 'info'

/** What the alert is about. Only "obstacle" alerts carry a track; Find guidance (R5) adds its own kinds. */
export type AlertKind = 'obstacle' | 'summary' | 'health' | 'status' | 'help' | 'find'

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
  /** When the alert was created. */
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
}

export type VoiceIntent =
  | 'find'
  | 'stop'
  | 'pause'
  | 'resume'
  | 'slower'
  | 'faster'
  | 'help'
  | 'unknown'

/** What happened to an alert on its way to the speaker. */
export type AlertOutcome =
  | 'queued'
  | 'started'
  | 'finished'
  | 'preempted'
  | 'dropped-stale'
  | 'dropped-track-gone'

/** Where Find is: the controller's state (find/findController.ts). */
export type FindStateName =
  | 'idle'
  | 'checking' // one locate call with the current frame is out
  | 'sweeping' // the user is turning while frames are captured
  | 'sweepChecking' // the sweep frames are out in one locate call
  | 'guiding' // the target's direction is known and being followed
  | 'lost' // the target could not be re-confirmed; a new sweep starts
  | 'arrived'
  | 'notFound'
  | 'error'

/** What the Find screen and the status line show; published on the bus as `find` whenever it changes. */
export interface FindSnapshot {
  state: FindStateName
  /** The thing being looked for, as the user named it; null when idle. */
  target: string | null
  /** Degrees to turn to face it, positive to the right; null when not guiding or no heading. */
  bearingDeg: number | null
  /** Estimated distance in meters, or null. */
  distanceM: number | null
  /** The distance is only an upper bound (the target's base is out of the frame), so it must not be shown as measured. */
  distanceIsBound: boolean
  /** Who found it: the Gemini locate call or the on-device detector. */
  source: 'gemini' | 'yolo' | null
  /** How many sweep frames have been taken so far (0 outside a sweep). */
  sweepFrames: number
}

/** A request to start looking for something: from a voice command or the quick-pick list. */
export interface FindRequest {
  target: string
  source: 'voice' | 'list'
}

/** Topics and payloads on the event bus (alerts/bus.ts). */
export interface EventMap {
  frame: FrameResult
  tracks: Track[]
  alert: AlertEvent
  alertOutcome: { alert: AlertEvent; outcome: AlertOutcome; timeMs: number }
  health: HealthState
  voice: VoiceIntent
  settings: Settings
  findRequest: FindRequest
  findCancel: undefined
  find: FindSnapshot
  /** A free-space path result (R7); the mask buffer is shared, so listeners must not change it. */
  path: FreeSpaceResult
}

// Find: the contract of POST /api/locate (web/api/locate.ts), shared by the function and the client (FR-22).
// The function imports these as types only, so nothing from src/ is bundled into it.

/** One camera frame for a locate request: base64 JPEG (no "data:" prefix), and the phone's heading and pitch when it was taken. */
export interface LocateFrame {
  jpeg: string
  /** Gyroscope yaw in degrees, relative to where Find started (R3). */
  heading: number
  /** Pitch in degrees, as the orientation sensor reports it. */
  pitch: number
}

/** What the app sends: the target's name and one to eight frames, in capture order. */
export interface LocateRequest {
  target: string
  frames: LocateFrame[]
}

/** A box in a frame, as fractions of the frame (0 to 1) from the top-left corner. */
export interface LocateBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** What comes back when the request worked. Not found is a normal answer (found false), not an error. */
export interface LocateResult {
  found: boolean
  /** The frame that shows the target best; null when not found. */
  frameIndex: number | null
  box: LocateBox | null
  label: string
  /** True when the target's bottom edge rests on the floor, so its distance can be trusted more. */
  onFloor: boolean
  /** Gemini's rough guess in meters, or null. A hint, never a measurement. */
  distanceM: number | null
  confidence: number
  /** Sign text pointing toward the target, for example "EXIT ->", or null. */
  signHint: string | null
  /** How long the function took, in milliseconds. */
  latencyMs: number
}

export type LocateErrorCode =
  | 'bad_request' // the request was malformed or over the limits
  | 'timeout' // Gemini (or the app waiting for the function) took too long
  | 'quota' // the free tier is out of requests for now (HTTP 429)
  | 'auth' // no key, a refused key, or a model that is not available
  | 'bad_response' // Gemini answered with something we cannot use
  | 'network' // a connection failed, or Gemini was unavailable

/** The JSON body of a failed request. The message is for the developer; the app speaks its own sentence. */
export interface LocateErrorBody {
  error: LocateErrorCode
  message: string
}
