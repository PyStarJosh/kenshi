"""Score field-test walks against the SRS targets.

    uv run --group analysis python ml/eval_walks.py <round>

Reads every walk-*.jsonl in field-tests/<round>/ (test logs, or replay output: point --logs at the replay
folder) and field-tests/<round>/labels.csv (columns walk_id, obstacle_id, spoken_name, t_visible_s,
t_reached_s, in_path, notes; walk_id is the log file name without .jsonl). Writes results/<round>/report.md
and PNG charts.

How alerts are scored
- An alert counts as spoken if the audio engine started it (or, in a simulated replay, finished it). Its time
  is the speech start, else the tone start, else the moment the policy created it.
- An alert belongs to a labeled obstacle with the same spoken name when its time lies between
  t_visible_s - slack and t_reached_s + slack (default slack 1 s); if windows overlap, the nearest t_reached wins.
- In-path recall: a labeled in-path obstacle is recalled if its first alert came at least --lead-s before
  t_reached_s (default 1 s).
- False alert: a spoken alert that belongs to no labeled in-path obstacle (including one about an object
  labeled as out of the path). The rate is per minute of active time (paused time is not counted).
- Repeat alerts: alerts for the same in-path obstacle after its first.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent

DEFAULT_LEAD_S = 1.0
DEFAULT_SLACK_S = 1.0
FPS_WINDOW_S = 5.0
LABEL_COLUMNS = ["walk_id", "obstacle_id", "spoken_name", "t_visible_s", "t_reached_s", "in_path", "notes"]

# SRS targets (docs/SRS.md section 4). Each: id, text, limit, direction.
TARGETS = {
    "NFR-1": ("Detection rate sustained (lowest 5 s window)", 8.0, "min", "fps"),
    "NFR-2": ("Inference time p95", 120.0, "max", "ms"),
    "NFR-3": ("Urgent tone starts after capture, p95", 300.0, "max", "ms"),
    "NFR-4": ("Spoken phrase starts after capture, p95", 600.0, "max", "ms"),
    "NFR-5": ("In-path obstacle recall", 0.9, "min", ""),
    "NFR-6": ("False alerts per minute", 1.0, "max", "/min"),
}

# Colors from the dataviz reference palette (light mode).
BLUE, ORANGE, AQUA, RED, INK, MUTED, GRID = "#2a78d6", "#eb6834", "#1baf7a", "#e34948", "#0b0b0b", "#52514e", "#e5e4e0"
SURFACE = "#fcfcfb"


@dataclass
class Alert:
    id: str
    priority: str
    phrase: str
    frame_s: float
    created_s: float
    tone_s: float | None = None
    speech_s: float | None = None
    outcomes: set[str] = field(default_factory=set)

    @property
    def name(self) -> str:
        return self.phrase.split(",")[0].strip().lower()

    @property
    def spoken(self) -> bool:
        return bool(self.outcomes & {"started", "finished", "preempted"})

    @property
    def time_s(self) -> float:
        for t in (self.speech_s, self.tone_s):
            if t is not None:
                return t
        return self.created_s


@dataclass
class Walk:
    walk_id: str
    frames: pd.DataFrame  # capture_s, inference_ms, fps
    alerts: list[Alert]
    paused: list[tuple[float, float]]  # [start_s, end_s) while detection was not running
    active_s: float
    meta: dict


def read_events(path: Path) -> list[dict]:
    events = []
    for number, line in enumerate(path.read_text().splitlines(), start=1):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise ValueError(f"{path.name} line {number} is not valid JSON: {error}") from error
    return events


def load_walk(path: Path) -> Walk:
    events = read_events(path)
    session = next((e for e in events if e["kind"] == "session"), None)
    if session is None:
        raise ValueError(f"{path.name} has no session entry")
    frame_rows = [
        {"capture_s": e["captureTimeMs"] / 1000, "inference_ms": e["timings"]["inferenceMs"]}
        for e in events
        if e["kind"] == "frame"
    ]
    frames = pd.DataFrame(frame_rows, columns=["capture_s", "inference_ms"])

    alerts: dict[str, Alert] = {}
    for e in events:
        if e["kind"] != "alert":
            continue
        a = e["alert"]
        alert = alerts.setdefault(
            a["id"],
            Alert(a["id"], a["priority"], a["phrase"], a["frameTimeMs"] / 1000, a["createdTimeMs"] / 1000),
        )
        if e["outcome"] != "queued":
            alert.outcomes.add(e["outcome"])
        # The same alert id can come back after a pause reset the policy; the first wins for timing fields.
        if e.get("toneStartMs") is not None and alert.tone_s is None:
            alert.tone_s = e["toneStartMs"] / 1000
        if e.get("speechStartMs") is not None and alert.speech_s is None:
            alert.speech_s = e["speechStartMs"] / 1000

    paused: list[tuple[float, float]] = []
    stopped_at: float | None = None
    for e in events:
        if e["kind"] != "run-state":
            continue
        t = e["timeMs"] / 1000
        if e["state"] != "running" and stopped_at is None:
            stopped_at = t
        elif e["state"] == "running" and stopped_at is not None:
            paused.append((stopped_at, t))
            stopped_at = None
    if stopped_at is not None and len(frames):
        paused.append((stopped_at, float(frames["capture_s"].max())))

    active_s = 0.0
    if len(frames):
        times = frames["capture_s"].to_numpy()
        gaps = np.diff(times)
        # Gaps longer than 2 s are pauses or stalls, not active detection time.
        active_s = float(gaps[gaps <= 2.0].sum())
    return Walk(path.stem, frames, list(alerts.values()), paused, active_s, session)


def load_labels(path: Path) -> pd.DataFrame:
    labels = pd.read_csv(path, dtype={"walk_id": str, "obstacle_id": str, "spoken_name": str, "in_path": str})
    missing = [c for c in LABEL_COLUMNS if c not in labels.columns]
    if missing:
        raise ValueError(f"{path} is missing columns: {', '.join(missing)}")
    labels["in_path"] = labels["in_path"].str.strip().str.lower()
    bad = labels[~labels["in_path"].isin(["yes", "no"])]
    if len(bad):
        raise ValueError(f"{path}: in_path must be yes or no (obstacle {', '.join(bad['obstacle_id'])})")
    labels["spoken_name"] = labels["spoken_name"].str.strip().str.lower()
    return labels


def assign_alerts(alerts: list[Alert], obstacles: pd.DataFrame, slack_s: float) -> dict[str, list[Alert]]:
    """Map obstacle_id -> its spoken alerts, in time order. Alerts that fit no obstacle are left out."""
    assigned: dict[str, list[Alert]] = {oid: [] for oid in obstacles["obstacle_id"]}
    for alert in sorted((a for a in alerts if a.spoken), key=lambda a: a.time_s):
        best, best_gap = None, None
        for row in obstacles.itertuples():
            if row.spoken_name != alert.name:
                continue
            if not (row.t_visible_s - slack_s <= alert.time_s <= row.t_reached_s + slack_s):
                continue
            gap = abs(row.t_reached_s - alert.time_s)
            if best is None or gap < best_gap:
                best, best_gap = row.obstacle_id, gap
        if best is not None:
            assigned[best].append(alert)
    return assigned


def percentiles(values) -> tuple[float, float] | None:
    arr = np.asarray(list(values), dtype=float)
    if arr.size == 0:
        return None
    return float(np.percentile(arr, 50)), float(np.percentile(arr, 95))


def fps_windows(walk: Walk, window_s: float = FPS_WINDOW_S) -> pd.DataFrame:
    """Frames per second in consecutive windows, skipping windows that overlap a pause or run past the last frame."""
    if walk.frames.empty:
        return pd.DataFrame(columns=["start_s", "fps"])
    times = walk.frames["capture_s"].to_numpy()
    start, end = float(times.min()), float(times.max())
    rows = []
    t = start
    while t + window_s <= end:
        overlaps = any(p0 < t + window_s and p1 > t for p0, p1 in walk.paused)
        if not overlaps:
            count = int(((times >= t) & (times < t + window_s)).sum())
            rows.append({"start_s": t, "fps": count / window_s})
        t += window_s
    return pd.DataFrame(rows, columns=["start_s", "fps"])


@dataclass
class WalkScore:
    walk_id: str
    active_min: float
    labeled: bool
    in_path_total: int = 0
    recalled: int = 0
    missed: list[str] = field(default_factory=list)
    lead_s: list[float] = field(default_factory=list)
    spoken: int = 0
    false_alerts: int | None = None
    repeats: dict[str, int] = field(default_factory=dict)
    inference_ms: list[float] = field(default_factory=list)
    to_tone_ms: list[float] = field(default_factory=list)
    to_tone_urgent_ms: list[float] = field(default_factory=list)
    to_speech_ms: list[float] = field(default_factory=list)
    fps: pd.DataFrame = field(default_factory=lambda: pd.DataFrame(columns=["start_s", "fps"]))
    assigned: dict[str, list[Alert]] = field(default_factory=dict)
    replay: dict | None = None


def score_walk(walk: Walk, labels: pd.DataFrame | None, lead_s: float, slack_s: float) -> WalkScore:
    score = WalkScore(walk.walk_id, walk.active_s / 60, labels is not None and len(labels) > 0)
    score.replay = walk.meta.get("replay")
    score.inference_ms = walk.frames["inference_ms"].tolist()
    score.fps = fps_windows(walk)
    spoken = [a for a in walk.alerts if a.spoken]
    score.spoken = len(spoken)
    for a in spoken:
        if a.tone_s is not None:
            score.to_tone_ms.append((a.tone_s - a.frame_s) * 1000)
            if a.priority == "urgent":
                score.to_tone_urgent_ms.append((a.tone_s - a.frame_s) * 1000)
        if a.speech_s is not None:
            score.to_speech_ms.append((a.speech_s - a.frame_s) * 1000)
    if not score.labeled:
        return score

    assert labels is not None
    score.assigned = assign_alerts(walk.alerts, labels, slack_s)
    in_path = labels[labels["in_path"] == "yes"]
    matched_ids = set()
    for row in in_path.itertuples():
        mine = score.assigned[row.obstacle_id]
        matched_ids.update(a.id for a in mine)
        score.in_path_total += 1
        first = mine[0].time_s if mine else None
        if first is not None and first <= row.t_reached_s - lead_s:
            score.recalled += 1
            score.lead_s.append(row.t_reached_s - first)
        else:
            score.missed.append(row.obstacle_id)
        score.repeats[row.obstacle_id] = max(0, len(mine) - 1)
    score.false_alerts = sum(1 for a in spoken if a.id not in matched_ids)
    return score


def check(target_id: str, value: float | None) -> str:
    _, limit, direction, _ = TARGETS[target_id]
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return "NO DATA"
    ok = value >= limit if direction == "min" else value <= limit
    return "PASS" if ok else "FAIL"


def overall_values(scores: list[WalkScore]) -> dict[str, float | None]:
    fps_all = pd.concat([s.fps for s in scores], ignore_index=True) if scores else pd.DataFrame(columns=["fps"])
    inference = percentiles([x for s in scores for x in s.inference_ms])
    urgent = percentiles([x for s in scores for x in s.to_tone_urgent_ms])
    speech = percentiles([x for s in scores for x in s.to_speech_ms])
    labeled = [s for s in scores if s.labeled]
    in_path = sum(s.in_path_total for s in labeled)
    minutes = sum(s.active_min for s in labeled)
    return {
        "NFR-1": float(fps_all["fps"].min()) if len(fps_all) else None,
        "NFR-2": inference[1] if inference else None,
        "NFR-3": urgent[1] if urgent else None,
        "NFR-4": speech[1] if speech else None,
        "NFR-5": (sum(s.recalled for s in labeled) / in_path) if in_path else None,
        "NFR-6": (sum(s.false_alerts or 0 for s in labeled) / minutes) if labeled and minutes > 0 else None,
    }


def fmt(value: float | None, digits: int = 1) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def pair(values, digits: int = 0) -> str:
    p = percentiles(values)
    return "n/a" if p is None else f"{p[0]:.{digits}f} / {p[1]:.{digits}f}"


def fps_trend(fps: pd.DataFrame) -> str:
    """Mean frame rate of the first and last third of the walk, to spot thermal slowdown."""
    if len(fps) < 3:
        return "n/a"
    third = max(1, len(fps) // 3)
    first, last = fps["fps"].iloc[:third].mean(), fps["fps"].iloc[-third:].mean()
    return f"{first:.1f} -> {last:.1f}"


def draw_charts(scores: list[WalkScore], walks: dict[str, Walk], labels: pd.DataFrame | None, lead_s: float, out: Path) -> list[str]:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update(
        {
            "figure.facecolor": SURFACE,
            "axes.facecolor": SURFACE,
            "axes.edgecolor": MUTED,
            "axes.labelcolor": INK,
            "text.color": INK,
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.grid": True,
            "grid.color": GRID,
            "grid.linewidth": 0.8,
            "font.size": 10,
        }
    )
    files = []

    fig, ax = plt.subplots(figsize=(8, 3.5))
    series = [BLUE, ORANGE, AQUA, RED]
    for i, s in enumerate(scores):
        if len(s.fps):
            ax.plot(s.fps["start_s"] + FPS_WINDOW_S / 2, s.fps["fps"], color=series[i % 4], linewidth=2, label=s.walk_id)
    ax.axhline(TARGETS["NFR-1"][1], color=RED, linewidth=1, linestyle="--")
    ax.text(0.01, TARGETS["NFR-1"][1], " NFR-1: 8 fps", transform=ax.get_yaxis_transform(), va="bottom", color=MUTED)
    ax.set_xlabel("session time (s)")
    ax.set_ylabel("frames per second (5 s windows)")
    ax.set_ylim(bottom=0)
    ax.set_title("Detection rate over time")
    if scores:
        ax.legend(frameon=False, loc="lower right")
    fig.tight_layout()
    fig.savefig(out / "fps_over_time.png", dpi=150)
    plt.close(fig)
    files.append("fps_over_time.png")

    fig, axes = plt.subplots(1, 3, figsize=(11, 3.5))
    panels = [
        ("Inference time (ms)", [x for s in scores for x in s.inference_ms], TARGETS["NFR-2"][1], "NFR-2 p95 120"),
        ("Capture to tone (ms)", [x for s in scores for x in s.to_tone_ms], TARGETS["NFR-3"][1], "NFR-3 urgent 300"),
        ("Capture to speech (ms)", [x for s in scores for x in s.to_speech_ms], TARGETS["NFR-4"][1], "NFR-4 600"),
    ]
    for ax, (title, values, limit, limit_label) in zip(axes, panels):
        ax.set_title(title)
        if values:
            ax.hist(values, bins=20, color=BLUE, edgecolor=SURFACE, linewidth=1)
            ax.axvline(limit, color=RED, linewidth=1, linestyle="--")
            ax.text(limit, ax.get_ylim()[1], f" {limit_label}", va="top", color=MUTED, fontsize=8)
        else:
            ax.text(0.5, 0.5, "no data", ha="center", va="center", transform=ax.transAxes, color=MUTED)
        ax.set_ylabel("count")
    fig.tight_layout()
    fig.savefig(out / "latency.png", dpi=150)
    plt.close(fig)
    files.append("latency.png")

    if labels is not None:
        for s in scores:
            if not s.labeled:
                continue
            mine = labels[labels["walk_id"] == s.walk_id].reset_index(drop=True)
            fig, ax = plt.subplots(figsize=(8, 0.9 + 0.7 * len(mine)))
            in_path_ids = set(mine.loc[mine["in_path"] == "yes", "obstacle_id"])
            matched = {a.id for oid in in_path_ids for a in s.assigned.get(oid, [])}
            for i, row in mine.iterrows():
                color = BLUE if row["in_path"] == "yes" else MUTED
                ax.barh(i, row["t_reached_s"] - row["t_visible_s"], left=row["t_visible_s"], height=0.5, color=color, alpha=0.35)
                ax.plot([row["t_reached_s"] - lead_s] * 2, [i - 0.3, i + 0.3], color=INK, linewidth=1, linestyle=":")
                for a in s.assigned.get(row["obstacle_id"], []):
                    ax.plot(a.time_s, i, marker="o", markersize=8, color=AQUA, markeredgecolor=SURFACE, markeredgewidth=1.5)
            walk = walks[s.walk_id]
            for a in walk.alerts:
                if a.spoken and a.id not in matched:
                    ax.axvline(a.time_s, color=RED, linewidth=1.5)
            ax.set_yticks(range(len(mine)))
            ax.set_yticklabels([f"{r.obstacle_id} ({r.in_path})" for r in mine.itertuples()])
            ax.invert_yaxis()
            ax.set_xlabel("session time (s)")
            ax.set_title(f"{s.walk_id}: obstacles (bars), alerts (green dots), false alerts (red lines)")
            ax.grid(axis="y", visible=False)
            fig.tight_layout()
            name = f"timeline_{s.walk_id}.png"
            fig.savefig(out / name, dpi=150)
            plt.close(fig)
            files.append(name)
    return files


def write_report(
    round_name: str,
    scores: list[WalkScore],
    walks: dict[str, Walk],
    labels: pd.DataFrame | None,
    chart_files: list[str],
    lead_s: float,
    slack_s: float,
    out: Path,
    warnings: list[str],
) -> Path:
    values = overall_values(scores)
    lines = [f"# Walk evaluation: {round_name}", ""]
    replayed = [s for s in scores if s.replay]
    if replayed:
        lines += [
            (
                f"{len(replayed)} of {len(scores)} walks are replay output "
                f"(audio: {replayed[0].replay['audio']}); tone and speech timing come from the original walk only when the audio was logged."
            ),
            "",
        ]
    lines += [f"Walks: {len(scores)}. Lead time required: {lead_s:g} s. Label slack: {slack_s:g} s.", ""]
    for w in warnings:
        lines.append(f"> Warning: {w}")
    if warnings:
        lines.append("")

    lines += ["## SRS targets", "", "| ID | Target | Limit | Measured | Result |", "|---|---|---|---|---|"]
    for tid, (text, limit, direction, unit) in TARGETS.items():
        value = values[tid]
        digits = 2 if tid in ("NFR-5", "NFR-6") else 1
        limit_text = f"{'at least' if direction == 'min' else 'at most'} {limit:g} {unit}".strip()
        lines.append(f"| {tid} | {text} | {limit_text} | {fmt(value, digits)} | {check(tid, value)} |")
    lines += [
        "",
        (
            "NFR-3 is judged on urgent alerts and NFR-4 on all spoken alerts. NFR-7 (distance accuracy) needs measured "
            "distances, which the labels do not have, so it is not scored here."
        ),
        "",
        "## Per walk",
        "",
        "| Walk | Active min | In-path recall | Missed | Mean lead (s) | False alerts | False/min | Repeats/object | Spoken |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for s in scores:
        if s.labeled:
            recall = f"{s.recalled}/{s.in_path_total}" if s.in_path_total else "n/a"
            repeats = fmt(float(np.mean(list(s.repeats.values()))), 2) if s.repeats else "n/a"
            per_min = fmt((s.false_alerts or 0) / s.active_min, 2) if s.active_min > 0 else "n/a"
            lines.append(
                f"| {s.walk_id} | {s.active_min:.1f} | {recall} | {', '.join(s.missed) or '-'} | "
                f"{fmt(float(np.mean(s.lead_s)) if s.lead_s else None, 2)} | {s.false_alerts} | {per_min} | {repeats} | {s.spoken} |"
            )
        else:
            lines.append(f"| {s.walk_id} | {s.active_min:.1f} | no labels | - | - | - | - | - | {s.spoken} |")

    lines += [
        "",
        "## Timing per walk (p50 / p95)",
        "",
        "| Walk | Inference (ms) | Capture to tone (ms) | Capture to speech (ms) | Frame rate, first third -> last third (fps) | Lowest 5 s window (fps) |",
        "|---|---|---|---|---|---|",
    ]
    for s in scores:
        low = float(s.fps["fps"].min()) if len(s.fps) else None
        lines.append(
            f"| {s.walk_id} | {pair(s.inference_ms)} | {pair(s.to_tone_ms)} | {pair(s.to_speech_ms)} | {fps_trend(s.fps)} | {fmt(low)} |"
        )

    repeat_rows = [(s.walk_id, oid, n) for s in scores for oid, n in s.repeats.items()]
    if repeat_rows:
        lines += ["", "## Repeat alerts per in-path object", "", "| Walk | Obstacle | Repeats |", "|---|---|---|"]
        lines += [f"| {w} | {o} | {n} |" for w, o, n in repeat_rows]

    if chart_files:
        lines += ["", "## Charts", ""]
        lines += [f"![{name}]({name})" for name in chart_files]
    path = out / "report.md"
    path.write_text("\n".join(lines) + "\n")
    return path


def evaluate(logs_dir: Path, labels_path: Path | None, out: Path, round_name: str, lead_s: float, slack_s: float) -> Path:
    log_files = sorted(logs_dir.glob("*.jsonl"))
    if not log_files:
        raise FileNotFoundError(f"No .jsonl logs in {logs_dir}")
    warnings: list[str] = []
    labels = None
    if labels_path is not None and labels_path.exists():
        labels = load_labels(labels_path)
    else:
        warnings.append(f"no labels file at {labels_path}: recall, false alerts, and lead time are not scored")

    walks = {p.stem: load_walk(p) for p in log_files}
    if labels is not None:
        for unknown in sorted(set(labels["walk_id"]) - set(walks)):
            warnings.append(f"labels name walk {unknown}, which has no log in {logs_dir}")
    scores = []
    for walk_id, walk in walks.items():
        walk_labels = labels[labels["walk_id"] == walk_id] if labels is not None else None
        if walk_labels is not None and walk_labels.empty:
            warnings.append(f"walk {walk_id} has no labels")
        scores.append(score_walk(walk, walk_labels, lead_s, slack_s))
    out.mkdir(parents=True, exist_ok=True)
    charts = draw_charts(scores, walks, labels, lead_s, out)
    return write_report(round_name, scores, walks, labels, charts, lead_s, slack_s, out, warnings)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Score field-test walks against the SRS targets.")
    parser.add_argument("round", help="test round folder name under field-tests/ (and results/)")
    parser.add_argument("--logs", type=Path, help="folder of .jsonl logs or replay output (default field-tests/<round>)")
    parser.add_argument("--labels", type=Path, help="labels CSV (default field-tests/<round>/labels.csv)")
    parser.add_argument("--out", type=Path, help="output folder (default results/<round>)")
    parser.add_argument("--lead-s", type=float, default=DEFAULT_LEAD_S, help="seconds an alert must precede t_reached_s")
    parser.add_argument("--slack-s", type=float, default=DEFAULT_SLACK_S, help="label timing slack when matching alerts")
    args = parser.parse_args(argv)

    base = REPO / "field-tests" / args.round
    try:
        report = evaluate(
            args.logs or base,
            args.labels or base / "labels.csv",
            args.out or REPO / "results" / args.round,
            args.round,
            args.lead_s,
            args.slack_s,
        )
    except (FileNotFoundError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"Wrote {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
