# Software Requirements Specification: Kenshi

Version 0.1 · Source of truth for what we build. Design lives in [SDS.md](SDS.md). Changing a requirement needs the project owner's approval.

## 1. Introduction

### 1.1 Purpose
Kenshi is a real-time obstacle guide for blind and low-vision pedestrians. It runs entirely on an iPhone in Safari: the rear camera feeds an on-device object detector, and the app speaks short, guide-style alerts such as "Backpack, 1 o'clock, about 2 meters, on the floor."

### 1.2 Scope and positioning
- Kenshi **complements the white cane and never replaces it**. Code, UI text, and docs must never claim otherwise.
- Demo form factor: the phone held at eye level, sideways (landscape), to simulate camera glasses. Glasses are a future target only; no integration is claimed.
- Walk mode only. The app announces confirmed obstacles that are in the walking path or approaching.

### 1.3 Users
Blind and low-vision pedestrians who already walk with a cane or guide, using VoiceOver or not. Secondary users: the team and judges running field tests and demos.

### 1.4 Definitions
| Term | Meaning |
|---|---|
| Track | One object followed across frames; confirmed after it matches in 2 of 3 frames |
| In path | The object overlaps the walking corridor: about 0.5 m either side of center, up to 4 m ahead |
| Urgent | An in-path object within 1.5 m, or with time-to-contact of 2 s or less |
| Healthy | Fresh detection results, enough frames per second, usable light, phone held up |
| Gate A / Gate B | Go/no-go checks: iPhone inference speed (A), end-to-end integration (B) |

Target numbers named here (1.5 m, 2 s, and so on) live in `web/src/core/config.ts`; the values in this document are the starting defaults.

## 2. Assumptions and constraints
- **Device:** iPhone with Safari; rear camera. The app is a website opened in Safari, not an installed app.
- **On-device only:** frames never leave the phone. There is no backend, except the optional stretch feature FR-20 (one Vercel function).
- **Audio:** the user wears AirPods in transparency mode so ambient sound stays audible. Speech and tones play through them.
- **Model:** YOLO26n exported to ONNX, run with onnxruntime-web in a Web Worker; WebGPU first, multi-threaded WebAssembly fallback (needs cross-origin isolation headers).
- **Hosting:** static site on Vercel; first load needs a network, later use must work offline (NFR-8).
- **Team:** three people, 36 hours, three Claude Code sessions in parallel.
- **No iPhone in CI:** everything touching camera, audio, sensors, voice, or layout is verified by hand on the phone.

## 3. Functional requirements

Verification methods: **Unit test** (Vitest on pure logic), **Replay** (recorded test log run through the pipeline offline), **Field test** (a person walking with the phone), **Inspection** (code, UI, or documents reviewed).

| ID | Requirement | Verification |
|---|---|---|
| FR-1 | The app opens the rear camera in landscape and delivers frames to the detector at a capped rate, always processing the newest frame and never queueing old ones. It keeps the screen awake while running. | Field test |
| FR-2 | The app detects objects on the phone with the YOLO26n ONNX model in a Web Worker, using WebGPU when available and multi-threaded WebAssembly otherwise, with per-class confidence thresholds. | Unit test, Field test |
| FR-3 | The app reads the phone's pitch and roll from device orientation and maps them to the landscape camera axis. If the sensor is unavailable or permission is refused, it assumes the camera is level, prefers the box-size distance, and says that distances are less accurate. | Unit test, Field test |
| FR-4 | The app tracks detections across frames by IoU matching, confirms a track after it matches in 2 of 3 frames, and smooths box position and distance. | Unit test, Replay |
| FR-5 | The app measures each confirmed track's closing speed and time-to-contact, and flags tracks that are approaching. | Unit test, Replay |
| FR-6 | The app gives each track a clock direction (12 o'clock within 15 degrees of straight ahead, 11 or 1 o'clock beyond that, and "far left" or "far right" when its box touches the left or right edge of the picture) from its horizontal angle, corrected for the phone's roll, and the calibrated horizontal field of view. | Unit test, Replay |
| FR-7 | The app estimates each track's distance in meters: from the ground plane using eye height and device pitch when possible, otherwise from box size and a per-class typical height. | Unit test, Replay, Field test |
| FR-8 | The app labels a track "on the floor" or "at head height" when its estimated vertical extent warrants it, and adds no label otherwise. | Unit test, Replay |
| FR-9 | The app treats a track as an alert candidate only if it is in the walking path or approaching it. | Unit test, Replay |
| FR-10 | The app decides which alerts to speak using priorities (urgent, normal, info), per-track cooldowns, re-announcement on entering a closer band, and a short queue. Only one alert is spoken at a time. | Unit test, Replay |
| FR-11 | Spoken obstacle alerts use the format `<object>, <clock> o'clock, about <meters> meters[, on the floor \| , at head height]`, with meters rounded to the nearest 0.5. | Unit test |
| FR-12 | Before each obstacle phrase the app plays a short tone panned toward the object's direction; urgent alerts use a distinct tone. | Field test, Inspection |
| FR-13 | While the app is healthy and running, it plays a quiet heartbeat tick at a steady interval. | Field test, Unit test |
| FR-14 | The app monitors its health (stalled detection, low frame rate, low light, phone lowered or raised, camera or worker errors, blocked audio) and speaks and shows a distinct warning the moment a problem starts, repeating it until fixed. | Unit test, Field test |
| FR-15 | A tap anywhere starts listening for one voice command: "what's around me", pause, resume, repeat, slower, faster, help. The app confirms each command by voice. | Unit test, Field test |
| FR-16 | If speech recognition is unavailable, denied, or hears nothing, a tap alone runs "what's around me". A long press pauses or resumes. | Field test |
| FR-17 | The app offers settings (eye height, speech rate, spoken feedback, tone and heartbeat volume, test mode) and a field-of-view calibration, stored on the device. Settings are reachable but out of the way. | Unit test, Field test, Inspection |
| FR-18 | The Start button unlocks audio and speech, and requests camera, motion-sensor, and microphone permissions, each with a spoken and written explanation and a recovery path if refused. | Field test |
| FR-19 | In Test mode the app logs frames, tracks, alerts, health changes, and voice commands to a file the user can export. Logs stay on the device until exported. | Unit test, Replay, Inspection |
| FR-20 | **Stretch.** On the spoken command "describe", the app sends one frame to a Vercel function that asks Claude for a short description, and speaks the result. This is the only time a frame leaves the phone, and only on that command. | Field test, Inspection |

