"""Compare the base YOLO model with the retrained hazard model.

(a) Validation set: per-class precision and recall for both models, with a flag on any kept obstacle class whose recall
    drops by more than 3 points. Kept classes are scored only on images from sources labeled by hand (COCO, Argoverse),
    because the other images carry pseudo-labels made by the base model itself, which would favor the base model.
    The new classes (stairs, curb, pole, door, desk) are scored on the hazard-source images.
(b) Our own clips in field-tests/clips/: detection counts per class and sample frames with boxes for each model.

  uv run --group ml python ml/compare_models.py --hazard path/to/yolo26n-hazards-416.onnx
  uv run --group ml python ml/compare_models.py                      # base model only

Both models are run the way the app runs them: letterboxed to the model's fixed input size, raw output
[1, 4 + classes, N], per-image thresholding at --conf, and class-aware NMS.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ml.yolo_utils import (
    BASE_CLASS_MAP,
    HAZARD_CLASS_MAP,
    HAZARD_LABELS,
    REPO_ROOT,
    Box,
    iou,
    kept_ids,
    label_to_id,
    load_class_table,
    read_labels,
)

PAD_GRAY = 114
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".avi"}
RECALL_DROP_LIMIT = 0.03
LOW_SUPPORT = 20  # fewer ground-truth boxes than this and the numbers are not reliable


@dataclass(frozen=True)
class Det:
    cls: int
    conf: float
    box: Box


class OnnxDetector:
    """A YOLO ONNX model with raw output [1, 4 + classes, N], run on the CPU."""

    def __init__(self, path: Path):
        import onnxruntime as ort

        self.path = Path(path)
        self.session = ort.InferenceSession(
            str(path), providers=["CPUExecutionProvider"]
        )
        model_input = self.session.get_inputs()[0]
        self.input_name = model_input.name
        self.size = int(model_input.shape[2])
        shape = self.session.get_outputs()[0].shape
        raw = len(shape) == 3 and all(isinstance(d, int) for d in shape[1:])
        if not raw or shape[1] >= shape[2]:
            raise ValueError(
                f"{self.path.name}: expected raw output [1, 4 + classes, N], found {shape} "
                "(an end-to-end export?)"
            )
        self.num_classes = shape[1] - 4

    def detect(self, bgr: np.ndarray, conf: float, nms_iou: float = 0.45) -> list[Det]:
        height, width = bgr.shape[:2]
        scale = min(self.size / width, self.size / height)
        draw_w, draw_h = max(1, round(width * scale)), max(1, round(height * scale))
        pad_x, pad_y = (self.size - draw_w) // 2, (self.size - draw_h) // 2
        canvas = np.full((self.size, self.size, 3), PAD_GRAY, dtype=np.uint8)
        canvas[pad_y : pad_y + draw_h, pad_x : pad_x + draw_w] = cv2.resize(
            bgr, (draw_w, draw_h), interpolation=cv2.INTER_LINEAR
        )
        tensor = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        output = self.session.run(None, {self.input_name: tensor})[0][0]
        return decode(output, (pad_x, pad_y, draw_w, draw_h), conf, nms_iou)


def decode(
    output: np.ndarray,
    letterbox: tuple[int, int, int, int],
    conf: float,
    nms_iou: float,
) -> list[Det]:
    """Raw [4 + classes, N] model output to detections in normalized source-frame coordinates."""
    pad_x, pad_y, draw_w, draw_h = letterbox
    scores = output[4:]
    best = scores.argmax(axis=0)
    best_score = scores.max(axis=0)
    keep = np.where(best_score >= conf)[0]
    detections = []
    for i in keep:
        cx, cy, w, h = (float(v) for v in output[:4, i])
        x1 = max(0.0, (cx - w / 2 - pad_x) / draw_w)
        y1 = max(0.0, (cy - h / 2 - pad_y) / draw_h)
        x2 = min(1.0, (cx + w / 2 - pad_x) / draw_w)
        y2 = min(1.0, (cy + h / 2 - pad_y) / draw_h)
        if x2 <= x1 or y2 <= y1:
            continue
        detections.append(
            Det(
                int(best[i]),
                float(best_score[i]),
                Box(int(best[i]), (x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1),
            )
        )
    return nms(detections, nms_iou)


def nms(detections: list[Det], iou_threshold: float) -> list[Det]:
    kept: list[Det] = []
    for d in sorted(detections, key=lambda d: -d.conf):
        if not any(k.cls == d.cls and iou(k.box, d.box) > iou_threshold for k in kept):
            kept.append(d)
    return kept


def match_counts(
    truth: list[Box],
    predictions: list[Det],
    classes: set[int],
    iou_threshold: float = 0.5,
) -> dict[int, list[int]]:
    """Per class [true positives, false positives, false negatives] for one image, over the given classes.

    Predictions are matched to ground-truth boxes of the same class in order of confidence, each box at most once.
    """
    counts = {c: [0, 0, 0] for c in classes}
    for cls in classes:
        gts = [b for b in truth if b.cls == cls]
        preds = sorted((d for d in predictions if d.cls == cls), key=lambda d: -d.conf)
        used = [False] * len(gts)
        for p in preds:
            best, best_iou = -1, iou_threshold
            for i, g in enumerate(gts):
                if not used[i] and iou(g, p.box) >= best_iou:
                    best, best_iou = i, iou(g, p.box)
            if best >= 0:
                used[best] = True
                counts[cls][0] += 1
            else:
                counts[cls][1] += 1
        counts[cls][2] += used.count(False)
    return counts


EDGE_MARGIN = 0.01  # a box within this fraction of the image border counts as cut off by the frame


def touches_edge(box: Box, margin: float = EDGE_MARGIN) -> bool:
    """True if the box reaches the image border on any side, i.e. the object is probably cut off by the frame."""
    return (
        box.cx - box.w / 2 <= margin
        or box.cx + box.w / 2 >= 1 - margin
        or box.cy - box.h / 2 <= margin
        or box.cy + box.h / 2 >= 1 - margin
    )


def edge_counts(
    truth: list[Box], predictions: list[Det], classes: set[int]
) -> dict[int, list[int]]:
    """Per class [found, missed] for the ground-truth boxes that touch the image border."""
    cut = [b for b in truth if touches_edge(b)]
    return {
        cls: [tp, fn]
        for cls, (tp, _, fn) in match_counts(cut, predictions, classes).items()
    }


def precision_recall(tp: int, fp: int, fn: int) -> tuple[float | None, float | None]:
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    return precision, recall


def recall_flags(
    base: dict[int, dict], hazard: dict[int, dict], kept: list[int], names: list[str]
) -> list[str]:
    """Kept classes whose recall fell by more than 3 points."""
    flags = []
    for c in kept:
        b, h = base.get(c), hazard.get(c)
        if not b or not h or b["recall"] is None or h["recall"] is None:
            continue
        drop = b["recall"] - h["recall"]
        if (
            drop - RECALL_DROP_LIMIT > 1e-9
        ):  # "more than 3 points", without floating-point noise at exactly 3
            note = (
                " (few examples, treat with care)" if b["support"] < LOW_SUPPORT else ""
            )
            flags.append(
                f"{names[c]}: recall {b['recall']:.1%} -> {h['recall']:.1%} (lost {drop * 100:.1f} points){note}"
            )
    return flags


def evaluate_validation(
    detectors: dict[str, OnnxDetector],
    data_dir: Path,
    conf: float,
    kept: set[int],
    hazard: set[int],
    limit: int | None,
):
    """Per model and class: tp, fp, fn, precision, recall, support."""
    with open(data_dir / "manifest.csv", newline="", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if r["split"] == "val"]
    if limit:
        rows = rows[:limit]
    totals: dict[str, dict[int, list[int]]] = {
        name: defaultdict(lambda: [0, 0, 0]) for name in detectors
    }
    edge_totals: dict[str, dict[int, list[int]]] = {
        name: defaultdict(lambda: [0, 0]) for name in detectors
    }
    evaluated = 0
    for row in rows:
        classes = kept if row["kind"] == "kept" else hazard
        image = cv2.imread(str(data_dir / row["image"]))
        if image is None:
            continue
        truth = read_labels(
            data_dir / "labels" / "val" / f"{Path(row['image']).stem}.txt"
        )
        for name, detector in detectors.items():
            predictions = detector.detect(image, conf)
            for cls, (tp, fp, fn) in match_counts(truth, predictions, classes).items():
                t = totals[name][cls]
                t[0] += tp
                t[1] += fp
                t[2] += fn
            for cls, (found, missed) in edge_counts(
                truth, predictions, classes
            ).items():
                e = edge_totals[name][cls]
                e[0] += found
                e[1] += missed
        evaluated += 1
    result: dict[str, dict[int, dict]] = {}
    for name, per_class in totals.items():
        result[name] = {}
        for cls, (tp, fp, fn) in per_class.items():
            precision, recall = precision_recall(tp, fp, fn)
            found, missed = edge_totals[name].get(cls, [0, 0])
            result[name][cls] = {
                "edge_recall": found / (found + missed) if found + missed else None,
                "edge_support": found + missed,
                "tp": tp,
                "fp": fp,
                "fn": fn,
                "precision": precision,
                "recall": recall,
                "support": tp + fn,
            }
    return result, evaluated


def draw(
    image: np.ndarray, detections: list[Det], names: list[str], title: str
) -> np.ndarray:
    out = image.copy()
    height, width = out.shape[:2]
    for d in detections:
        b = d.box
        x1, y1 = int((b.cx - b.w / 2) * width), int((b.cy - b.h / 2) * height)
        x2, y2 = int((b.cx + b.w / 2) * width), int((b.cy + b.h / 2) * height)
        cv2.rectangle(out, (x1, y1), (x2, y2), (0, 235, 255), max(2, width // 400))
        label = f"{names[d.cls] if d.cls < len(names) else d.cls} {d.conf:.2f}"
        cv2.putText(
            out,
            label,
            (x1 + 3, max(14, y1 + 16)),
            cv2.FONT_HERSHEY_SIMPLEX,
            max(0.5, width / 1600),
            (0, 0, 0),
            3,
        )
        cv2.putText(
            out,
            label,
            (x1 + 3, max(14, y1 + 16)),
            cv2.FONT_HERSHEY_SIMPLEX,
            max(0.5, width / 1600),
            (0, 235, 255),
            1,
        )
    cv2.putText(
        out,
        title,
        (10, height - 12),
        cv2.FONT_HERSHEY_SIMPLEX,
        max(0.7, width / 1200),
        (255, 255, 255),
        2,
    )
    return out


def run_clips(
    detectors: dict[str, OnnxDetector],
    clips_dir: Path,
    out_dir: Path,
    names: list[str],
    conf: float,
    clip_fps: float,
    max_frames: int,
    samples: int,
):
    """Detection counts per clip, model, and class, plus sample frames with boxes."""
    clips = (
        sorted(p for p in clips_dir.glob("*") if p.suffix.lower() in VIDEO_SUFFIXES)
        if clips_dir.exists()
        else []
    )
    results = {}
    for clip in clips:
        cap = cv2.VideoCapture(str(clip))
        if not cap.isOpened():
            print(
                f"  {clip.name}: could not open (iPhone HEVC .mov? record as Most Compatible or convert to H.264 mp4)"
            )
            continue
        step = max(1, round((cap.get(cv2.CAP_PROP_FPS) or 30) / clip_fps))
        frames, index = [], 0
        while len(frames) < max_frames:
            ok, frame = cap.read()
            if not ok:
                break
            if index % step == 0:
                frames.append(frame)
            index += 1
        cap.release()
        if not frames:
            print(f"  {clip.name}: no frames could be read")
            continue
        counts = {name: Counter() for name in detectors}
        per_frame = []
        for frame in frames:
            per_frame.append(
                {name: d.detect(frame, conf) for name, d in detectors.items()}
            )
            for name, detections in per_frame[-1].items():
                counts[name].update(
                    names[d.cls] if d.cls < len(names) else str(d.cls)
                    for d in detections
                )
        picks = sorted(
            {int(i) for i in np.linspace(0, len(frames) - 1, min(samples, len(frames)))}
        )
        frame_dir = out_dir / "frames" / clip.stem
        frame_dir.mkdir(parents=True, exist_ok=True)
        for n, i in enumerate(picks):
            panels = [
                draw(
                    cv2.resize(
                        frames[i],
                        (640, round(640 * frames[i].shape[0] / frames[i].shape[1])),
                    ),
                    per_frame[i][name],
                    names,
                    name,
                )
                for name in detectors
            ]
            cv2.imwrite(str(frame_dir / f"sample_{n:02d}.jpg"), np.hstack(panels))
        results[clip.name] = {
            "frames": len(frames),
            "counts": {name: dict(c) for name, c in counts.items()},
        }
    return results


def fmt(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.1%}"


def write_report(
    out_dir: Path,
    names: list[str],
    kept: list[int],
    hazard: list[int],
    validation,
    evaluated: int,
    flags: list[str],
    clips: dict,
    models: list[str],
) -> None:
    lines = ["# Model comparison", "", f"Models: {', '.join(models)}", ""]
    if validation:
        lines += [f"## Validation set ({evaluated} images)", ""]
        header = (
            "| class | support | "
            + " | ".join(f"{m} precision | {m} recall" for m in models)
            + (" | recall change |" if len(models) == 2 else " |")
        )
        lines += [header, "|" + "---|" * (header.count("|") - 1)]
        for cls in kept + hazard:
            support = max(
                (validation[m].get(cls, {}).get("support", 0) for m in models),
                default=0,
            )
            cells = []
            for m in models:
                r = validation[m].get(cls)
                cells += [
                    fmt(r["precision"]) if r else "n/a",
                    fmt(r["recall"]) if r else "n/a",
                ]
            change = ""
            if len(models) == 2:
                a, b = validation[models[0]].get(cls), validation[models[1]].get(cls)
                if a and b and a["recall"] is not None and b["recall"] is not None:
                    change = f"{(b['recall'] - a['recall']) * 100:+.1f} pts"
            lines.append(
                f"| {names[cls]} | {support} | "
                + " | ".join(cells)
                + (f" | {change} |" if len(models) == 2 else " |")
            )
        lines += [
            "",
            "### Recall on objects cut off by the frame edge",
            "",
            "Ground-truth boxes that touch the image border. Few examples means the number is noisy.",
            "",
            "| class | edge examples | "
            + " | ".join(f"{m} recall" for m in models)
            + " |",
            "|" + "---|" * (len(models) + 2),
        ]
        for cls in kept + hazard:
            edge_support = max(
                (validation[m].get(cls, {}).get("edge_support", 0) for m in models),
                default=0,
            )
            if not edge_support:
                continue
            cells = [
                fmt(validation[m][cls]["edge_recall"])
                if cls in validation[m]
                else "n/a"
                for m in models
            ]
            lines.append(
                f"| {names[cls]} | {edge_support} | " + " | ".join(cells) + " |"
            )
        lines += [
            "",
            "### Recall flags (kept classes that lost more than 3 points)",
            "",
        ]
        lines += [f"- {f}" for f in flags] if flags else ["- none"]
        lines.append("")
    if clips:
        lines += ["## Clips", ""]
        for clip, info in clips.items():
            lines.append(f"### {clip} ({info['frames']} frames sampled)")
            all_classes = sorted(
                {c for counts in info["counts"].values() for c in counts}
            )
            lines += [
                "",
                "| class | " + " | ".join(models) + " |",
                "|" + "---|" * (len(models) + 1),
            ]
            for c in all_classes:
                lines.append(
                    f"| {c} | "
                    + " | ".join(str(info["counts"][m].get(c, 0)) for m in models)
                    + " |"
                )
            lines += [
                "",
                f"Sample frames: `frames/{Path(clip).stem}/` (left to right: {', '.join(models)})",
                "",
            ]
    (out_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out_dir / "metrics.json").write_text(
        json.dumps(
            {
                "validation": {
                    m: {names[c]: v for c, v in per.items()}
                    for m, per in validation.items()
                }
                if validation
                else None,
                "flags": flags,
                "clips": clips,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--base",
        type=Path,
        default=REPO_ROOT / "web" / "public" / "models" / "yolo26n-416.onnx",
    )
    parser.add_argument(
        "--hazard",
        type=Path,
        default=None,
        help="the retrained ONNX model; omit to run the base model alone",
    )
    parser.add_argument("--data", type=Path, default=REPO_ROOT / "datasets" / "hazards")
    parser.add_argument(
        "--clips", type=Path, default=REPO_ROOT / "field-tests" / "clips"
    )
    parser.add_argument(
        "--out", type=Path, default=REPO_ROOT / "results" / "m2-compare"
    )
    parser.add_argument(
        "--conf",
        type=float,
        default=0.45,
        help="confidence threshold (the app's default is 0.45)",
    )
    parser.add_argument("--max-val-images", type=int, default=None)
    parser.add_argument(
        "--clip-fps",
        type=float,
        default=2.0,
        help="frames per second sampled from each clip",
    )
    parser.add_argument("--max-frames", type=int, default=120, help="frames per clip")
    parser.add_argument(
        "--samples", type=int, default=6, help="sample frames saved per clip"
    )
    parser.add_argument("--no-val", action="store_true")
    parser.add_argument("--no-clips", action="store_true")
    args = parser.parse_args()

    base_table = load_class_table(BASE_CLASS_MAP)
    table = load_class_table(HAZARD_CLASS_MAP)
    names = [r["label"] for r in table]
    kept = kept_ids(base_table)
    hazard = [label_to_id(table)[h] for h in HAZARD_LABELS]

    detectors = {"base": OnnxDetector(args.base)}
    if args.hazard:
        detectors["hazard"] = OnnxDetector(args.hazard)
    for name, d in detectors.items():
        print(f"{name}: {d.path.name}, input {d.size}, {d.num_classes} classes")
    if "hazard" in detectors and detectors["hazard"].num_classes != len(table):
        raise SystemExit(
            f"The retrained model has {detectors['hazard'].num_classes} classes but ml/class_map.hazard.json has {len(table)}."
        )
    args.out.mkdir(parents=True, exist_ok=True)
    models = list(detectors)

    validation, evaluated, flags = None, 0, []
    if not args.no_val and (args.data / "manifest.csv").exists():
        print("validation set ...")
        validation, evaluated = evaluate_validation(
            detectors, args.data, args.conf, set(kept), set(hazard), args.max_val_images
        )
        if "hazard" in models:
            flags = recall_flags(validation["base"], validation["hazard"], kept, names)
    elif not args.no_val:
        print(
            f"no validation set at {args.data} (run ml/prepare_dataset.py first); skipping part (a)"
        )

    clips = {}
    if not args.no_clips:
        print("clips ...")
        clips = run_clips(
            detectors,
            args.clips,
            args.out,
            names,
            args.conf,
            args.clip_fps,
            args.max_frames,
            args.samples,
        )
        if not clips:
            print(f"  no readable clips in {args.clips}; skipping part (b)")

    write_report(
        args.out, names, kept, hazard, validation, evaluated, flags, clips, models
    )
    print(f"wrote {args.out / 'report.md'}")
    if flags:
        print("RECALL FLAGS:")
        for f in flags:
            print("  -", f)


if __name__ == "__main__":
    main()
