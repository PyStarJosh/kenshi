// Every tunable number lives here. Tuning changes only this file.
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
    // A frame is accepted once this fraction of the minimum gap has passed, so camera timing jitter
    // does not cost a whole frame (30 fps camera, 15 fps cap). FR-1, NFR-1
    frameGapTolerance: 0.9,
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
    // Which provider the live app asks for: "auto" tries WebGPU, then WebAssembly. NFR-1
    provider: 'auto' as 'auto' | 'webgpu' | 'wasm',
    // Consecutive failed frames after which the live loop stops and says so. FR-14, SR-8
    maxConsecutiveErrors: 5,
  },

  debug: {
    // Frames kept for the overlay's inference percentiles. FR-19
    statsSamples: 60,
    // Alerts kept for the latency percentiles in the debug panel.
    latencySamples: 200,
    // How often the overlay's session clock redraws. FR-19
    clockUpdateMs: 100,
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
    // Exponential smoothing factor for the horizontal angle. FR-4
    angleSmoothing: 0.4,
    // Smoothing factors are per frame at this frame period; other periods are scaled from it,
    // so a changing frame rate does not change how fast the tracker follows. FR-4, NFR-1
    smoothingRefMs: 67,
    // A new track nearer than this and at least this confident is confirmed on its first match. FR-4
    nearConfirmDistanceM: 2,
    nearConfirmConfidence: 0.7,
    // Boxes whose longer side is below this (normalized) may match by center distance when IoU fails;
    // the centers must be within this many longer sides of each other. FR-4
    smallBoxMaxSide: 0.12,
    smallBoxCenterFactor: 1,
    // Motion needs at least this many samples spanning at least half the closing speed window. FR-5
    minMotionSamples: 3,
    // Box height growth (per second) below this gives no time-to-contact in the height fallback. FR-5
    minHeightGrowthPerS: 0.05,
    // Time-to-contact must stay below the limit this long before a track counts as approaching. FR-5, NFR-6
    approachHoldMs: 300,
  },

  geometry: {
    // Default height of the phone camera above the floor; the user can change it. FR-7, FR-17
    defaultEyeHeightM: 1.6,
    // Default horizontal field of view of the rear camera in landscape; calibration replaces it. FR-6, FR-17
    defaultHorizontalFovDeg: 65,
    // Accepted range for the eye height setting, in meters. FR-17
    minEyeHeightM: 0.8,
    maxEyeHeightM: 2.2,
    // Accepted range for the horizontal field of view setting and for a calibration result. FR-17
    minFovDeg: 30,
    maxFovDeg: 120,
    // Horizontal angle within which an object is read as 12 o'clock; beyond it, 1 or 11. FR-6
    clockCenterDeg: 15,
    // A box counts as touching a frame edge when it is this close to it (normalized 0..1);
    // a box touching the left or right edge is read as "far left" or "far right". FR-6, FR-7
    edgeTouchMargin: 0.02,
    // Ray must point at least this far below the horizon for the ground-plane distance to apply. FR-7
    minDepressionDeg: 3,
    // Distances outside this range are discarded as implausible. FR-7
    minValidDistanceM: 0.3,
    maxValidDistanceM: 10,
    // An object whose top edge is at or below this height counts as "on the floor". FR-8
    floorTopMaxM: 0.5,
    // An object whose bottom edge is between these heights counts as "at head height";
    // above the upper one it passes over the head and gets no label. FR-8
    headBottomMinM: 1.2,
    headBottomMaxM: 2,
    // Walking corridor: half width either side of center, and depth ahead. FR-9
    corridorHalfWidthM: 0.5,
    corridorDepthM: 4,
    // Wider corridor used to judge approaching objects. FR-5, FR-9
    approachHalfWidthM: 1,
  },

  orientation: {
    // Smoothing factor for pitch and roll, 0..1 (higher follows the sensor faster). FR-3
    smoothing: 0.25,
    // How long past readings are kept, so a frame can be paired with the tilt at its capture time. FR-3
    historyMs: 1000,
    // A reading that arrives after the requested time is used only if within this gap. FR-3
    maxSampleGapMs: 250,
    // Orientation holds until it changes, so a reading counts for this long; older means the sensor
    // stopped. A still iPhone keeps sending events, so this is generous. FR-3, FR-14
    staleAfterMs: 2000,
    // No reading within this time after starting means the tilt sensor is unavailable. FR-3
    noDataTimeoutMs: 1500,
  },

  settings: {
    // Starting values for settings that have no other home in this file. FR-17
    speechRate: 1,
    toneVolume: 0.8,
    heartbeatVolume: 0.3,
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
    // Minimum time before re-announcing a track whose clock position changed. An unchanged object is
    // announced once, never repeated on a timer. FR-10
    clockChangeCooldownMs: 3000,
    // Minimum silence between two spoken alerts (urgent alerts ignore it). FR-10
    minGapMs: 800,
    // Normal alerts waiting behind the current one; extra ones are held back or dropped. FR-10
    maxQueuedAlerts: 2,
    // An alert counts as finished this long after it was sent even if the audio engine never reports
    // back, so a missing report cannot silence every later alert. FR-10, SR-1
    inFlightTimeoutMs: 8000,
    // An alert older than this, measured from its frame capture, is dropped unspoken. SR-3, NFR-4
    staleLimitMs: 1000,
    // Horizontal angle (degrees from straight ahead) at which the tone is panned fully left or right. FR-12
    panFullAngleDeg: 30,
    // Most objects listed by "what's around me", nearest first, and the farthest one it will mention. FR-15
    summaryMaxItems: 5,
    summaryMaxDistanceM: 6,
  },

  audio: {
    // Gap between the lead-in tone and the phrase. FR-12, NFR-4
    toneToSpeechGapMs: 80,
    // Length of the directional lead-in tone. FR-12
    toneDurationMs: 120,
    // Frequencies of the normal and urgent tones. FR-12
    normalToneHz: 660,
    urgentToneHz: 990,
    // Info tone: lower and softer than the normal tone. FR-12
    infoToneHz: 440,
    infoToneGain: 0.5,
    // Urgent tone: this many short pulses; the gap between them shrinks from max (at urgentDistanceM)
    // to min (at urgentPulseNearM or closer), so closer hazards pulse faster. FR-12, SR-4
    urgentPulseCount: 3,
    urgentPulseMs: 60,
    urgentPulseGapMinMs: 30,
    urgentPulseGapMaxMs: 120,
    urgentPulseNearM: 0.5,
    // Health warning: two falling tones, centered. FR-14, SR-5
    warningToneHz: [880, 587],
    warningToneMs: 150,
    // Tones are scheduled this far ahead on the audio clock so they start cleanly. NFR-3
    toneLookaheadMs: 10,
    // Heartbeat tick interval while healthy. FR-13, SR-1
    heartbeatIntervalMs: 2000,
    // Heartbeat tick: a short soft click, centered. FR-13
    heartbeatToneHz: 1200,
    heartbeatToneMs: 25,
    // How often the heartbeat and health checks run on the main thread. FR-13, FR-14
    checkIntervalMs: 250,
    // If speech never reports its end (an iOS bug), it is treated as finished after
    // base + per-character time, so the heartbeat and later alerts never stay blocked. SR-1
    speechWatchdogBaseMs: 3000,
    speechWatchdogPerCharMs: 120,
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
    // A press held this long is a long press (pause or resume). FR-16
    longPressMs: 1000,
    // Taps closer together than this count as one, so a tap never fires twice. FR-16
    tapDebounceMs: 400,
    // Earcons: a rising pair when listening starts, a falling pair when it stops. FR-15
    earconHz: [523, 784],
    earconNoteMs: 70,
  },
}

export type Config = typeof CONFIG
