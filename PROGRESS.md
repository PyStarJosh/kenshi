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
**Works:** nothing yet.
**Broken:** nothing yet.
**Next:** U1 audio engine and health monitor.

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
- A track needs 2 of 3 matched frames before it can alert; we did not add a faster path for urgent hazards, to protect the false-alert target (NFR-6). Revisit after field tests.
- Frame loop: capture only when the worker is idle and 90% of the minimum gap (maxFps 15) has passed, and capture again the moment a detection finishes, because waiting for the next video frame cost a 30 fps camera a third of its rate (measured 10 fps before, 12.5 after).
- Camera: asks for facingMode environment at 1280x720, then switches to the plain "Back Camera" lens when listed (virtual multi-lens devices can change field of view). Start is the only trigger; wake lock, camera, and model load all begin in the same tap.
- While paused, a reminder repeats every 15 s (SR-9), so a paused app is never mistaken for a quiet path.
- types.ts frame log entries carry detections and orientation, so scripts/replay.ts can re-run the pipeline offline.
- The Vite dev server accepts ngrok hosts (.ngrok-free.app, .ngrok-free.dev) so a phone can reach it.
