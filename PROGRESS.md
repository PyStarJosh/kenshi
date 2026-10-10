# PROGRESS

Edit only your own track's section. Keep this file under 80 lines.

## Shared
**Works:** S1 skeleton (uv project, Vite app, private GitHub repo). S2 done: docs/SRS.md (20 FR, 13 NFR, 9 SR), docs/SDS.md, web/src/core/types.ts, web/src/core/config.ts.
**Broken:** nothing known.
**Next:** tracks start A1, U1, M1 in parallel against types.ts and config.ts. Then S3 integration (Gate B).

## App
**Works:** placeholder screen with a Start button and an aria-live status line.
**Broken:** nothing yet.
**Next:** A1 detection engine and benchmark.

## Audio/UX
**Works:** nothing yet.
**Broken:** nothing yet.
**Next:** U1 audio engine and health monitor.

## Model
**Works:** ml/ package exists with the ml and analysis dependency groups installed.
**Broken:** nothing yet.
**Next:** M1 export model and class map.

## Decisions
- Python 3.13 is pinned (.python-version); requires-python stays >=3.11 so older interpreters still work. The project is tooling only (tool.uv package = false), so there is no installable package.
- Cross-origin isolation (COOP same-origin, COEP require-corp) is sent by the Vite dev and preview servers and by Vercel, because multi-threaded WebAssembly in onnxruntime-web needs it.
- Model name in docs is YOLO26n (owner decision), not YOLO11n. YOLO26n exports NMS-free by default; postprocess adds NMS only if the real export needs it.
- A track needs 2 of 3 matched frames before it can alert; we did not add a faster path for urgent hazards, to protect the false-alert target (NFR-6). Revisit after field tests.
- While paused, a reminder repeats every 15 s (SR-9), so a paused app is never mistaken for a quiet path.
- types.ts frame log entries carry detections and orientation, so scripts/replay.ts can re-run the pipeline offline.
- The Vite dev server accepts ngrok hosts (.ngrok-free.app, .ngrok-free.dev) so a phone can reach it.
