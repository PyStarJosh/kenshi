# Field testing

Every test walk produces a log. The log can be scored against the SRS targets and replayed offline with other
settings, so tuning is measured and a walk never has to be repeated just to try a threshold.

Kenshi complements the white cane. It never replaces it, in tests or anywhere else.

## Safety rules (read before every session)

1. **A sighted spotter stays within arm's reach of the tester at all times.** No exceptions, including indoors.
2. **The tester keeps their eyes open and simply does not look at the screen.** Walk the way a blind user would
   rely on the audio, but with sight as the safety net. Do not test with eyes closed or covered.
3. **Never test near traffic, stair edges, platforms, or drop-offs** unless the spotter is holding the tester's arm
   and the obstacle under test is the only hazard. Prefer a flat, clear space.
4. **Daylight first.** Do the dim hallway scenario only after the daylight runs are done, with the lights on a
   known switch.
5. The spotter can stop any walk at any time. The tester stops the moment the spotter says "stop".
6. Stop and reset if the phone gets hot or the app speaks a health warning that does not clear.

## Setup

1. Charge the phone. Close other apps. Turn on Do Not Disturb.
2. Open the app, Settings: set the **eye height** (floor to the phone held at eye level) and make sure the
   **field of view** was calibrated on this phone. Turn **Test mode on**, then Back.
3. Start **iPhone screen recording** (Control Center) before tapping Start. Test mode shows the session clock and a
   large caption for each spoken alert, so the recording shows exactly what was said and when.
4. Put in the AirPods, **transparency mode on**. Hold the phone **sideways at eye level**, as it would sit on glasses.
5. Tap Start. The clock begins at zero at that tap. Note the walk's name (the file will be called
   `walk-<date>-<time>.jsonl`).
6. At the end of each walk, long-press to pause. Tap **Save test log** (the spotter can do this) and share the file
   to yourself (AirDrop, Files, or email). The log stays in the phone's memory until the app is reloaded, so save
   before closing the page. A warning appears on screen when the log is nearly full (about 20 MB, roughly
   twenty minutes).
7. Stop the screen recording and name it like the log.

## Scenarios

Do each scenario **three times**. Vary the start distance and the tester's walking speed a little between repeats.

| # | Scenario | What to set up |
|---|---|---|
| 1 | Backpack on the floor in the path | Backpack on the floor in the middle of a straight route; walk toward it from about 6 m. |
| 2 | Chair at 1 o'clock | Chair slightly to the right of the route, outside the 0.5 m path; walk past it. It should not be announced as in the path. |
| 3 | Person walking toward the tester | The spotter's helper walks toward the tester along the route from about 8 m. |
| 4 | Door | A closed door at the end of a corridor, then an open door at the side. |
| 5 | Box held at head height | A helper holds a box with its bottom edge at head height in the path (soft box, held still). |
| 6 | Pole | A pole, post, or street light in the path. |
| 7 | Cluttered room | Several chairs, bags, and boxes; walk a route through them. |
| 8 | Dim hallway | A hallway with the lights low, but never dark enough to be unsafe. |
| 9 | Outdoor sidewalk with the spotter | A quiet sidewalk, spotter at arm's reach, away from the road edge and any driveway. |

## Labeling

After each walk, fill `field-tests/<round>/labels.csv` (start from `field-tests/labels-template.csv`) **from the screen
recording**, using the on-screen session clock. One row per physical obstacle in the route:

| Column | Meaning |
|---|---|
| `walk_id` | The log file name without `.jsonl`, for example `walk-2026-10-10-143005`. |
| `obstacle_id` | Any unique name within the walk, for example `backpack-1`. |
| `spoken_name` | The name the app speaks for it ("backpack", "chair", "person", "door", "pole"). |
| `t_visible_s` | Session clock time when the obstacle is first clearly visible in the picture. |
| `t_reached_s` | Session clock time when the tester would reach it (arm's length, or where the spotter stopped them). |
| `in_path` | `yes` if it is in the walking path (within about 0.5 m of the route, within 4 m) or coming into it; `no` if it is beside the route. |
| `notes` | Anything odd: lighting, a second object, the app's phrase if it was wrong. |

Label every obstacle, including the ones that should not be announced (`in_path` = `no`), or they will count as
false alerts when the app speaks about them.

## Scoring a round

Put the logs and `labels.csv` in `field-tests/<round>/`, then:

```
uv run --group analysis python ml/eval_walks.py <round>
```

This writes `results/<round>/report.md` and PNG charts: in-path recall, false alerts per minute, mean alert lead
time, repeat alerts per object, inference p50 and p95, capture-to-tone and capture-to-speech p50 and p95, frame rate
over time (a falling line is thermal slowdown), and a pass or fail table against the SRS targets (NFR-1 to NFR-6).
Defaults: an in-path obstacle counts as recalled if it was announced at least 1 s before `t_reached_s`
(`--lead-s`); an alert is matched to an obstacle within 1 s of its visible-to-reached window (`--slack-s`).
NFR-7 (distance accuracy) is checked by hand against a tape measure and is not in the report.

## Replaying a walk with other settings

```
cd web
npx tsx scripts/replay.ts ../field-tests/<round>/<walk>.jsonl --check
```

With no overrides the replay must reproduce the walk's alerts (`--check` exits 1 if it does not). To try a change,
write only the values to change, in the shape of `web/src/core/config.ts`:

```
{ "alerts": { "urgentDistanceM": 2 }, "tracking": { "confirmationHits": 2 } }
```

```
npx tsx scripts/replay.ts ../field-tests/<round>/<walk>.jsonl --overrides overrides.json
uv run --group analysis python ml/eval_walks.py <round> --logs field-tests/<round>/replay --out results/<round>-try1
```

Notes: add `--use-logged-config` to start from the settings the walk ran with instead of today's `config.ts`.
A replay can raise a detection confidence threshold but not lower it, because the log only holds detections that
passed the live thresholds. With overrides, tone and speech timing are not simulated, so the timing rows are
`n/a`; use the original logs for latency. Replays are written to `field-tests/<round>/replay/` (git ignores them).

`field-tests/fixture/` holds a **simulated** walk (not a real recording) with matching labels, used by the replay and
evaluation tests. Regenerate it with `npx tsx scripts/make-fixture.ts` if the log format changes.
