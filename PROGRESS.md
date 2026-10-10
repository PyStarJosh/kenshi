# PROGRESS

Edit only your own track's section. Keep this file under 80 lines.

## Shared
**Works:** S1 skeleton: uv project (Python 3.13, groups ml and analysis), Vite + React + TypeScript app in web/, private GitHub repo.
**Broken:** nothing known.
**Next:** S2 SRS, SDS, and shared contracts (docs/SRS.md, docs/SDS.md, web/src/core/types.ts).

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
- The Vite dev server accepts ngrok hosts (.ngrok-free.app, .ngrok-free.dev) so a phone can reach it.
