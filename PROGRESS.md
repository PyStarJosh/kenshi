# PROGRESS

One runner does the code now (see claude/CLAUDE.md). Update Works, Broken, Next after each step; keep this file under 80 lines.

## Status
**Works (R0 pivot, R1 install):** R1: manifest.webmanifest (name "Kenshi", standalone, black, no orientation), 192/512/180 px icons made by ml/make_icons.py, and the index.html tags; no service worker. Checked in desktop Edge against the production preview: manifest and icons load with the cross-origin isolation headers, crossOriginIsolated is true, no console or network errors. R0: Walk mode as built through S3: camera, frame scheduler, YOLO26n worker (WebGPU, then WebAssembly), tracker, geometry, alert policy, event bus, audio (tones, speech, heartbeat), voice commands, health monitor, settings, calibration, ?debug, ?bench. After the R0 deletions lint, typecheck, test (583 tests), and build pass; `uv sync --all-groups` works. Docs: SRS and SDS now carry Find mode (FR-21 to FR-30, NFR-14 to NFR-16, SR-10, SR-11, SDS section 13).
**Broken:** nothing known in code. Nothing has been run on the iPhone for A3, A5, U1, U2, or S3, so their phone checklists are still open; the R1 checklist (Share menu, full screen, prompts, audio, ?bench isolation, settings re-entry) is open too. Unmet and unmeasured: NFR-1 to NFR-7 and NFR-10 need phone numbers; no iPhone benchmark numbers are in SDS 4.1 yet.
**R2 (locate):** rebuilt to the owner's second R2 spec. web/api/locate.ts calls Gemini through the Interactions API (frames are `{jpeg, heading, pitch}`; reply `{found, frameIndex, box{x0,y0,x1,y1}, label, onFloor, distanceM, confidence, signHint, latencyMs}` or `{error, message}`; default model gemini-3.8-flash, 8 s timeout). find/locateClient.ts (`Locator`: 640 px JPEG, min gap 6 s, 8 per minute, never throws), messages.ts, shared types now in core/types.ts, config.find, a ?debug Locate panel. Checked for real with `vercel dev` and a chair photo (SDS 13.5): found, and not found for an absent target, 3 s. gemini-3.8-flash is flaky (timeouts); Vercel GEMINI_MODEL is gemini-3.1-flash-lite. Phone check open: the ?debug Locate button on the deployed URL.
**Next:** R3 heading, R4 controller and sweep, R5 guidance and beacon, R6 Find screen, R7 path line, R8 docs and demo. The GREETING in audio/unlock.ts says "Navigator on." and should say Kenshi (fix in R6 or R8).
**Later steps must handle:** (1) the Settings screen needs the Find privacy acceptance and a way to withdraw it (R4/R6). (2) types.ts and the event bus need Find types and topics (R4, with approval). (3) Voice: add the `find` intent with a target and `stop`; today the word "stop" already means pause (voice/commands.ts), so R4 must decide how the two coexist. "What do you see" now maps to "what's around me" because describe was removed. (4) orientation gives pitch and roll only; yaw/heading is new (R3). (5) The audio engine plays one alert at a time with urgent preemption; Find speech should use the normal or info priority and the beacon needs its own gain so it can be silenced for urgent alerts (R5). (6) vercel.json sets COOP/COEP on every route; check the function route and the Gemini call still work under them (R2). (7) ?debug and ?bench stay as the measuring tools.

