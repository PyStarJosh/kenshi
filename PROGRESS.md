# PROGRESS

Edit only your own track's section. Keep this file under 80 lines.

## Shared
**Works:** S1 skeleton (uv project, Vite app, private GitHub repo). S2 done: docs/SRS.md (20 FR, 13 NFR, 9 SR), docs/SDS.md, web/src/core/types.ts, web/src/core/config.ts.
**Broken:** nothing known.
**Next:** tracks start A1, U1, M1 in parallel against types.ts and config.ts. Then S3 integration (Gate B).

## App
**Works:** A1 detection worker + engine + ?bench (desktop numbers in SDS 4.1). A2 live loop: Start opens the back camera and loads the model, the newest frame goes to the worker whenever it is free, ?debug shows boxes, fps, provider, inference p50/p95, frame size, and a session clock. Pause/Resume, page hide, and camera loss stop and restart the camera and wake lock. Checked in desktop Edge 155 with a fake camera: about 12 fps, boxes on the bus and three people, pause/resume/hide all work.
**Broken:** nothing known. Not yet tried on the iPhone (camera, rotation, lock/unlock, app switching), so the phone checklist in the A2 PR is open. No iPhone benchmark numbers yet.
**Next:** run the A2 phone checklist, add iPhone numbers to SDS 4.1, then A3 orientation and geometry. Test mode (U3) will also turn on the overlay; for now it is ?debug only.

## Audio/UX
**Works:** U1 audio engine and health monitor. Start unlocks the AudioContext and speech in the tap and says the greeting. Panned lead-in tones (urgent pulses faster when closer), one phrase at a time with urgent preemption, stale and track-gone drops before any sound, heartbeat tick while healthy and quiet. Health monitor warns at once on stall, low fps, low light, phone lowered or raised, and blocked audio, repeats every 10 s, and says "Detection back." once. ?debug shows an audio test panel (sample alerts, health warnings, heartbeat without camera, alert-to-tone and frame-to-speech delays). Unit tests cover pan, pulse rate, speech queue, voice choice, heartbeat, and health transitions.
**Broken:** nothing known. Not yet heard on the iPhone; the U1 phone checklist (AirPods stereo, urgent preemption, heartbeat level, low light, lowered phone) is open.
**Next:** run the U1 phone checklist, record iOS tone and speech-start latency in SDS 4. Then U2 voice commands. Open for later steps: the paused reminder (SR-9) and speaking session status messages (U3); real track lookup and AlertEvents arrive with A4/A5 and the event bus.

## Model
**Works:** ml/ package exists with the ml and analysis dependency groups installed.
**Broken:** nothing yet.
**Next:** M1 export model and class map.

## Decisions
- Python 3.13 is pinned (.python-version); requires-python stays >=3.11 so older interpreters still work. The project is tooling only (tool.uv package = false), so there is no installable package.
- Cross-origin isolation (COOP same-origin, COEP require-corp) is sent by the Vite dev and preview servers and by Vercel, because multi-threaded WebAssembly in onnxruntime-web needs it.
- Model is YOLO26n (owner decision), not YOLO11n. Our export is raw [1, 84, N] (no NMS in the graph), so postprocess decodes, thresholds per class, and runs class-aware NMS (nmsIou 0.45).
- Gate A: input size is 416 (owner decision; CONFIG.detection.inputSize). If NFR-1 (8 fps) or NFR-2 (p95 120 ms) fail in the field, fall back to 320, which is a one-line config change.
- A1 included a minimal M1 (ml/export_onnx.py, ml/class_map.json, ml/gen_classes.py, classes.ts, two ONNX files) because nothing from M1 was on main. The Model track owns these from here and may replace them.
- onnxruntime-web WebAssembly files (asyncify build, 26 MB) are copied to web/public/ort/ by scripts/copy-ort.mjs before dev and build; the folder is gitignored. Vite resolves ort with the onnxruntime-web-use-extern-wasm condition so the file is not bundled twice.
- A track needs 2 of 3 matched frames before it can alert; we did not add a faster path for urgent hazards, to protect the false-alert target (NFR-6). Revisit after field tests.
- Frame loop: capture only when the worker is idle and 90% of the minimum gap (maxFps 15) has passed, and capture again the moment a detection finishes, because waiting for the next video frame cost a 30 fps camera a third of its rate (measured 10 fps before, 12.5 after).
- Camera: asks for facingMode environment at 1280x720, then switches to the plain "Back Camera" lens when listed (virtual multi-lens devices can change field of view). Start is the only trigger; wake lock, camera, and model load all begin in the same tap.
- While paused, a reminder repeats every 15 s (SR-9), so a paused app is never mistaken for a quiet path.
- types.ts frame log entries carry detections and orientation, so scripts/replay.ts can re-run the pipeline offline.
- The Vite dev server accepts ngrok hosts (.ngrok-free.app, .ngrok-free.dev) so a phone can reach it.
- Audio (U1): the stall phrase is "Detection stalled." (as in the SDS), not "Detection paused.", so a stall never sounds like the user's own pause (SR-9).
- Audio (U1): health/pitch.ts reads camera pitch from device orientation so the lowered-phone warning works now; A3's orientation sensor replaces it and the monitor keeps taking OrientationSample.
- Audio (U1): a health warning holds until recoverAfterMs (2 s) of good readings, and low fps is judged only once a full fps window has passed without a stall, so the end of a stall does not trigger "Detection is slow."
- Audio (U1): a speech watchdog (base 3 s plus 120 ms per character) ends a phrase if iOS never fires its end event, so the heartbeat and later alerts can never stay blocked (SR-1).
