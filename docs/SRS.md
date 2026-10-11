# Software Requirements Specification: Kenshi

Version 0.3 (silent detector, step P1) · Source of truth for what we build. Design lives in [SDS.md](SDS.md). Changing a requirement needs the project owner's approval.

## 1. Introduction

### 1.1 Purpose
Kenshi is a real-time guide for blind and low-vision people. It runs on an iPhone in Safari. It is a "Find My" for blind users: the user names a target, a Google Gemini model finds it in camera frames, and the app guides the user to it with an arrow, spoken directions, and an audio beacon. An on-device object detector runs **silently** in the background: it never announces objects. Its boxes only feed the route, which bends around them, so the user is steered around objects without being read a list of them (step P1; the earlier Walk mode with spoken obstacle alerts was removed).

### 1.2 Scope and positioning
- Kenshi **complements the white cane and never replaces it**. Code, UI text, and docs must never claim otherwise.
- Demo form factor: the phone held at eye level, sideways (landscape), to simulate camera glasses. Glasses are a future target only; no integration is claimed.
- The detector never speaks about objects. It runs while the app is running, and its tracks feed the route (FR-28).
- Find guides the user toward one named target at a time. Its results are hints; the cane and the user's own judgment stay in charge.

### 1.3 Users
Blind and low-vision pedestrians who already walk with a cane or guide, using VoiceOver or not. Secondary users: the team and judges running field tests and demos.

### 1.4 Definitions
| Term | Meaning |
|---|---|
| Track | One object followed across frames; confirmed after it matches in 2 of 3 frames |
| In path | The object overlaps the walking corridor: about 0.5 m either side of center, up to 4 m ahead. The route bends around in-path objects |
| Healthy | Fresh detection results, enough frames per second, usable light, phone held up |
| Find | What the app does: the user names a target and the app guides them to it (FR-21 to FR-30) |
| Target | The thing the user wants to find, named by voice or chosen from the quick-pick list |
| Scan sweep | The user turns slowly while the app captures a frame about every 45 degrees, up to 8, and sends them in one request |
| Heading | The phone's compass-free yaw (rotation about the vertical axis) from the gyroscope, relative to where Find started |
| Beacon | A repeating pulse in the AirPods that speeds up as the target gets closer and is panned toward it |
| Gate A / Gate B | Go/no-go checks: iPhone inference speed (A), end-to-end integration (B) |

Target numbers named here (1.5 m, 2 s, and so on) live in `web/src/core/config.ts`; the values in this document are the starting defaults.

## 2. Assumptions and constraints
- **Device:** iPhone with Safari; rear camera. The app is a website opened in Safari, or added to the Home Screen (FR-29); it is not a store app.
- **Detection is on-device:** frames never leave the phone for it. **Find is not:** frames go through one Vercel function (`web/api/locate.ts`) to Google Gemini on the free tier, after the user accepts the privacy notice (FR-30). There is no other backend.
- **Audio:** the user wears AirPods in transparency mode so ambient sound stays audible. Speech and tones play through them.
- **Model:** YOLO26n exported to ONNX, run with onnxruntime-web in a Web Worker; WebGPU first, multi-threaded WebAssembly fallback (needs cross-origin isolation headers).
- **Hosting:** static site and one function on Vercel. The first load needs a network. There is no service worker, so offline use is not supported (NFR-8 removed), and Find needs a network every time.
- **Team:** about 6 hours remain after the pivot. One Claude Code runner writes the code; teammates commit docs and assets on their own branches.
- **No iPhone in CI:** everything touching camera, audio, sensors, voice, or layout is verified by hand on the phone.

## 3. Functional requirements

Verification methods: **Unit test** (Vitest on pure logic), **Field test** (a person trying the app on the phone by hand; there are no logged test rounds), **Inspection** (code, UI, or documents reviewed). The Replay method was removed with the test-log tooling (step R0).

