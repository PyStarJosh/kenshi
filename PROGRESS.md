# PROGRESS

Edit only your own track's section. Keep this file under 80 lines.

## Shared
**Works:** S1 skeleton (uv project, Vite app, private GitHub repo). S2 done: docs/SRS.md (20 FR, 13 NFR, 9 SR), docs/SDS.md, web/src/core/types.ts, web/src/core/config.ts.
**Broken:** nothing known.
**Next:** tracks start A1, U1, M1 in parallel against types.ts and config.ts. Then S3 integration (Gate B).

## App
**Works:** A1 detection worker + engine + ?bench (desktop numbers in SDS 4.1). A2 live loop (camera, frame loop, ?debug overlay, pause/resume/page hide); the owner ran it on an iOS 27 iPhone with WebGPU and boxes appeared. A3 geometry: tilt sensor (permission in the Start tap, pitch/roll for either landscape direction and upright), geometry.ts (clock, ground-plane and box-size distance, floor/head height, path), Settings (eye height) and Calibrate field of view, and per-box direction, distance, method, height, plus pitch/roll, in ?debug. Checked in desktop Edge 155 with simulated tilt: pitch/roll readouts match hand-computed values; settings and calibration save and reach the overlay.
A4 tracking: tracking/tracker.ts (IoU matching with a small-box center fallback, confirmation, deletion, smoothing of box, distance, and angle), timeToContact.ts (closing speed and height-growth fallback, approach hold), smoothing.ts; 14 synthetic-sequence tests (walking at 1.2 m/s, false detection, crossing people, deletion, frame-rate jitter, shake); ?debug boxes show id, state, time to contact. Not wired into the live pipeline until A5.
**Broken:** nothing known. Not yet checked on the iPhone: the signs of pitch and roll (tilt down must read negative pitch), real distances against a tape measure, the calibration on the demo phone. No iPhone benchmark numbers in the docs yet.
**Next:** run the A3 phone checklist, calibrate the demo phone and record its field of view, add iPhone numbers to SDS 4.1, then A5 alert policy (also wires Tracker into app/pipeline.ts). Test mode (U3) will also turn on the overlay; for now it is ?debug only.

## Audio/UX
**Works:** U1 audio engine and health monitor. Start unlocks the AudioContext and speech in the tap and says the greeting. Panned lead-in tones (urgent pulses faster when closer), one phrase at a time with urgent preemption, stale and track-gone drops before any sound, heartbeat tick while healthy and quiet. Health monitor warns at once on stall, low fps, low light, phone lowered or raised, and blocked audio, repeats every 10 s, and says "Detection back." once. ?debug shows an audio test panel (sample alerts, health warnings, heartbeat without camera, alert-to-tone and frame-to-speech delays). Unit tests cover pan, pulse rate, speech queue, voice choice, heartbeat, and health transitions.
**Broken:** nothing known. Not yet heard on the iPhone; the U1 phone checklist (AirPods stereo, urgent preemption, heartbeat level, low light, lowered phone) is open.
**Next:** run the U1 phone checklist, record iOS tone and speech-start latency in SDS 4. Then U2 voice commands. Open for later steps: the paused reminder (SR-9) and speaking session status messages (U3); real track lookup and AlertEvents arrive with A4/A5 and the event bus.

## Model
**Works:** M1 done. YOLO26n exported at 320 and 416 (web/public/models/yolo26n-<size>.onnx, 9.8 MB each, input [1,3,S,S], output [1,84,N], details in SDS 4.1). Class map: ml/class_map.json -> web/src/detection/classes.ts via ml/gen_classes.py. export_onnx.py deletes weights it downloaded. ml/check_onnx.py runs the 416 model in onnxruntime: bus.jpg gives bus 0.89 and 3 persons (0.85, 0.80, 0.75); zidane.jpg gives 2 persons (0.88).
**Broken:** nothing known. Disk was full on the dev laptop, so the export was not re-run in this step; the committed ONNX files come from A1.
**Next:** M2 hazard dataset and training (stairs, curb, pole, door as ids 80 to 83).

