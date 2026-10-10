"""Shared helpers for the hazard-model scripts: class tables, YOLO label files, boxes, and splits.

Pure functions where possible so they can be unit-tested (uv run --group ml python -m unittest discover -s ml/tests -t .).
Boxes are normalized YOLO boxes: class id, then center x, center y, width, height, all 0..1.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BASE_CLASS_MAP = REPO_ROOT / "ml" / "class_map.json"
HAZARD_CLASS_MAP = REPO_ROOT / "ml" / "class_map.hazard.json"

# The four classes the retrained model adds, after the 80 COCO classes (ids 80 to 83).
HAZARD_LABELS = ("stairs", "curb", "pole", "door")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


@dataclass(frozen=True)
class Box:
    cls: int
    cx: float
    cy: float
    w: float
    h: float

    def to_line(self) -> str:
        return f"{self.cls} {self.cx:.6f} {self.cy:.6f} {self.w:.6f} {self.h:.6f}"


def load_class_table(path: Path) -> list[dict]:
    """The class table: one dict per class id, in id order (ids must be 0..N-1)."""
    rows = json.loads(Path(path).read_text(encoding="utf-8"))
    if [r["id"] for r in rows] != list(range(len(rows))):
        raise ValueError(f"{path}: class ids must be 0..N-1 in order")
    return rows


def kept_ids(base_table: list[dict]) -> list[int]:
    """Ids of the COCO classes the app announces (alertable in the base class map)."""
    return [r["id"] for r in base_table if r["alertable"]]


def label_to_id(table: list[dict]) -> dict[str, int]:
    return {r["label"]: r["id"] for r in table}


def read_labels(path: Path) -> list[Box]:
    """Read a YOLO label file. A missing file means no objects."""
    path = Path(path)
    if not path.exists():
        return []
    boxes = []
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        if len(parts) > 5:
            raise ValueError(
                f"{path}: expected 5 values per line, found {len(parts)} "
                "(segmentation labels are not supported)"
            )
        cls, cx, cy, w, h = int(float(parts[0])), *(float(p) for p in parts[1:5])
        boxes.append(Box(cls, cx, cy, w, h))
    return boxes


def write_labels(path: Path, boxes: list[Box]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(b.to_line() + "\n" for b in boxes), encoding="utf-8", newline="\n"
    )


def iou(a: Box, b: Box) -> float:
    ax1, ay1, ax2, ay2 = a.cx - a.w / 2, a.cy - a.h / 2, a.cx + a.w / 2, a.cy + a.h / 2
    bx1, by1, bx2, by2 = b.cx - b.w / 2, b.cy - b.h / 2, b.cx + b.w / 2, b.cy + b.h / 2
    inter = max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(
        0.0, min(ay2, by2) - max(ay1, by1)
    )
    union = a.w * a.h + b.w * b.h - inter
    return inter / union if union > 0 else 0.0


def merge_pseudo(
    existing: list[Box], predicted: list[Box], iou_threshold: float = 0.5
) -> list[Box]:
    """Add predicted boxes to existing labels, skipping any that duplicate an existing box of the same class."""
    merged = list(existing)
    for p in predicted:
        if not any(e.cls == p.cls and iou(e, p) > iou_threshold for e in existing):
            merged.append(p)
    return merged


def remap_boxes(boxes: list[Box], mapping: dict[int, int]) -> list[Box]:
    """Rename class ids with a mapping; boxes whose class is not in the mapping are dropped."""
    return [
        Box(mapping[b.cls], b.cx, b.cy, b.w, b.h) for b in boxes if b.cls in mapping
    ]


def xyxy_to_box(
    cls: int, x1: float, y1: float, x2: float, y2: float, width: int, height: int
) -> Box | None:
    """Pixel corners to a normalized box, clamped to the image. None if nothing is left."""
    x1, x2 = max(0.0, min(x1, x2)), min(float(width), max(x1, x2))
    y1, y2 = max(0.0, min(y1, y2)), min(float(height), max(y1, y2))
    if x2 - x1 <= 1 or y2 - y1 <= 1 or width <= 0 or height <= 0:
        return None
    return Box(
        cls,
        (x1 + x2) / 2 / width,
        (y1 + y2) / 2 / height,
        (x2 - x1) / width,
        (y2 - y1) / height,
    )


def split_for(name: str, val_percent: int = 10) -> str:
    """Stable train or val choice for an image name: the same name always lands in the same split."""
    bucket = int(hashlib.md5(name.encode("utf-8")).hexdigest(), 16) % 100
    return "val" if bucket < val_percent else "train"


def list_images(directory: Path) -> list[Path]:
    directory = Path(directory)
    if not directory.exists():
        return []
    return sorted(p for p in directory.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)


def sample_stems(items: list, limit: int | None, seed: int = 0) -> list:
    """A reproducible random subset of at most `limit` items (all of them if limit is None)."""
    if limit is None or len(items) <= limit:
        return list(items)
    keyed = sorted(items, key=lambda x: hashlib.md5(f"{seed}:{x}".encode()).hexdigest())
    return sorted(keyed[:limit], key=str)


def imbalance_warnings(
    train_counts: Counter,
    val_counts: Counter,
    names: list[str],
    ratio_limit: float = 10.0,
    min_train: int = 300,
    min_val: int = 50,
    focus: list[str] | None = None,
) -> list[str]:
    """Plain-language warnings about class counts. `focus` limits the checks to those class names."""
    checked = [i for i, n in enumerate(names) if focus is None or n in focus]
    warnings = []
    for i in checked:
        if train_counts[i] == 0:
            warnings.append(f"'{names[i]}' has no training instances")
        elif train_counts[i] < min_train:
            warnings.append(
                f"'{names[i]}' has only {train_counts[i]} training instances (aim for {min_train}+)"
            )
        if val_counts[i] < min_val:
            warnings.append(
                f"'{names[i]}' has only {val_counts[i]} validation instances (aim for {min_val}+); its metrics will be noisy"
            )
    present = [(names[i], train_counts[i]) for i in checked if train_counts[i] > 0]
    if len(present) >= 2:
        biggest = max(present, key=lambda p: p[1])
        smallest = min(present, key=lambda p: p[1])
        if biggest[1] / smallest[1] > ratio_limit:
            warnings.append(
                f"strong imbalance: '{biggest[0]}' has {biggest[1] / smallest[1]:.0f}x more training instances "
                f"than '{smallest[0]}' ({biggest[1]} vs {smallest[1]})"
            )
    return warnings
