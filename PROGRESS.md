# PROGRESS

One runner does the code now (see claude/CLAUDE.md). Update Works, Broken, Next after each step; keep this file under 80 lines.

## Status
**P1 (silent detector, owner decision):** the detector no longer speaks. Deleted alerts/policy.ts and phrases.ts (and their tests), the pipeline's policy, summarizer and captions, the voice intents whats-around and repeat, and the unused alert settings in config. Kept: the detector, tracker and geometry (their tracks go on the bus for the R7 route), the audio engine, heartbeat, health warnings, and the event bus (`alert` and `alertOutcome` stay for Find). A tap that hears nothing now does nothing. New SRS rule SR-12 and a pipeline test that tracks never make an alert. Start runs camera and detection silently until the Find controller (R4) and screen (R6) exist.
**Works (R0 pivot, R1 install):** R1: manifest.webmanifest (name "Kenshi", standalone, black, no orientation), 192/512/180 px icons made by ml/make_icons.py, and the index.html tags; no service worker. Checked in desktop Edge against the production preview: manifest and icons load with the cross-origin isolation headers, crossOriginIsolated is true, no console or network errors. R0: Walk mode as built through S3: camera, frame scheduler, YOLO26n worker (WebGPU, then WebAssembly), tracker, geometry, alert policy, event bus, audio (tones, speech, heartbeat), voice commands, health monitor, settings, calibration, ?debug, ?bench. After the R0 deletions lint, typecheck, test (583 tests), and build pass; `uv sync --all-groups` works. Docs: SRS and SDS now carry Find (FR-21 to FR-30, NFR-14 to NFR-16, SR-10 to SR-12, SDS section 13).
**Broken:** nothing known in code. Nothing has been run on the iPhone for A3, A5, U1, U2, or S3, so their phone checklists are still open; the R1 checklist (Share menu, full screen, prompts, audio, ?bench isolation, settings re-entry) is open too. Unmet and unmeasured: NFR-1 to NFR-7 and NFR-10 need phone numbers; no iPhone benchmark numbers are in SDS 4.1 yet.
**R2 (locate):** web/api/locate.ts (Gemini via GEMINI_API_KEY, optional GEMINI_MODEL), find/locateClient.ts, locateTypes.ts, messages.ts, config.find, web/.env.example, scripts/try-locate.mjs. 626 tests pass (the function with a mocked Gemini, the client, SR-2 wording). Run against real Gemini on the deployed project (https://kenshi-three.vercel.app) on 2026-10-11 with bus.jpg: bus found, red bicycle not found, about 3 s. Default model is gemini-3.1-flash-lite (gemini-2.5-flash 404s for new keys); GEMINI_MODEL is set to it in Vercel. About 1 call in 4 returned an unusable reply (bad-reply), and bigger models 503ed; consider one retry in R4. Re-check: `node scripts/try-locate.mjs public/samples/bus.jpg bus https://kenshi-three.vercel.app`.
**Next:** R3 heading, R4 controller and sweep, R5 guidance and beacon, R6 Find screen, R7 path line, R8 docs and demo. The GREETING in audio/unlock.ts says "Navigator on." and should say Kenshi (fix in R6 or R8).
**Later steps must handle:** (1) the Settings screen needs the Find privacy acceptance and a way to withdraw it (R4/R6). (2) types.ts and the event bus need Find types and topics (R4, with approval). (3) Voice: add the `find` intent with a target and `stop`. "Stop" no longer means pause (removed from the pause rule in P1), so R4 only has to map it to cancelling Find. (4) orientation gives pitch and roll only; yaw/heading is new (R3). (5) The audio engine plays one alert at a time with urgent preemption; health warnings are now the only urgent alerts, Find speech should use the normal or info priority, and the beacon needs its own gain so it can be silenced for a health warning (R5). (6) vercel.json sets COOP/COEP on every route; check the function route and the Gemini call still work under them (R2). (7) ?debug and ?bench stay as the measuring tools. (8) R7 must make the path line the source of Find's turn directions (SRS FR-28).

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
| tracking/* | keep | Tracks feed the R7 path line; silent |
| alerts/policy.ts, phrases.ts | removed (P1) | The detector is silent; nothing turns tracks into speech |
| alerts/bus.ts | change | Keeps `alert`/`alertOutcome` for Find speech; Find topics added in R4 |
| audio/unlock.ts, speech.ts, heartbeat.ts | keep | Find speech uses the same speaker; heartbeat stays (SR-1) |
| audio/tones.ts, engine.ts | change | Beacon pulses reuse the tone scheduler; engine needs a silence hook for urgent alerts (R5) |
| audio/beacon.ts | new (R5) | Distance-driven, panned pulse |
| health/monitor.ts | keep | Detection health still matters during Find |
| voice/recognizer.ts, gesture.ts | keep | Listening for the target name reuses them |
| voice/commands.ts, control.ts | change | P1 removed `whats-around`, `repeat`, and the word "stop" from pause; R4 adds `find <target>` and `stop` |
| app/session.ts, audioLink.ts, pipeline.ts | change | Telemetry hooks removed in R0; R4 hosts the Find controller and mode switching |
| app/settings.ts, screens/Settings.tsx | change | Test mode removed in R0; privacy acceptance added in R4 |
| app/calibration.ts, screens/Calibrate.tsx | keep | Field of view is needed for the target's bearing |
| app/messages.ts, latency.ts, screens/TalkButton.tsx | keep | Status text, latency stats, the Talk control |
| app/screens/DebugOverlay, AudioTestPanel, Benchmark and their stats helpers | keep | Measurement tools behind ?debug and ?bench |
| app/screens/FindScreen.tsx, find/* | new (R2 to R6) | Find mode |
| App.tsx, index.css | change | Find entry and screen; R0 removed the test overlay and save button |
| telemetry/*, app/useTelemetry.ts, SaveLogButton, TestOverlay, scripts/replay.ts, make-fixture.ts, tsconfig.scripts.json | removed | Field-test tooling dropped |
| public/manifest.webmanifest, public/icons/, ml/make_icons.py | new (R1, done) | Home Screen install |
| web/api/locate.ts, find/locateClient.ts, locateTypes.ts, messages.ts | new (R2, done) | Gemini function and its client |
| web/vercel.json, vite.config.ts | keep / change | Headers stay; the git-commit and version defines were only for test logs and are gone |
| ml/export_onnx.py, gen_classes.py, class_map.json, check_onnx.py | keep | Rebuild the base model and class table |
| ml/ datasets, training, comparison, eval, tests; field-tests/; docs/TESTING.md | removed | Hazard retraining and field-test rounds dropped; fiftyone and the analysis group left pyproject |
| docs/SRS.md, SDS.md, claude/CLAUDE.md, README.md | change | Pivot (R0); DEMO.md arrives in R8 |

## What Find can reuse
Orientation pitch and roll (sensors/orientation). Ground-plane distance, field of view, and bearing/clock from a box (geometry, calibration, settings). The tracker (its tracks feed the path line). Event bus. Tones with pan, the speaker queue, voice recognizer and commands, the Talk gesture, the health monitor. Frame grabber from the scheduler. There is no existing Vercel function other than locate; vercel.json also sets headers.

## Decisions
- Pivot (owner, with the team): Find mode via Gemini replaces hazard retraining (M2/M3), field-test rounds, and Claude describe (S6). Frames leave the phone only in Find, after an explicit privacy notice (Gemini free tier: Google may train on them, humans may review).
- Python 3.13 pinned; tooling only (no installable package). Cross-origin isolation headers come from the Vite servers and Vercel for multi-threaded WebAssembly. onnxruntime-web files are copied to public/ort by scripts/copy-ort.mjs (gitignored).
- YOLO26n, raw output [1, 84, N] (4 box values plus 80 classes, no NMS in the graph), so postprocess decodes, thresholds per class, and runs class-aware NMS (0.45). Input 416 (Gate A, owner); 320 is a one-line fallback.
- Frame loop: capture only when the worker is idle and 90% of the minimum gap (15 fps cap) has passed, and again as soon as a detection finishes. Camera: environment-facing 1280x720, then the plain "Back Camera" lens when listed. Start is the only trigger for camera, wake lock, and model load.
- Geometry (owner's A3 prompt): 12 o'clock within 15 degrees, far left/right when a box touches a side edge, floor below 0.5 m and head height from 1.2 m, in-path by box center. Cut-off boxes take the nearer of box-size and nearest-visible-floor distance. Without tilt, geometry assumes level and prefers box size. Tilt readings count for 2 s.
- Tracking: 2 of 3 matched frames confirm; a new track nearer than 2 m with confidence 0.7 or more confirms at once (owner request; with the detector silent a false track only bends the route). Approaching needs time to contact at or below 4 s for 300 ms inside the 1 m corridor.
- Alerts: removed in P1. The detector never speaks about objects (SR-12); the route (R7) bends around them and guidance follows its first leg. Only health warnings, Find guidance, status, and voice replies are spoken.
- Audio and voice: stall phrase is "Detection stalled." A health warning clears after 2 s of good readings. A speech watchdog (3 s plus 120 ms per character) ends a phrase if iOS never reports its end. The Talk button covers the live screen; a 1 s hold pauses or resumes; while paused a reminder repeats every 15 s (SR-9). Voice replies are normal priority, so they never delay a health warning.
- R1: the manifest and tags say "Kenshi" (the step prompt said "Navigator"; the owner's standing rule is that the app is called Kenshi). No service worker, so a stale cached build can never show during the demo. The Home Screen app has its own storage: eye height and calibration must be entered once again there. The favicon is still the Vite template icon (tab only; the Home Screen uses the new icons).
- R2: no rate limiting beyond the same-origin check, so anyone who finds the deployed URL can spend the free-tier quota (accepted for the demo; add a limit if the URL is shared widely). The model is an environment variable because free-tier model names and limits changed during 2026 and the sources disagree; the default may need changing. Boxes are validated and clamped; a weak or malformed answer is "not found" or an error, never a guess (SR-11).
- The Vite dev server accepts ngrok hosts (.ngrok-free.app, .ngrok-free.dev) so a phone can reach it.