## Decisions
- Python 3.13 is pinned (.python-version); requires-python stays >=3.11 so older interpreters still work. The project is tooling only (tool.uv package = false), so there is no installable package.
- Cross-origin isolation (COOP same-origin, COEP require-corp) is sent by the Vite dev and preview servers and by Vercel, because multi-threaded WebAssembly in onnxruntime-web needs it.
- Model is YOLO26n (owner decision), not YOLO11n. Our export is raw [1, 84, N] (no NMS in the graph), so postprocess decodes, thresholds per class, and runs class-aware NMS (nmsIou 0.45).
- Gate A: input size is 416 (owner decision; CONFIG.detection.inputSize). If NFR-1 (8 fps) or NFR-2 (p95 120 ms) fail in the field, fall back to 320, which is a one-line config change.
- A1 included a minimal M1 (ml/export_onnx.py, ml/class_map.json, ml/gen_classes.py, classes.ts, two ONNX files) because nothing from M1 was on main. The Model track owns these from here and may replace them.
- onnxruntime-web WebAssembly files (asyncify build, 26 MB) are copied to web/public/ort/ by scripts/copy-ort.mjs before dev and build; the folder is gitignored. Vite resolves ort with the onnxruntime-web-use-extern-wasm condition so the file is not bundled twice.
- A track needs 2 of 3 matched frames to confirm. A4 adds one fast path at the owner's request: a new track nearer than 2 m with confidence 0.7 or more confirms on its first frame (CONFIG.tracking.nearConfirm*). It can alert on a single-frame false detection, so check it in field tests (NFR-6).
- A4 uses the existing config names (confirmationHits, confirmationWindow, tentativeMaxMisses, lostAfterMs, alerts.approachMaxTtcS) instead of the names in the step prompt. Smoothing factors are per 67 ms and rescaled by the real frame gap. Approaching needs time to contact at or below 4 s for 300 ms, inside the 1 m half-width corridor. Closing speed is a least-squares slope over 500 ms; without a distance, time to contact is 1 / growth of ln(box height).
- Frame loop: capture only when the worker is idle and 90% of the minimum gap (maxFps 15) has passed, and capture again the moment a detection finishes, because waiting for the next video frame cost a 30 fps camera a third of its rate (measured 10 fps before, 12.5 after).
- Camera: asks for facingMode environment at 1280x720, then switches to the plain "Back Camera" lens when listed (virtual multi-lens devices can change field of view). Start is the only trigger; wake lock, camera, and model load all begin in the same tap.
- A3 follows the owner's step prompt where it differs from the first SDS draft: 12 o'clock within 15 degrees (was 10), far left/right when the box touches a side edge (was an angle), floor below 0.5 m and head height from 1.2 m (absolute meters), and in-path uses the box center only. Added by me: head height stops at a bottom edge of 2.0 m (above that it passes over the head), and cut-off boxes (touching the bottom) take the nearer of the box-size distance and the nearest visible floor.
- Distances: geometry returns the unrounded distance (the tracker smooths it) and the rounded 0.5 m value (what is spoken). Without a tilt reading geometry assumes level, prefers box size, and the status line says distances are less accurate.
- Tilt: only the vertical parts of the device axes are used, so pitch/roll are smoothed after conversion (no jump when beta and gamma flip at level). A reading counts for 2 s (orientation holds until it changes); frames use the tilt at their capture time.
- While paused, a reminder repeats every 15 s (SR-9), so a paused app is never mistaken for a quiet path.
- types.ts frame log entries carry detections and orientation, so scripts/replay.ts can re-run the pipeline offline.
- The Vite dev server accepts ngrok hosts (.ngrok-free.app, .ngrok-free.dev) so a phone can reach it.
- Audio (U1): the stall phrase is "Detection stalled." (as in the SDS), not "Detection paused.", so a stall never sounds like the user's own pause (SR-9).
- Audio (U1): the health monitor takes tilt from the session's orientation sensor (A3) and audio settings from the settings store, so motion permission is asked once, in session.start().
- Audio (U1): a health warning holds until recoverAfterMs (2 s) of good readings, and low fps is judged only once a full fps window has passed without a stall, so the end of a stall does not trigger "Detection is slow."
- Audio (U1): a speech watchdog (base 3 s plus 120 ms per character) ends a phrase if iOS never fires its end event, so the heartbeat and later alerts can never stay blocked (SR-1).
