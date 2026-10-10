# Kenshi

A real-time obstacle guide for blind and low-vision pedestrians. It runs entirely on an iPhone in Safari and complements the white cane; it never replaces it. See `docs/SRS.md` and `docs/SDS.md` for what we build and how, and `PROGRESS.md` for the current state.

## Setup

You need [Node.js](https://nodejs.org) 22.12 or newer (24 LTS recommended), [uv](https://docs.astral.sh/uv/), and git.

### Web app

Run these **inside `web/`**; the repo root has no `package.json`.

```
cd web
npm install
npm run dev
```

Open http://localhost:5173/. Tap Start to run the camera loop (add `?debug` for the overlay with boxes, direction, distance, tilt, fps, and timings). Settings holds the eye height and the field-of-view calibration; hold the phone sideways. Add `?bench` to the URL for the benchmark screen instead. To test on a phone, run `ngrok http 5173` in a second terminal and open the ngrok address on the phone.

Checks: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`.

`npm install` may print `npm warn install-scripts ... protobufjs`. That is a warning only and can be ignored.

### Python tooling

From the repo root: `uv sync --all-groups`. Export the model with `uv run --group ml python ml/export_onnx.py`.

### If something fails

- `ENOENT ... package.json`: you are not in `web/`.
- `EBADENGINE` or "Unsupported engine": upgrade Node (`node --version` must be 22.12 or newer).
- Missing files after a merge: `git switch main && git pull`, then `npm install` again.
- Odd install errors: delete `web/node_modules` and run `npm install` again.
