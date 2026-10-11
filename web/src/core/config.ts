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

  // The free-space path (R7, FR-28): a walking line through open floor found from edges in a small grayscale copy of the
  // frame, in the detection worker. The numbers under "path" are those of the teammate's script (tuned at 640 px wide).
  freeSpace: {
    // The frame is analysed at this width (the height keeps the aspect ratio). Cost grows with the pixel count.
    processWidth: 320,
    // The path is computed on one frame in this many. If detection p95 goes past the SDS budget, raise this to 5.
    everyNthFrame: 3,
    // The decision handed to guidance is the most common one in this many recent results, so it does not flap.
    decisionHistory: 5,
    // A path result older than this is not shown or used.
    maxAgeMs: 1_500,
    // The overlay: free floor tinted green at this opacity, the line drawn this many pixels wide.
    overlayOpacity: 0.35,
    overlayLineWidthPx: 4,
    path: {
      roiStartFrac: 0.4,
      horizonMarginFrac: 0.05,
      cannyLow: 60,
      cannyHigh: 140,
      referenceWidth: 640,
      dilateKernel: 7,
      closeKernel: 17,
      openKernel: 7,
      rowStep: 12,
      bottomBandRows: 8,
      minGapFrac: 0.08,
      smoothWindow: 5,
      lookaheadFrac: 0.35,
      turnDeadbandFrac: 0.08,
      targetClearanceFrac: 0.25,
    },
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
    // Smoothing factor for the camera heading, 0..1. Lighter than pitch so a quick turn is not lagged. Starting
    // value; to be measured on the phone. FR-24
    headingSmoothing: 0.4,
    // Past this pitch up or down the camera's direction on the ground is too uncertain, and the last heading is
    // held. FR-24
    headingMaxPitchDeg: 75,
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

  // What the audio engine and the tracker still read from the old alert policy. The detector no longer
  // announces objects, so the band, cooldown, queue, and summary settings were removed.
  alerts: {
    // Distances are rounded to this step. FR-11
    roundToM: 0.5,
    // Urgent tone pulses are spaced by distance, from this far (slowest) inward. FR-12, SR-4
    urgentDistanceM: 1.5,
    // Closing speed needed to count as approaching. FR-5
    approachMinSpeedMps: 0.5,
    // Time-to-contact limit for flagging an approaching object. FR-5
    approachMaxTtcS: 4,
    // An alert older than this, measured from its frame capture, is dropped unspoken. SR-3, NFR-4
    staleLimitMs: 1000,
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
    // After the speech engine is cancelled, wait this long before starting the next phrase: on iOS a speak() right after
    // a cancel() can be dropped, or leave the old phrase audible under the new one. FR-14, SR-4
    speechAfterCancelMs: 90,
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

  find: {
    // Frames per request: one for a look, up to eight for a scan sweep. FR-22, FR-23
    maxFrames: 8,
    // Width of a frame sent to Gemini, in pixels (height keeps the aspect). Starting value; to be measured. FR-22, NFR-14
    imageWidthPx: 720,
    // JPEG quality (0 to 1) for those frames. Raised from 0.7 and 640 px (owner request): a frame is about 50% larger
    // (36 KB to 54 KB for the test photo) with no added delay seen in four calls. Starting value; to be measured. NFR-14
    jpegQuality: 0.8,
    // Limits web/api/locate.ts enforces (a test keeps them equal to these): one base64 frame, the whole body
    // (Vercel allows 4.5 MB), the target name, and the largest heading and pitch magnitudes in degrees. FR-22
    maxFrameChars: 600_000,
    maxBodyChars: 4_000_000,
    maxTargetChars: 60,
    maxHeadingDeg: 3600,
    maxPitchDeg: 180,
    // The function gives up on Gemini after this long (owner spec), and the app gives up on the function a little
    // later, so the function's own error arrives first. FR-22, NFR-14
    geminiTimeoutMs: 8_000,
    requestTimeoutMs: 14_000,
    // An answer below this confidence counts as not found. Starting value; to be measured. SR-11
    minConfidence: 0.6,
    // A remembered target direction is dropped after this long: a gyroscope heading drifts and has no north
    // reference. Starting value; how fast it drifts is to be measured on the phone. FR-24
    memoryMaxAgeMs: 60_000,
    // The free tier is small: at least this long between two requests, and at most this many in any 60 seconds.
    // Owner defaults; to be measured against the real limits. FR-22
    // The gap applies to the first check and the guiding re-checks; the sweep's per-frame looks and the pause look
    // skip it (they are the point of a sweep) but still count toward the per-minute cap and the concurrency cap.
    minGapMs: 6_000,
    maxPerMinute: 12,
    // Looks allowed in flight at once (a sweep frame every ~1.5 s with answers taking 2 to 4 s).
    maxConcurrentCalls: 4,

    // ---- Find controller (R4). Every value below is a starting value; to be measured on the phone. FR-23, FR-25 ----
    // The sweep takes a frame each time the heading has turned this far, up to maxFrames frames or this much turn.
    sweepStepDeg: 45,
    sweepFullTurnDeg: 360,
    // A turn of at least this much since the last check counts as the user still turning.
    sweepProgressDeg: 3,
    // No turning for this long: remind once. Still none after sweepGiveUpMs: send what there is, or give up.
    sweepReminderMs: 4_000,
    sweepGiveUpMs: 15_000,
    // Holding still this long during the sweep, after turning at least sweepDwellMinTurnDeg since the last look,
    // takes one fresh look at once instead of waiting for the full turn: this is what staring at a target does.
    sweepDwellMs: 1_500,
    sweepDwellMinTurnDeg: 20,
    // Arrived: the target is this near and within this angle of straight ahead. Things you should not walk into get it
    // earlier (owner request): stairs (and steps, escalators) at arrivalStairsM, doors, exits, elevators and restrooms at
    // arrivalDoorM. FR-25
    arrivalDistanceM: 1.0,
    arrivalStairsM: 2.0,
    arrivalDoorM: 1.5,
    arrivalAngleDeg: 20,
    // While guiding, ask Gemini again no sooner than this when the target should be in view, and call it lost after
    // this many answers that do not find it.
    recheckIntervalMs: 6_000,
    lostAfterFailedRechecks: 2,
    // Within nearRecheckM of the target the re-check comes every nearRecheckIntervalMs instead (a look that skips the
    // minimum gap but still counts toward the per-minute cap), so "within reach" works from a fresher distance. FR-25
    nearRecheckM: 3,
    nearRecheckIntervalMs: 3_000,
    // Arrived, not found, and error go back to idle after this long.
    resultHoldMs: 3_000,
    // While waiting on a search the user hears something at least this often.
    feedbackMaxGapMs: 5_000,
    // A spoken direction change waits at least this long after the previous direction phrase.
    guideSpeechCooldownMs: 2_500,
    // Direction words: ahead within directionAheadDeg, slightly left or right up to directionSlightDeg, to your
    // left or right up to directionBehindDeg, behind you beyond that.
    directionAheadDeg: 15,
    directionSlightDeg: 45,
    directionBehindDeg: 135,
    // Find speech that waits behind other speech is dropped after this long (a direction this old is wrong). SR-3
    speechStaleMs: 6_000,

    // ---- Reliability (R4 follow-up). Starting values; to be measured on the phone. ----
    // Arrival must hold this long before it is announced, so one noisy reading cannot trigger it.
    arrivalHoldMs: 600,
    // When the target's base is out of the bottom of the frame its distance is only an upper bound (the nearest floor
    // in view), so "within reach" is judged against this larger distance instead.
    arrivalClippedM: 1.75,
    // A target last seen cut off at the bottom, now ahead and unseen, is probably just below the view: re-checks that
    // fail are not held against it for this long, and the user is asked to tilt the phone down.
    belowViewAngleDeg: 30,
    belowViewMaxMs: 6_000,
    // Tilting down to about this pitch or steeper puts the floor near the user in view (and gives a real distance).
    tiltPitchDeg: -25,
    tiltPromptCooldownMs: 8_000,
    tiltPromptMax: 2,
    // Stick to the first one: a later sighting or Gemini answer is taken to be the same object only if it lies within
    // this many degrees of where the object is remembered (more when it is close, where walking moves its bearing a lot).
    // Anything outside is another object of the same kind and is ignored.
    sameObjectDeg: 35,
    sameObjectNearDeg: 55,
    sameObjectNearM: 2.5,
    // The detector must lose a followed target for this long before it counts as lost or another object is followed.
    yoloLostMs: 1_000,
    // Another detector track is taken for a lost one only if it lies within reacquireDeg of where the object was and,
    // when both distances are known, within reacquireDistanceFrac of its distance (at least reacquireDistanceMinM); and
    // never while the object has probably just slipped below the view. Stick to the closest one (owner request).
    reacquireDeg: 20,
    reacquireDistanceFrac: 0.4,
    reacquireDistanceMinM: 1,
    // A target Gemini found is handed to the detector when a detector track of its kind lies within handoffDeg of it,
    // so from then on it is followed frame by frame.
    handoffDeg: 10,
    // A direction word changes only when the bearing is this far past its boundary, so it does not flap.
    directionHysteresisDeg: 5,
    // Automatic retries of the first check after a transient failure (network, timeout, unusable reply).
    checkRetryMax: 1,

    // The path line (R7) is used for "around the obstacle" only while the target is within this many degrees of straight ahead.
    pathAlignedDeg: 20,

    // ---- The Find screen (R6). FR-27 ----
    // The whole background turns green inside alignedEnterDeg of straight ahead, and stays green until the bearing passes
    // alignedExitDeg, so it does not flicker at the edge.
    alignedEnterDeg: 15,
    alignedExitDeg: 20,
    // The "Found: Exit" screen stays up this long before the guiding view.
    foundScreenMs: 1_500,

    // ---- Guidance (R5). Starting values; to be measured on the phone. FR-25 ----
    // An instruction that asks the user to do something (turn, bear, go around) is said again this often until they do.
    guidanceRepeatMs: 5_000,
    // Distance in words (owner request): close within distanceCloseM, near within distanceNearM, far beyond. The word is
    // spoken when the target comes into a nearer one while roughly facing it, and shown on the Find screen instead of
    // meters. A word is said again only after the user has moved back out beyond it by bandResetM. FR-25, FR-27
    distanceCloseM: 2,
    distanceNearM: 5,
    bandResetM: 0.5,
  },

  // The beacon (R5, FR-26): short pulses while guiding. All starting values; to be measured on the phone with AirPods.
  beacon: {
    // Time between pulses: slowest at beaconFarM or farther (or an unknown distance), fastest at beaconNearM or nearer;
    // between them it follows a curve: t = (distance - near) / (far - near) raised to beaconCurve (1 is a straight
    // line, above 1 speeds up more late). FR-26
    farM: 10,
    nearM: 1,
    maxIntervalMs: 1000,
    minIntervalMs: 150,
    curve: 1,
    // Pitch: higher when facing the target (within alignedDeg), a plain one off to the side, and a low double pulse when
    // it is behind (more than behindDeg off), because stereo alone cannot tell front from back.
    alignedHz: 880,
    frontHz: 660,
    behindHz: 330,
    alignedDeg: 15,
    behindDeg: 90,
    pulseMs: 60,
    behindGapMs: 110,
    // Loudness as a share of the tone volume setting, and how much of it is left while speech is playing.
    gain: 0.5,
    duckGain: 0.2,
    // The scheduler wakes this often and schedules pulses up to lookaheadMs ahead on the audio clock.
    tickMs: 25,
    lookaheadMs: 120,
    // Arrival chime: a short rising three-note phrase.
    chimeHz: [523.25, 659.25, 783.99] as readonly number[],
    chimeNoteMs: 110,
  },
}

export type Config = typeof CONFIG