## 4. Non-functional requirements

Targets are measured on the team's demo iPhone in the field-test setup, in good light unless stated.

| ID | Requirement | Verification |
|---|---|---|
| NFR-1 | Detection rate is at least 8 frames per second, sustained. | Field test |
| NFR-2 | Inference time p95 is at most 120 ms per frame. | Field test |
| NFR-3 | An urgent tone starts within 300 ms of the capture of the frame that confirms the hazard. | Field test, Replay |
| NFR-4 | A spoken obstacle phrase starts within 600 ms of the capture of the frame that confirms the hazard. | Field test |
| NFR-5 | In-path obstacle recall is at least 90% at 1.5 to 4 m in good light, for the classes the app announces. | Field test, Replay |
| NFR-6 | Walk mode produces at most 1 false alert per minute. | Field test, Replay |
| NFR-7 | Announced distance is within plus or minus 30% of the true distance. | Field test |
| NFR-8 | After the first load, the app works offline, including the model. | Field test |
| NFR-9 | No image leaves the device, except the explicit "describe" command (FR-20). | Inspection |
| NFR-10 | The app runs 30 minutes of continuous use without crashing or running out of memory. | Field test |
| NFR-11 | The app is usable without looking at the screen. Every state change is spoken (unless spoken feedback is off) and written to an aria-live region. It works with VoiceOver on and off, in both landscape orientations and portrait, at large text sizes. | Field test, Inspection |
| NFR-12 | Inference and other heavy work never run on the main thread, so touch, audio, and speech stay responsive. | Inspection, Field test |
| NFR-13 | Each ONNX model file is under 15 MB, and the first load downloads the app and model within a reasonable time on a typical mobile connection. | Inspection |

## 5. Safety requirements

This product is safety-critical. A safety requirement overrides any other requirement it conflicts with.

| ID | Requirement | Verification |
|---|---|---|
| SR-1 | Silence never means clear. While healthy and running, the heartbeat plays; when it cannot, a warning plays instead. | Unit test, Field test |
| SR-2 | The app never says, shows, or implies that the path is clear, safe, or free (for example "clear", "safe", "all good", "no obstacles"). When it detects nothing it says so as a limit, for example that it may miss things and the cane should stay in use. | Unit test, Inspection |
| SR-3 | An alert older than the stale limit (1 s from its frame capture) is dropped before speaking, and an obstacle alert is dropped if its track no longer exists. | Unit test, Replay |
| SR-4 | Urgent alerts preempt all other speech, summaries, and descriptions. | Unit test, Field test |
| SR-5 | When detection degrades (stalled, low frame rate, low light, camera or worker errors), the app says so immediately. | Unit test, Field test |
| SR-6 | When the phone is lowered or pointed far from the horizon, the app warns that detection may be unreliable. | Unit test, Field test |
| SR-7 | The first-run text, help, and docs state that Kenshi complements the white cane and does not replace it. | Inspection |
| SR-8 | Every failure produces a spoken and on-screen message and a recovery path; no error is silently swallowed. | Unit test, Inspection |
| SR-9 | While paused, a distinct reminder repeats at a steady interval, so a paused app is never mistaken for a quiet path. | Unit test, Field test |

## 6. Out of scope
- Replacing the white cane or guide dog.
- Street-crossing guidance, traffic-signal detection, or any claim about crossing safety.
- Route navigation or turn-by-turn directions.
- Telling stairs up from stairs down (the app may announce stairs only).
- Glasses integration, Android, or other browsers.
- Any backend beyond the optional FR-20 function.

## 7. Open items
- Gate A chose the 416 model input size. NFR-1 and NFR-2 still need confirming with recorded numbers from the demo iPhone, and again in the first field test.
- The horizontal field of view default (65°) is an estimate until calibration is measured on the demo phone.
- Whether Safari speech recognition works reliably with AirPods in transparency mode is unverified (FR-15, FR-16).