| ID | Requirement | Verification |
|---|---|---|
| FR-1 | The app opens the rear camera in landscape and delivers frames to the detector at a capped rate, always processing the newest frame and never queueing old ones. It keeps the screen awake while running. | Field test |
| FR-2 | The app detects objects on the phone with the YOLO26n ONNX model in a Web Worker, using WebGPU when available and multi-threaded WebAssembly otherwise, with per-class confidence thresholds. The detections are never announced (SR-12); they feed the tracker and the route. | Unit test, Field test |
| FR-3 | The app reads the phone's pitch and roll from device orientation and maps them to the landscape camera axis. If the sensor is unavailable or permission is refused, it assumes the camera is level, prefers the box-size distance, and says that distances are less accurate. | Unit test, Field test |
| FR-4 | The app tracks detections across frames by IoU matching, confirms a track after it matches in 2 of 3 frames, and smooths box position and distance. | Unit test |
| FR-5 | The app measures each confirmed track's closing speed and time-to-contact, and flags tracks that are approaching, so the route can avoid them. | Unit test |
| FR-6 | The app gives each track a clock direction (12 o'clock within 15 degrees of straight ahead, 11 or 1 o'clock beyond that, and "far left" or "far right" when its box touches the left or right edge of the picture) from its horizontal angle, corrected for the phone's roll, and the calibrated horizontal field of view. | Unit test |
| FR-7 | The app estimates each track's distance in meters: from the ground plane using eye height and device pitch when possible, otherwise from box size and a per-class typical height. | Unit test, Field test |
| FR-8 | The app labels a track "on the floor" or "at head height" when its estimated vertical extent warrants it, and adds no label otherwise. | Unit test |
| FR-9 | **Removed** (step P1). Was: only in-path or approaching tracks were alert candidates. Tracks now feed the route only. | n/a |
| FR-10 | **Removed** (step P1). Was: the alert policy (priorities, cooldowns, bands, queue). | n/a |
| FR-11 | **Removed** (step P1). Was: the spoken obstacle phrase format. | n/a |
| FR-12 | **Removed** (step P1). Was: a panned lead-in tone before each obstacle phrase. The tone player stays for the beacon (FR-26) and warnings. | n/a |
| FR-13 | While the app is healthy and running, it plays a quiet heartbeat tick at a steady interval. The tick means the detector is running; it is not a path report (SR-2). | Field test, Unit test |
| FR-14 | The app monitors its health (stalled detection, low frame rate, low light, phone lowered or raised, camera or worker errors, blocked audio) and speaks and shows a distinct warning the moment a problem starts, repeating it until fixed. | Unit test, Field test |
| FR-15 | A tap anywhere starts listening for one voice command: pause, resume, slower, faster, help, and "find <target>" and "stop" (FR-21). The app confirms each command by voice. There is no command that lists objects. | Unit test, Field test |
| FR-16 | If speech recognition is unavailable or denied, the app says so once. A tap that hears nothing does nothing. A long press pauses or resumes. | Unit test, Field test |
| FR-17 | The app offers settings (eye height, speech rate, spoken feedback, tone and heartbeat volume) and a field-of-view calibration, stored on the device. Settings are reachable but out of the way. | Unit test, Field test, Inspection |
| FR-18 | The Start button unlocks audio and speech, and requests camera, motion-sensor, and microphone permissions, each with a spoken and written explanation and a recovery path if refused. | Field test |
| FR-19 | **Removed** (step R0). Was: Test mode logged frames, tracks, alerts, and health to an exportable file. The field-test tooling was dropped. | n/a |
| FR-20 | **Removed** (step R0). Was: the stretch "describe" command that sent one frame to Claude. Replaced by Find mode (FR-21 to FR-30). | n/a |
| FR-21 | **Find mode and target.** The user starts Find by voice ("find <target>") or from a quick-pick list of common targets, and can say "stop" or tap the cancel control at any time. The app confirms the target aloud before searching. | Unit test, Field test |
| FR-22 | **Locate.** The app sends the current frame (or the scan frames, FR-23), each with the phone's heading and pitch, to `web/api/locate.ts`, which asks a Gemini model which frame shows the target and where. The reply names the frame and a bounding box, or says the target was not found. The function validates its input, keeps the Gemini key server-side, and stores nothing. | Unit test, Field test, Inspection |
| FR-23 | **Scan sweep.** If the target is not in view, the app asks the user to turn slowly, captures a frame about every 45 degrees of heading change (at most 8), and sends them in one request. The app tells the user when to keep turning and when the sweep is done. | Unit test, Field test |
| FR-24 | **Heading and target memory.** The app stores the target's direction as a device heading (gyroscope yaw) with its estimated distance and the time it was seen, so guidance continues when the target is out of view. A stored target expires after a set time and is dropped when the user cancels. | Unit test, Field test |
| FR-25 | **Guidance.** Using the stored heading and the current heading, the app computes the turn needed (left or right and how many degrees), an estimated distance when it can, and an "aligned" state when the target is within a tolerance of straight ahead. It speaks GPS-style directions ("Turn right a little", "Straight ahead, about 3 meters") with cooldowns so speech never floods. | Unit test, Field test |
| FR-26 | **Audio beacon.** While guiding, the app plays a repeating pulse through the AirPods. The pulse rate rises as the target gets closer, and the pulse is panned toward the target's side. The beacon never masks or delays a health warning (SR-10). | Unit test, Field test |
| FR-27 | **Find screen.** While guiding, the screen shows a large arrow toward the target, the distance, and the target's name, and turns green when aligned. Everything on it is also spoken and written to an aria-live region (NFR-11). | Inspection, Field test |
| FR-28 | **Path line.** The app draws a walking line from the user toward the target that bends around tracked obstacles (`geometry/freeSpacePath.ts`, step R7). The spoken directions (FR-25) follow the first leg of the line, so the route steers around objects without the app naming them. The line is a hint (SR-2, SR-11). | Unit test, Inspection, Field test |
| FR-29 | **Home Screen install.** The app has a web manifest and icons so it can be added to the iPhone Home Screen and open full screen. It has no service worker. | Inspection, Field test |
| FR-30 | **Privacy notice.** Before the first Find, the app says and shows that frames are sent to Google Gemini, that on the free tier Google may use them to improve its products and human reviewers may read them, and that frames otherwise stay on the phone. Find does not start until the user accepts; the acceptance is stored and can be withdrawn in Settings. | Unit test, Field test, Inspection |

