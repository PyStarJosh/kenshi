# PROGRESS

Edit only your own track's section. Keep this file under 80 lines.

## Shared
**Works:** S1 skeleton (uv project, Vite app, private GitHub repo). S2 done: docs/SRS.md (20 FR, 13 NFR, 9 SR), docs/SDS.md, web/src/core/types.ts, web/src/core/config.ts.
**Broken:** nothing known.
**Next:** tracks start A1, U1, M1 in parallel against types.ts and config.ts. Then S3 integration (Gate B).

## App
**Works:** placeholder screen. A1 done (branch a1-detection): detection worker + engine (WebGPU, then WebAssembly, 4 threads when cross-origin isolated), postprocess/preprocess with tests, benchmark at ?bench. Desktop Edge 155: inference p95 30-55 ms on WebGPU, 35-79 ms on WebAssembly (see SDS 4.1).
**Broken:** nothing known. No iPhone numbers yet.
**Next:** A2 live camera loop, loading yolo26n-<CONFIG.detection.inputSize>.onnx (Gate A done: 416). Add the iPhone benchmark numbers to SDS 4.1.

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
- Model is YOLO26n (owner decision), not YOLO11n. Our export is raw [1, 84, N] (no NMS in the graph), so postprocess decodes, thresholds per class, and runs class-aware NMS (nmsIou 0.45).
- Gate A: input size is 416 (owner decision; CONFIG.detection.inputSize). If NFR-1 (8 fps) or NFR-2 (p95 120 ms) fail in the field, fall back to 320, which is a one-line config change.
- A1 included a minimal M1 (ml/export_onnx.py, ml/class_map.json, ml/gen_classes.py, classes.ts, two ONNX files) because nothing from M1 was on main. The Model track owns these from here and may replace them.
- onnxruntime-web WebAssembly files (asyncify build, 26 MB) are copied to web/public/ort/ by scripts/copy-ort.mjs before dev and build; the folder is gitignored. Vite resolves ort with the onnxruntime-web-use-extern-wasm condition so the file is not bundled twice.
- A track needs 2 of 3 matched frames before it can alert; we did not add a faster path for urgent hazards, to protect the false-alert target (NFR-6). Revisit after field tests.
- While paused, a reminder repeats every 15 s (SR-9), so a paused app is never mistaken for a quiet path.
- types.ts frame log entries carry detections and orientation, so scripts/replay.ts can re-run the pipeline offline.
- The Vite dev server accepts ngrok hosts (.ngrok-free.app, .ngrok-free.dev) so a phone can reach it.
