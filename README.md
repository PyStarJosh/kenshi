# Kenshi

A real-time guide for blind and low-vision people that runs on an iPhone in Safari. It is a "Find My" for blind users, being built: name a target and the app guides you to it. Camera frames are sent to Google Gemini through one Vercel function, only on a Find request. An on-device detector runs silently (frames stay on the phone); it never announces objects, and its boxes only make the walking route bend around them. Kenshi complements the white cane; it never replaces it. See `docs/SRS.md` and `docs/SDS.md` for what we build and how, and `PROGRESS.md` for the current state.

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

### Find (Gemini) setup

Find sends camera frames to Google Gemini through one Vercel function, `web/api/locate.ts`. It needs a Google AI Studio key (https://aistudio.google.com/apikey).

- **Vercel:** in the project's Settings, Environment Variables, add `GEMINI_API_KEY` (your key) and, optionally, `GEMINI_MODEL` (a Gemini model name; the default is `gemini-3.1-flash-lite`, which answered in 2 to 3.5 s in our checks). Redeploy after changing them. The key stays on the server and is never sent to the browser or committed.
- **Locally:** `vercel link` (Root Directory `web`), then put the same names in `web/.env.local` (git ignores it; `web/.env.example` lists them). `npm run dev` does not run the function. Run `npm run dev:api` in `web/` instead: it starts `vercel dev` on port 3000 (the app and `/api/locate`) with `.env.local` loaded, because `vercel dev` alone reads the Vercel project's Development variables and ignores that file.
- **Try it:** `node scripts/try-locate.mjs public/samples/bus.jpg bus http://localhost:3000` prints the status, the time, and the reply. With `?debug` on the app, the Locate panel sends the current camera frame and a typed target and shows the JSON.
- **On a phone:** the ngrok tunnel to `npm run dev` or `vite preview` (ports 5173 and 4173) serves the app only, with no `/api/locate`, so Find and the Locate panel report "No locate function ... on this server". Use the deployed URL, or run `npm run dev:api` and tunnel port 3000 (`ngrok http 3000`).
- **Free-tier privacy:** on Google's free tier, Google may use the pictures you send to improve its products, and human reviewers may read them. Kenshi sends pictures only when you start a Find, and only after you accept a notice saying so (FR-30). The function stores nothing and logs no images or targets.
- **Limits:** the app waits at least 6 seconds between searches and allows 8 per minute. The free tier has its own limits, which change; when it is out the app says the search service is busy.

### Python tooling

From the repo root: `uv sync --all-groups`. Export the model with `uv run --group ml python ml/export_onnx.py`. The Find function (step R2) needs `GEMINI_API_KEY` in Vercel and in `web/.env.local` for `vercel dev`; never commit it.

### If something fails

- `ENOENT ... package.json`: you are not in `web/`.
- `EBADENGINE` or "Unsupported engine": upgrade Node (`node --version` must be 22.12 or newer).
- Missing files after a merge: `git switch main && git pull`, then `npm install` again.
- Odd install errors: delete `web/node_modules` and run `npm install` again.
