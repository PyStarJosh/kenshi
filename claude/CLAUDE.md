# CLAUDE.md

## Project
Kenshi: a real-time obstacle guide for blind and low-vision pedestrians that runs entirely on an iPhone in Safari. The rear camera feeds an on-device YOLO model, and the app speaks short guide-style alerts such as "Backpack, 1 o'clock, about 2 meters, on the floor."
- It complements the white cane and never replaces it. Never claim otherwise in code, UI text, or docs.
- Demo form factor: the phone held at eye level, sideways (landscape), to simulate camera glasses. Glasses (for example Meta's) are a future target only; do not claim any integration.
- Built in 36 hours by a team of three, each running Claude Code.

## Design decisions (do not change without asking)
- Platform: web app for iPhone Safari, Vite + React + TypeScript, deployed on Vercel. No backend, except the optional stretch step S6 (one Vercel function).
- Detection: YOLO26n exported to ONNX, run with onnxruntime-web inside a Web Worker. WebGPU first, multi-threaded WebAssembly fallback (needs cross-origin isolation headers). Input size 320 or 416, decided at Gate A.
- Model: the base COCO model first. A retrained model that adds stairs, curb, pole, and door replaces it only if it wins on our tests (step M3).
- Alerts: walk mode only. Announce confirmed objects that are in the walking path or approaching. One spoken alert at a time; urgent alerts preempt everything.
- Phrase format: "<object>, <clock> o'clock, about <meters> meters[, on the floor | , at head height]". Clock positions 11, 12, 1, plus "far left" and "far right". Meters rounded to the nearest 0.5.
- Audio: a short directional tone (stereo pan), then the phrase, through AirPods in transparency mode. A quiet heartbeat tick while healthy; a distinct warning the moment detection degrades.
- Controls: tap anywhere to talk (what's around me, pause, resume, repeat, slower, faster, help). If speech recognition fails, the tap alone runs "what's around me". Long press pauses or resumes.
- Geometry: device orientation (pitch and roll), a calibrated horizontal field of view, and the user's eye height give ground-plane distance; box-size distance is the fallback.
- Privacy: frames never leave the phone, except the explicit "describe" command in stretch step S6.

## Structure
```
pyproject.toml, uv.lock     Python tooling (uv); dependency groups: ml, analysis
ml/                         model export, class map (class_map.json), dataset prep, Colab notebook, model comparison, walk evaluation
web/                        Vite + React + TypeScript app
  public/models/            ONNX models (each under 15 MB)
  public/ort/               onnxruntime-web WebAssembly files, copied by scripts/copy-ort.mjs (gitignored)
  public/samples/           bus.jpg for the benchmark screen (?bench)
  public/sw.js              offline cache (service worker)
  api/                      stretch step S6 only: the describe function
  src/core/                 types.ts (shared contracts), config.ts (every tunable number)
  src/camera/               camera stream, frame scheduler
  src/detection/            worker, engine, protocol, preprocess, postprocess, classes.ts (generated)
  src/sensors/              device orientation
  src/geometry/             clock, distance, elevation, walking path
  src/tracking/             tracker, smoothing, time-to-contact
  src/alerts/               policy, phrases, event bus
  src/audio/                unlock, tones, speech, heartbeat
  src/health/               health monitor
  src/voice/                recognizer, commands
  src/telemetry/            test-mode logger, export
  src/app/                  pipeline orchestrator, screens, settings, calibration
  scripts/copy-ort.mjs      copies onnxruntime-web WebAssembly files into public/ort (runs before dev and build)
  scripts/replay.ts         offline replay of test logs
  vercel.json               cross-origin isolation headers
docs/                       SRS.md, SDS.md, TESTING.md, DEMO.md
field-tests/                one folder per test round: logs, labels, notes (videos gitignored)
results/                    evaluation reports
PROGRESS.md                 state per track
```
Keep this section current when the structure changes.

## Source of truth
- docs/SRS.md (requirements with IDs) and docs/SDS.md (design) are the source of truth once step S2 creates them. Code must satisfy them. Changing a requirement needs my approval.
- web/src/core/types.ts defines the contracts between modules. Change it only with my approval, because teammates build against it.
- web/src/core/config.ts holds every tunable number. Field-test tuning changes only this file unless a bug needs a code fix.

## Context rules (every session)
1. Read PROGRESS.md before touching code, plus the SRS and SDS sections relevant to the task.
2. Read a file before editing it. Search before adding a function, and reuse what exists.
3. After each meaningful change, update your track's section of PROGRESS.md (Works, Broken, Next) and record decisions with reasons under Decisions. Keep the file under 80 lines.
4. If a task conflicts with this file, the SRS, or the SDS, stop and ask.

## Team and git rules
- Three tracks work in parallel: App (A-steps), Audio/UX (U-steps), Model (M-steps). Shared steps are S-steps.
- Start each step from the latest main on a branch named after the step (for example a3-geometry). Commit small and often.
- Ship a finished step to main: rebase onto origin/main, run every check, fast-forward main, push main, delete the branch. main must always build and deploy.
- Edit only your own track's section of PROGRESS.md. Never force push. Never rewrite main's history.
- Do not change another track's module internals; integrate through types.ts and the event bus.

## Working rules
- Make the smallest change that solves the task. No drive-by refactors or renames.
- One step at a time: finish, verify, commit, and ship it before the next.
- No new dependencies without approval. Approved ones are named in the step prompt.
- Pure logic (postprocess, geometry, tracking, policy, phrases, commands, health transitions) lives in pure functions with Vitest tests. Camera, audio, sensors, and DOM code stay in thin adapters.
- No dead code, commented-out blocks, or stray console.log. Dev-only UI goes behind ?debug or Test mode.

## Safety rules (this product is safety-critical)
- Never say clear, safe, or anything implying the path is free. Silence must never mean clear: heartbeat while healthy, warnings when not.
- Drop any alert older than the stale limit before speaking it, and confirm its track still exists.
- Urgent alerts preempt all other speech, summaries, and descriptions.
- When detection degrades (stalled, low frame rate, low light, phone lowered, errors), say so immediately.
- Never block the main thread or the audio path with inference or heavy work.

## Performance rules
- Inference runs only in the Web Worker. Latest frame wins: never queue frames.
- Transfer ImageBitmaps between threads, and avoid per-frame allocations in hot paths where practical.
- Measure, don't guess: timings come from the benchmark screen and telemetry.
- Targets live in docs/SRS.md (NFRs); the latency budget lives in docs/SDS.md.

## Accessibility rules
- Fully usable without looking at the screen. The Talk area is one large, labeled button; settings are reachable but out of the way.
- Every state change is spoken (unless spoken feedback is off) and written to an aria-live region.
- Works with VoiceOver on and off, in both landscape orientations and portrait, at large text sizes.

## Bug prevention
- Run it before claiming it works, and report what you ran and what you saw.
- Handle every failure with a spoken and on-screen message and a recovery path.
- Never silence an error to make a check pass. Find the cause.
- If a fix fails twice, stop, explain what you tried, and ask.
- Before finishing, re-read the diff for unused imports, numbers that belong in config.ts, missing error handling, and console errors.
- You cannot test on the iPhone. Say what must be checked on the phone and give a short checklist instead of claiming phone results.

## Security and privacy
- No secrets in the repo. The only secret (stretch step S6) lives in Vercel environment variables.
- Frames, logs, and recordings stay on the device unless the user exports them.
- Never open or print .env files.

## Commands
Python (repo root):
- Sync: uv sync --all-groups
- Export model: uv run --group ml python ml/export_onnx.py
- Generate class map: uv run --group ml python ml/gen_classes.py (reads ml/class_map.json, writes web/src/detection/classes.ts)
- Evaluate walks: uv run --group analysis python ml/eval_walks.py <round folder>

Web (in web/):
- Install: npm install
- Dev: npm run dev (phone access: ngrok http 5173)
- Checks: npm run lint, npm run typecheck, npm run test, npm run build
- Replay a test log: npx tsx scripts/replay.ts <log.jsonl> [overrides.json]

Deploy: push to main. Vercel builds web/ (root directory web, framework Vite).

## Definition of done (per step)
1. lint, typecheck, test, and build pass.
2. Pure logic has tests, and failure paths are handled.
3. A phone checklist is provided when the step touches the camera, audio, sensors, voice, or layout.
4. Your track's section of PROGRESS.md is updated, and the SRS or SDS is updated if behavior changed.
5. Shipped to main and pushed.

## Build order
- Shared: S1 project skeleton and GitHub, S2 SRS, SDS, and shared contracts
- App: A1 detection engine and benchmark, Gate A (iPhone speed), A2 live camera loop, A3 orientation and geometry, A4 tracking, A5 alert policy
- Audio/UX: U1 audio engine and health monitor, U2 voice commands, U3 accessibility, settings, and errors
- Model: M1 export model and class map, M2 hazard dataset and training, M3 integrate the retrained model
- Shared: S3 end-to-end integration (Gate B), S4 field-test tooling, S5 field-test rounds, S6 stretch: describe with Claude, S7 final docs, demo, and release

Feature freeze at hour 30: after that, only fixes, tuning, and docs.