## 4. Non-functional requirements

Targets are measured on the team's demo iPhone in the field-test setup, in good light unless stated.

| ID | Requirement | Verification |
|---|---|---|
| NFR-1 | Detection rate is at least 8 frames per second, sustained. | Field test |
| NFR-2 | Inference time p95 is at most 120 ms per frame. | Field test |
| NFR-3 | **Removed** (step P1). Was: urgent tone latency. | n/a |
| NFR-4 | **Removed** (step P1). Was: spoken obstacle phrase latency. The stale limit (SR-3) still applies to any alert. | n/a |
| NFR-5 | In-path obstacle recall is at least 90% at 1.5 to 4 m in good light, for the classes the route avoids (to be measured; the route is only as good as this). | Field test |
| NFR-6 | **Removed** (step P1). Was: at most 1 false alert per minute. The detector no longer alerts. | n/a |
| NFR-7 | Estimated distance (to obstacles for the route, and to the target) is within plus or minus 30% of the true distance. | Field test |
| NFR-8 | **Removed** (step R0). Was: after the first load, the app works offline. There is no service worker and Find needs a network. | n/a |
| NFR-9 | No image leaves the device except on a Find request. Images leave only on a Find request, go only to the locate function and Gemini, and only after the privacy notice was accepted (FR-30). | Inspection |
| NFR-10 | The app runs 30 minutes of continuous use without crashing or running out of memory. | Field test |
| NFR-11 | The app is usable without looking at the screen. Every state change is spoken (unless spoken feedback is off) and written to an aria-live region. It works with VoiceOver on and off, in both landscape orientations and portrait, at large text sizes. | Field test, Inspection |
| NFR-12 | Inference and other heavy work never run on the main thread, so touch, audio, and speech stay responsive. | Inspection, Field test |
| NFR-13 | Each ONNX model file is under 15 MB, and the first load downloads the app and model within a reasonable time on a typical mobile connection. | Inspection |
| NFR-14 | Find locate time, from the end of the capture to a spoken first direction, is within a limit **to be measured** on the demo phone and network. The scan sweep sends at most 8 frames, each downscaled to a maximum side set in config, and the request has a timeout with a spoken failure. | Field test |
| NFR-15 | Beacon pulses start within a delay **to be measured** of the heading update that causes them, and the beacon and Find speech never delay a health warning (SR-10). | Field test |
| NFR-16 | The Home Screen app starts to a usable Start screen within a time **to be measured** after tapping its icon on a warm and a cold start. | Field test |