## Module map (web/src unless noted)
| Module | Decision | Reason |
|---|---|---|
| core/types.ts, core/config.ts | change | Telemetry, describe, and test mode removed in R0; Find types and a `find` config section come in R2 to R5 |
| camera/camera.ts, wakeLock.ts | keep | Find reuses the same stream and keeps the screen awake |
| camera/scheduler.ts | keep | Walk loop unchanged; its bitmap grabber is reused for Find frames |
| detection/* (worker, engine, protocol, pre/postprocess, classes.ts, models.ts) | keep | Walk mode keeps running during Find; base 80-class model stays |
| sensors/orientation.ts, attitude.ts | change | Add gyroscope yaw (heading) in R3; pitch and roll stay |
| geometry/geometry.ts | keep | Clock, bearing, ground-plane distance are reused for the target's box |
| geometry/freeSpacePath.ts | new (R7) | Path line around obstacles |
| tracking/* | keep | Obstacle tracks feed alerts and the path line |
| alerts/policy.ts, phrases.ts | keep | Walk alerts continue; urgent ones preempt Find speech |
| alerts/bus.ts | change | Add Find topics in R4 |
| audio/unlock.ts, speech.ts, heartbeat.ts | keep | Find speech uses the same speaker; heartbeat stays (SR-1) |
| audio/tones.ts, engine.ts | change | Beacon pulses reuse the tone scheduler; engine needs a silence hook for urgent alerts (R5) |
| audio/beacon.ts | new (R5) | Distance-driven, panned pulse |
| health/monitor.ts | keep | Detection health still matters during Find |
| voice/recognizer.ts, gesture.ts | keep | Listening for the target name reuses them |
| voice/commands.ts, control.ts | change | Add `find <target>` and `stop`; `describe` removed in R0 |
| app/session.ts, audioLink.ts, pipeline.ts | change | Telemetry hooks removed in R0; R4 hosts the Find controller and mode switching |
| app/settings.ts, screens/Settings.tsx | change | Test mode removed in R0; privacy acceptance added in R4 |
| app/calibration.ts, screens/Calibrate.tsx | keep | Field of view is needed for the target's bearing |
| app/messages.ts, latency.ts, screens/TalkButton.tsx | keep | Status text, latency stats, the Talk control |
| app/screens/DebugOverlay, AudioTestPanel, Benchmark and their stats helpers | keep | Measurement tools behind ?debug and ?bench |
| app/screens/FindScreen.tsx, find/* | new (R2 to R6) | Find mode |
| App.tsx, index.css | change | Find entry and screen; R0 removed the test overlay and save button |
| telemetry/*, app/useTelemetry.ts, SaveLogButton, TestOverlay, scripts/replay.ts, make-fixture.ts, tsconfig.scripts.json | removed | Field-test tooling dropped |
| public/manifest.webmanifest, public/icons/, ml/make_icons.py | new (R1, done) | Home Screen install |
| web/api/locate.ts, find/locateClient.ts, messages.ts, core/types.ts (Locate types) | new (R2, done) | Gemini function and its client |
| web/vercel.json, vite.config.ts | keep / change | Headers stay; the git-commit and version defines were only for test logs and are gone |
| ml/export_onnx.py, gen_classes.py, class_map.json, check_onnx.py | keep | Rebuild the base model and class table |
| ml/ datasets, training, comparison, eval, tests; field-tests/; docs/TESTING.md | removed | Hazard retraining and field-test rounds dropped; fiftyone and the analysis group left pyproject |
| docs/SRS.md, SDS.md, claude/CLAUDE.md, README.md | change | Pivot (R0); DEMO.md arrives in R8 |

## What Find can reuse
Orientation pitch and roll (sensors/orientation). Ground-plane distance, field of view, and bearing/clock from a box (geometry, calibration, settings). Tracker and alert policy (obstacle alerts keep running; the policy's urgent priority is the preemption rule). Event bus. Tones with pan, the speaker queue, voice recognizer and commands, the Talk gesture, the health monitor. Frame grabber from the scheduler. There is no existing Vercel function (the describe step was never built), only vercel.json headers.

## Decisions
- Pivot (owner, with the team): Find mode via Gemini replaces hazard retraining (M2/M3), field-test rounds, and Claude describe (S6). Frames leave the phone only in Find, after an explicit privacy notice (Gemini free tier: Google may train on them, humans may review).
- Python 3.13 pinned; tooling only (no installable package). Cross-origin isolation headers come from the Vite servers and Vercel for multi-threaded WebAssembly. onnxruntime-web files are copied to public/ort by scripts/copy-ort.mjs (gitignored).
- YOLO26n, raw output [1, 84, N] (4 box values plus 80 classes, no NMS in the graph), so postprocess decodes, thresholds per class, and runs class-aware NMS (0.45). Input 416 (Gate A, owner); 320 is a one-line fallback.
- Frame loop: capture only when the worker is idle and 90% of the minimum gap (15 fps cap) has passed, and again as soon as a detection finishes. Camera: environment-facing 1280x720, then the plain "Back Camera" lens when listed. Start is the only trigger for camera, wake lock, and model load.
- Geometry (owner's A3 prompt): 12 o'clock within 15 degrees, far left/right when a box touches a side edge, floor below 0.5 m and head height from 1.2 m, in-path by box center. Cut-off boxes take the nearer of box-size and nearest-visible-floor distance. Without tilt, geometry assumes level and prefers box size. Tilt readings count for 2 s.
- Tracking: 2 of 3 matched frames confirm; a new track nearer than 2 m with confidence 0.7 or more confirms at once (owner request; watch for false alerts). Approaching needs time to contact at or below 4 s for 300 ms inside the 1 m corridor.
- Alerts: an object is announced once, never on a timer; an alert the audio engine drops or an urgent one cuts off is announced again; urgent never cuts off urgent. "What's around me" lists up to 5 objects within 6 m, in clock order.
- Audio and voice: stall phrase is "Detection stalled." A health warning clears after 2 s of good readings. A speech watchdog (3 s plus 120 ms per character) ends a phrase if iOS never reports its end. The Talk button covers the live screen; a 1 s hold pauses or resumes; while paused a reminder repeats every 15 s (SR-9). Voice replies are normal priority, so they never delay an urgent alert.
- R1: the manifest and tags say "Kenshi" (the step prompt said "Navigator"; the owner's standing rule is that the app is called Kenshi). No service worker, so a stale cached build can never show during the demo. The Home Screen app has its own storage: eye height and calibration must be entered once again there. The favicon is still the Vite template icon (tab only; the Home Screen uses the new icons).
- R2: the function has no rate limit beyond the same-origin check (anyone with the URL can spend the free-tier quota; accepted for the demo). The client keeps its own limit: 6 s between calls and 8 per minute. The model is an environment variable because free-tier names, speed and limits change; the spec default gemini-3.8-flash timed out in checks, so Vercel sets another. A weak or malformed answer is "not found" or an error, never a guess (SR-11).
- The Vite dev server accepts ngrok hosts (.ngrok-free.app, .ngrok-free.dev) so a phone can reach it.
