# CLAUDE.md

## Project
Kenshi: a real-time guide for blind and low-vision people that runs on an iPhone in Safari. Walk mode (on-device YOLO) speaks short alerts such as "Backpack, 1 o'clock, about 2 meters, on the floor." Find mode (new) is a "Find My" for blind users: name a target and the app guides you to it with a big arrow, spoken directions, and an audio beacon.
- It complements the white cane and never replaces it. Never claim otherwise in code, UI text, or docs.
- Demo form factor: the phone held at eye level, sideways (landscape), to simulate camera glasses. Glasses (for example Meta's) are a future target only; do not claim any integration.
- Pivoted to Find mode with about 6 hours left (step R0). Hazard retraining, field-test rounds, and the Claude describe step are dropped.

## Design decisions (do not change without asking)
- Platform: web app for iPhone Safari, Vite + React + TypeScript, on Vercel. One Vercel function, web/api/locate.ts, for Find mode. No other backend.
- Walk mode: YOLO26n (base COCO model, 416 input) as ONNX in a Web Worker via onnxruntime-web; WebGPU first, multi-threaded WebAssembly fallback (needs cross-origin isolation headers). Obstacle alerts keep running during Find; urgent ones preempt Find speech.
- Find mode: the user names a target by voice or from a quick-pick list. The function sends camera frames to Google Gemini (free tier) and returns which frame shows the target and its bounding box.
- Scan sweep: if the target is not in view, the user turns slowly; the app captures a frame about every 45 degrees (up to 8) and sends them in one request.
- Heading memory: the target's direction is stored as a device heading (gyro-based yaw), so guidance continues when it is out of view.
- Guidance: a Find My-style screen (big arrow, distance, green when aligned), an audio beacon in the AirPods (pulses speed up as the target gets closer, panned toward it), and GPS-style spoken directions.
- Path line: web/src/geometry/freeSpacePath.ts (step R7) draws a walking line around obstacles.
- Install: web manifest and icons so it can be added to the Home Screen. No service worker.
- Walk phrase format: "<object>, <clock> o'clock, about <meters> meters[, on the floor | , at head height]". Clock positions 11, 12, 1, plus "far left" and "far right". Meters rounded to the nearest 0.5.
- Audio: a short directional tone (stereo pan), then the phrase, through AirPods in transparency mode. A quiet heartbeat tick while healthy; a distinct warning the moment detection degrades.
- Controls: tap anywhere to talk (what's around me, find <target>, stop, pause, resume, repeat, slower, faster, help). If speech recognition fails, the tap alone runs "what's around me". Long press pauses or resumes.
- Geometry: device orientation (pitch and roll), a calibrated horizontal field of view, and the user's eye height give ground-plane distance; box-size distance is the fallback.

## Structure
```
pyproject.toml, uv.lock     Python tooling (uv); one dependency group: ml
ml/                         export_onnx.py, class_map.json, gen_classes.py (writes detection/classes.ts), check_onnx.py, make_icons.py
web/                        Vite + React + TypeScript app
  api/locate.ts             (R2) the Vercel function that calls Gemini
  public/models/            ONNX models (each under 15 MB)
  public/ort/               onnxruntime-web WebAssembly files, copied by scripts/copy-ort.mjs (gitignored)
  public/samples/           bus.jpg for the benchmark screen (?bench)
  public/manifest.webmanifest, icons/  Home Screen install (icons drawn by ml/make_icons.py)
  src/core/                 types.ts (shared contracts), config.ts (every tunable number)
  src/camera/               camera stream, frame scheduler, wake lock
  src/detection/            worker, engine, protocol, preprocess, postprocess, classes.ts (generated)
  src/sensors/              device orientation (adapter), attitude math; heading (R3)
  src/geometry/             geometry.ts (clock, distance, elevation, path); freeSpacePath.ts (R7)
  src/tracking/             tracker, smoothing, time-to-contact
  src/alerts/               policy, phrases, event bus
  src/audio/                unlock, tones, speech, heartbeat, engine; beacon (R5)
  src/health/               health monitor
  src/voice/                recognizer, commands, control, gesture
  src/find/                 (R2-R5) locate client, scan sweep, target memory, controller, guidance
  src/app/                  session, audio link, pipeline, settings, calibration, screens (Find screen R6)
  scripts/copy-ort.mjs      copies onnxruntime-web WebAssembly files into public/ort (runs before dev and build)
  vercel.json               cross-origin isolation headers
docs/                       SRS.md, SDS.md, DEMO.md (R8)
PROGRESS.md                 module map, status, decisions
```
Keep this section current when the structure changes.

## Source of truth
- docs/SRS.md (requirements with IDs) and docs/SDS.md (design) are the source of truth. Code must satisfy them. Changing a requirement needs my approval.
- web/src/core/types.ts defines the contracts between modules. Change it only with my approval.
- web/src/core/config.ts holds every tunable number. Tuning changes only this file unless a bug needs a code fix.

## Context rules (every session)
1. Read PROGRESS.md before touching code, plus the SRS and SDS sections relevant to the task.
2. Read a file before editing it. Search before adding a function, and reuse what exists (PROGRESS.md lists what Find can reuse).
3. After each meaningful change, update PROGRESS.md (Works, Broken, Next) and record decisions with reasons under Decisions. Keep the file under 80 lines.
4. If a task conflicts with this file, the SRS, or the SDS, stop and ask.

## Team and git rules
- One Claude Code runner does all the code. Teammates commit docs and assets (icons, demo script, screenshots) on their own branches; never edit another person's branch.
- Start each step from the latest main on a branch named after the step (for example r2-locate). Commit small and often.
- Ship each step as a pushed branch (rebased onto origin/main) and a pull request to main, with every check passing. main must always build and deploy.
- Never force push. Never rewrite main's history.

## Working rules
- Make the smallest change that solves the task. No drive-by refactors or renames.
- One step at a time: finish, verify, commit, and ship it before the next.
- No new dependencies without approval. Approved ones are named in the step prompt.
- Pure logic (postprocess, geometry, tracking, policy, phrases, commands, health transitions, scan planning, guidance, state machines) lives in pure functions with Vitest tests. Camera, audio, sensors, network, and DOM code stay in thin adapters.
- Modules meet only through types.ts, the event bus, and small interfaces; do not reach into another module's internals.
- No dead code, commented-out blocks, or stray console.log. Dev-only UI goes behind ?debug.

## Safety rules (this product is safety-critical)
- Never say clear, safe, or anything implying the path is free. Silence must never mean clear: heartbeat while healthy, warnings when not.
- Find results are hints, not facts. If the target is not found, say "I could not find it", never "it is not here". Never say the way to the target is clear.
- Drop any alert older than the stale limit before speaking it, and confirm its track still exists.
- Urgent obstacle alerts preempt all other speech, including Find guidance, summaries, and descriptions. Walk-mode detection keeps running during Find.
- When detection degrades (stalled, low frame rate, low light, phone lowered, errors), say so immediately.
- Never block the main thread or the audio path with inference or heavy work.

## Performance rules
- Inference runs only in the Web Worker. Latest frame wins: never queue frames.
- Transfer ImageBitmaps between threads, and avoid per-frame allocations in hot paths where practical.
- Find requests send a few downscaled frames, never video; encode off the critical path and cap the payload.
- Measure, don't guess: timings come from the benchmark screen and ?debug. Numbers nobody has measured are marked "to be measured".
- Targets live in docs/SRS.md (NFRs); the latency budgets live in docs/SDS.md.

## Accessibility rules
- Fully usable without looking at the screen. The Talk area is one large, labeled button; settings are reachable but out of the way.
- Every state change is spoken (unless spoken feedback is off) and written to an aria-live region.
- Works with VoiceOver on and off, in both landscape orientations and portrait, at large text sizes.

## Bug prevention
- Run it before claiming it works, and report what you ran and what you saw.
- Handle every failure with a spoken and on-screen message and a recovery path (no network, Gemini error or rate limit, timeout, nothing found).
- Never silence an error to make a check pass. Find the cause.
- If a fix fails twice, stop, explain what you tried, and ask.
- Before finishing, re-read the diff for unused imports, numbers that belong in config.ts, missing error handling, and console errors.
- You cannot test on the iPhone. Say what must be checked on the phone and give a short checklist instead of claiming phone results.

## Security and privacy
- Walk mode: frames never leave the phone.
- Find mode: frames go to Google Gemini. On the free tier Google may use them to improve its products and human reviewers may read them. The app says so, and the user accepts, before the first Find. Send frames only on a Find request, never continuously.
- The Gemini key lives only in the Vercel environment variable GEMINI_API_KEY. The function validates its input, stores nothing, and logs no images or targets.
- No secrets in the repo. Never open or print .env files.

## Commands
Python (repo root): sync with uv sync --all-groups. Export the model: uv run --group ml python ml/export_onnx.py. Check it: uv run --group ml python ml/check_onnx.py. Redraw the Home Screen icons: uv run --group ml python ml/make_icons.py. Generate the class map: uv run --group ml python ml/gen_classes.py (reads ml/class_map.json, writes web/src/detection/classes.ts).

Web (in web/):
- Install: npm install
- Dev: npm run dev (phone access: ngrok http 5173). With the function: vercel dev (needs GEMINI_API_KEY in web/.env.local, which is never printed or committed)
- Checks: npm run lint, npm run typecheck, npm run test, npm run build

Deploy: push to main. Vercel builds web/ (root directory web, framework Vite).

## Definition of done (per step)
1. lint, typecheck, test, and build pass.
2. Pure logic has tests, and failure paths are handled.
3. A phone checklist is provided when the step touches the camera, audio, sensors, voice, or layout.
4. PROGRESS.md is updated, and the SRS or SDS is updated if behavior changed.
5. Pushed on its branch with a pull request to main.

## Build order
R0 audit and pivot docs, R1 Home Screen install (manifest, icons), R2 Gemini locate function (web/api/locate.ts), R3 heading and target memory, R4 Find controller and scan sweep, R5 guidance and audio beacon, R6 Find screen, R7 path line (freeSpacePath.ts), R8 docs and demo.

Feature freeze after R7: R8 is docs and the demo only.