## 5. Safety requirements

This product is safety-critical. A safety requirement overrides any other requirement it conflicts with.

| ID | Requirement | Verification |
|---|---|---|
| SR-1 | Silence never means clear. While healthy and running, the heartbeat plays; when it cannot, a warning plays instead. | Unit test, Field test |
| SR-2 | The app never says, shows, or implies that the path is clear, safe, or free (for example "clear", "safe", "all good", "no obstacles"), in any mode. When Find does not see the target it says so as a limit (SR-11). | Unit test, Inspection |
| SR-3 | An alert older than the stale limit (1 s from its frame capture) is dropped before speaking, and an alert tied to a track is dropped if its track no longer exists. | Unit test |
| SR-4 | A health warning (SR-5) preempts all other speech and the beacon. | Unit test, Field test |
| SR-5 | When detection degrades (stalled, low frame rate, low light, camera or worker errors), the app says so immediately. | Unit test, Field test |
| SR-6 | When the phone is lowered or pointed far from the horizon, the app warns that detection may be unreliable. | Unit test, Field test |
| SR-7 | The docs state that Kenshi complements the white cane and does not replace it. The owner removed this sentence from the start screen, the spoken help, and the manifest; the alerts and status lines no longer mention it either. | Inspection |
| SR-8 | Every failure produces a spoken and on-screen message and a recovery path; no error is silently swallowed. | Unit test, Inspection |
| SR-9 | While paused, a distinct reminder repeats at a steady interval, so a paused app is never mistaken for a quiet path. | Unit test, Field test |
| SR-10 | Detection keeps running during Find. A health warning preempts any Find speech and silences the beacon while it plays; Find resumes afterwards. | Unit test, Field test |
| SR-11 | Find results are hints. When the target is not found the app says "I could not find it", never that it is not there. Find guidance never says or implies that the way to the target is clear or safe (SR-2 applies to every Find phrase) | Unit test, Inspection |
| SR-12 | **Silent detector.** Nothing in the app announces, lists, or describes detected objects by name, position, or distance: no alert, no summary, no voice command. Detections only shape the route (FR-28). A test sends frames with many close tracks through the pipeline and expects no alert. | Unit test, Inspection |

## 6. Out of scope
- Replacing the white cane or guide dog.
- Spoken obstacle alerts, object lists, and "what's around me" (the old Walk mode), dropped in step P1.
- Street-crossing guidance, traffic-signal detection, or any claim about crossing safety.
- Route navigation. Find guides to one target in view or remembered nearby; it does not plan routes, read maps, or use GPS.
- Telling stairs up from stairs down (the app may announce stairs only).
- Glasses integration, Android, or other browsers.
- Any backend beyond the single locate function (FR-22).
- Offline use, and any service worker.
- Hazard retraining (stairs, curb, pole, door), field-test rounds and tooling, and the Claude describe step were dropped in step R0.

## 7. Open items
- Gate A chose the 416 model input size. NFR-1 and NFR-2 still need confirming with recorded numbers from the demo iPhone, and again in the first field test.
- The horizontal field of view default (65°) is an estimate until calibration is measured on the demo phone.
- Whether Safari speech recognition works reliably with AirPods in transparency mode is unverified (FR-15, FR-16).
- Which Gemini model to use, its free-tier request limits, and its real latency are to be measured (FR-22, NFR-14). If the limit is hit the app must say so and offer a retry.
- How much gyroscope yaw drifts over a Find, and for how long a stored heading stays trustworthy (FR-24), are to be measured. Safari gives yaw only through device orientation events.
- The turning speed in a scan sweep and the 45 degree spacing are assumptions to check on the phone (FR-23).
