// Every tunable number lives here. Field-test tuning changes only this file.
// Each value names the requirement it serves (docs/SRS.md). Values are starting points, not yet tuned.
// Times are milliseconds, distances meters, angles degrees, speeds meters per second.

export const CONFIG = {
  camera: {
    // Requested capture size in landscape. FR-1
    width: 1280,
    height: 720,
  },

  detection: {
    // Square model input size in pixels, 320 or 416; Gate A chose 416. Selects models/yolo26n-<size>.onnx. NFR-1, NFR-2
    inputSize: 416,
    // Cap on the detection rate to protect battery and heat; the scheduler never queues frames. FR-1, NFR-10
    maxFps: 15,
    // Confidence needed to keep a detection, per class label; "default" covers the rest. NFR-5, NFR-6
    confidenceThreshold: {
      default: 0.45,
      person: 0.4,
      stairs: 0.4,
      curb: 0.4,
      pole: 0.4,
      door: 0.45,
    } as Record<string, number>,
    // Same-class boxes overlapping more than this are merged by non-max suppression. NFR-6
    nmsIou: 0.45,
    // Cap on WebAssembly threads when cross-origin isolated. NFR-1, NFR-2
    maxWasmThreads: 4,
  },

  benchmark: {
    // Benchmark screen (?bench): untimed warm-up inferences, then timed ones. NFR-1, NFR-2
    warmupRuns: 10,
    timedRuns: 50,
  },

  tracking: {
    // Minimum IoU for a detection to match an existing track of the same class. FR-4
    matchIou: 0.3,
    // Matched frames needed, out of the last confirmationWindow, to confirm a track. FR-4
    confirmationHits: 2,
    confirmationWindow: 3,
    // Consecutive misses that delete a tentative track. FR-4, NFR-6
    tentativeMaxMisses: 2,
    // A confirmed track unmatched this long is deleted. FR-4
    lostAfterMs: 800,
    // Exponential smoothing factor for box position and size, 0..1 (higher follows faster). FR-4
    boxSmoothing: 0.5,
    // Exponential smoothing factor for distance. FR-4, NFR-7
    distanceSmoothing: 0.4,
    // Exponential smoothing factor for closing speed. FR-5
    closingSpeedSmoothing: 0.3,
    // History window used to measure closing speed. FR-5
    closingSpeedWindowMs: 500,
  },

  geometry: {
    // Default height of the phone camera above the floor; the user can change it. FR-7, FR-17
    defaultEyeHeightM: 1.6,
    // Default horizontal field of view of the rear camera in landscape; calibration replaces it. FR-6, FR-17
    defaultHorizontalFovDeg: 65,
    // Horizontal angle within which an object is read as 12 o'clock. FR-6
    clockCenterDeg: 10,
    // Horizontal angle where 11 and 1 o'clock end and far left/right begin. FR-6
    clockEdgeDeg: 25,
    // Ray must point at least this far below the horizon for the ground-plane distance to apply. FR-7
    minDepressionDeg: 3,
    // Boxes whose bottom edge is below this normalized y are treated as cut off by the frame. FR-7
    truncatedBottomY: 0.98,
    // Distances outside this range are discarded as implausible. FR-7
    minValidDistanceM: 0.3,
    maxValidDistanceM: 10,
    // An object whose top edge is at or below this height counts as "on the floor". FR-8
    floorTopMaxM: 0.6,
    // An object whose bottom edge is between these fractions of eye height counts as "at head height". FR-8
    headBottomMinFraction: 0.6,
    headBottomMaxFraction: 1.1,
    // Walking corridor: half width either side of center, and depth ahead. FR-9
    corridorHalfWidthM: 0.5,
    corridorDepthM: 4,
    // Wider corridor used to judge approaching objects. FR-5, FR-9
    approachHalfWidthM: 1,
  },

  alerts: {
    // Distance bands in meters (upper edges); entering a closer band can trigger a new announcement. FR-10
    distanceBandsM: [1.5, 3, 4],
    // Distances are spoken rounded to this step. FR-11
    roundToM: 0.5,
    // Urgent when an in-path object is this close, or closer. FR-10, SR-4
    urgentDistanceM: 1.5,
    // Urgent when time-to-contact is at or below this. FR-5, FR-10, SR-4
    urgentTtcS: 2,
    // Closing speed needed to count as approaching. FR-5
    approachMinSpeedMps: 0.5,
    // Time-to-contact limit for announcing an approaching object. FR-5, FR-10
    approachMaxTtcS: 4,
    // Minimum time between urgent alerts about the same track. FR-10
    urgentCooldownMs: 2000,
    // Minimum time before re-announcing a track that entered a closer band. FR-10
    closerBandCooldownMs: 1500,
    // Minimum time before repeating an unchanged in-path track. FR-10
    repeatCooldownMs: 10000,
    // Minimum silence between two spoken alerts (urgent alerts ignore it). FR-10
    minGapMs: 800,
    // Normal alerts waiting behind the current one; extra ones are dropped. FR-10
    maxQueuedAlerts: 2,
    // An alert older than this, measured from its frame capture, is dropped unspoken. SR-3, NFR-4
    staleLimitMs: 1000,
    // Objects listed by "what's around me". FR-15
    summaryMaxItems: 3,
  },

  audio: {
    // Gap between the lead-in tone and the phrase. FR-12, NFR-4
    toneToSpeechGapMs: 80,
    // Length of the directional lead-in tone. FR-12
    toneDurationMs: 120,
    // Frequencies of the normal and urgent tones. FR-12
    normalToneHz: 660,
    urgentToneHz: 990,
    // Heartbeat tick interval while healthy. FR-13, SR-1
    heartbeatIntervalMs: 2000,
    // Reminder interval while paused, so silence never reads as clear. SR-9
    pausedReminderIntervalMs: 15000,
    // Speech rate bounds and the step used by "slower" and "faster". FR-15, FR-17
    speechRateMin: 0.6,
    speechRateMax: 1.8,
    speechRateStep: 0.2,
  },

  health: {
    // No FrameResult for this long means detection has stalled. FR-14, SR-5
    stalledAfterMs: 1500,
    // Detection rate below this, averaged over fpsWindowMs, is a warning. FR-14, NFR-1
    lowFpsThreshold: 5,
    fpsWindowMs: 3000,
    // Mean frame brightness (0..1) below this for lowLightHoldMs is a low-light warning. FR-14, SR-5
    lowLightLuma: 0.12,
    lowLightHoldMs: 2000,
    // Camera pitch outside this range for phoneLoweredHoldMs means the phone is lowered or raised. FR-14, SR-6
    phoneLoweredPitchDeg: -35,
    phoneRaisedPitchDeg: 50,
    phoneLoweredHoldMs: 1000,
    // Time of good readings needed before a warning clears. FR-14
    recoverAfterMs: 2000,
    // A standing warning repeats at this interval until fixed. FR-14, SR-5
    warningRepeatMs: 10000,
  },

  voice: {
    // Longest wait for a spoken command after a tap before the tap fallback runs. FR-15, FR-16
    listenTimeoutMs: 4000,
    // A press at least this long is a long press (pause or resume). FR-16
    longPressMs: 600,
  },

  telemetry: {
    // Log one frame entry out of this many; 1 logs every frame. FR-19
    frameLogEvery: 1,
    // Cap on buffered entries before the oldest are dropped. FR-19, NFR-10
    maxBufferedEntries: 50000,
  },

  describe: {
    // Stretch (S6): longest side of the single frame sent for "describe", in pixels. FR-20
    maxImageSidePx: 768,
    // Stretch (S6): give up on the describe request after this long. FR-20
    timeoutMs: 8000,
  },
}

export type Config = typeof CONFIG
