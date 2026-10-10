"""Merge the downloaded datasets into datasets/hazards/ with our class ids, ready for training.

Steps:
  1. For each source in ml/dataset_sources.json that exists under datasets/raw/, take a reproducible sample of images,
     rename its classes to ours (ids 0-79 are COCO, 80-83 are stairs, curb, pole, door; see ml/class_map.hazard.json),
     and copy the images and labels to datasets/hazards/.
  2. Pseudo-label: on images from hazard sources, run the base YOLO model and add its boxes for our kept obstacle
     classes (confidence 0.5), so people, chairs and cars in hazard photos are not learned as background.
  3. Write data.yaml and manifest.csv, print per-class counts, and warn about strong imbalance.
  4. Optionally zip everything for upload to Google Drive (--zip).

  uv run --group ml python ml/prepare_dataset.py --zip
  uv run --group ml python ml/prepare_dataset.py --tiny --no-pseudo      # tiny test run, no model needed
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sys
import zipfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import yaml

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ml.yolo_utils import (
    BASE_CLASS_MAP,
    HAZARD_CLASS_MAP,
    HAZARD_LABELS,
    REPO_ROOT,
    Box,
    imbalance_warnings,
    kept_ids,
    label_to_id,
    list_images,
    load_class_table,
    merge_pseudo,
    read_labels,
    remap_boxes,
    sample_stems,
    split_for,
    write_labels,
)

SOURCES_FILE = REPO_ROOT / "ml" / "dataset_sources.json"
DEFAULT_OUT = REPO_ROOT / "datasets" / "hazards"
SPLITS = ("train", "val")


@dataclass
class Source:
    name: str
    kind: str  # "kept" or "hazard"
    path: Path
    names: list[str]  # source class names by id
    mapping: dict[str, str]  # source class name -> our label
    pseudo_label: bool
    max_images: dict[str, int | None]


def load_sources(
    file: Path, our_table: list[dict], kept_labels: list[str]
) -> list[Source]:
    config = json.loads(file.read_text(encoding="utf-8"))
    sources = []
    for s in config["sources"]:
        names = kept_labels if s["names"] == "kept" else list(s["names"])
        mapping = {n: n for n in names} if s["map"] == "identity" else dict(s["map"])
        unknown = set(mapping.values()) - {r["label"] for r in our_table}
        if unknown:
            raise SystemExit(f"{s['name']}: maps to unknown classes {sorted(unknown)}")
        path = Path(s["path"])
        sources.append(
            Source(
                name=s["name"],
                kind=s["kind"],
                path=path if path.is_absolute() else REPO_ROOT / path,
                names=names,
                mapping=mapping,
                pseudo_label=bool(s["pseudo_label"]),
                max_images=dict(s.get("max_images", {})),
            )
        )
    return sources


def id_mapping(source: Source, ids: dict[str, int]) -> dict[int, int]:
    """Source class id -> our class id, for the classes this source maps."""
    return {
        i: ids[source.mapping[n]]
        for i, n in enumerate(source.names)
        if n in source.mapping
    }


def link_or_copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return
    try:
        os.link(source, target)  # no extra disk space when both are on the same drive
    except OSError:
        shutil.copy2(source, target)


def collect_split(
    source: Source, split: str, limit: int | None, val_percent: int
) -> list[tuple[Path, Path]]:
    """(image, label file) pairs for one split of a source.

    A source with its own val folder is used as is. One without it gets a stable hash split of its train images.
    """
    images_dir = source.path / "images"
    labels_dir = source.path / "labels"
    if (images_dir / "val").exists():
        pairs = [
            (p, labels_dir / split / f"{p.stem}.txt")
            for p in list_images(images_dir / split)
        ]
    else:
        pairs = [
            (p, labels_dir / "train" / f"{p.stem}.txt")
            for p in list_images(images_dir / "train")
            if split_for(p.stem, val_percent) == split
        ]
    return sample_stems(pairs, limit)


def import_source(
    source: Source,
    out: Path,
    ids: dict[str, int],
    limit_override: int | None,
    val_percent: int,
    rows: list[dict],
) -> int:
    if not source.path.exists():
        print(f"  {source.name}: not found at {source.path}, skipping")
        return 0
    mapping = id_mapping(source, ids)
    total = 0
    for split in SPLITS:
        limit = (
            limit_override
            if limit_override is not None
            else source.max_images.get(split)
        )
        pairs = collect_split(source, split, limit, val_percent)
        kept = 0
        for image, label_file in pairs:
            boxes = remap_boxes(read_labels(label_file), mapping)
            if not boxes:
                continue  # nothing of ours in this image
            name = f"{source.name}__{image.stem}"
            link_or_copy(
                image, out / "images" / split / f"{name}{image.suffix.lower()}"
            )
            write_labels(out / "labels" / split / f"{name}.txt", boxes)
            rows.append(
                {
                    "image": f"images/{split}/{name}{image.suffix.lower()}",
                    "source": source.name,
                    "kind": source.kind,
                    "split": split,
                    "boxes": len(boxes),
                    "pseudo_boxes": 0,
                    "pseudo_label": int(source.pseudo_label),
                }
            )
            kept += 1
        print(f"  {source.name} {split}: {kept} images (of {len(pairs)} sampled)")
        total += kept
    return total


def pseudo_label(
    out: Path,
    rows: list[dict],
    weights: str,
    kept: set[int],
    conf: float,
    batch: int = 16,
) -> int:
    """Add the base model's boxes for our kept classes to images from sources flagged pseudo_label."""
    from ultralytics import YOLO

    targets = [r for r in rows if r["pseudo_label"]]
    if not targets:
        return 0
    print(f"pseudo-labeling {len(targets)} images with {weights} at confidence {conf}")
    model = YOLO(weights)
    added = 0
    for start in range(0, len(targets), batch):
        chunk = targets[start : start + batch]
        results = model.predict(
            [str(out / r["image"]) for r in chunk], conf=conf, verbose=False
        )
        for row, result in zip(chunk, results):
            predicted = [
                Box(int(c), float(x), float(y), float(w), float(h))
                for c, (x, y, w, h) in zip(
                    result.boxes.cls.tolist(), result.boxes.xywhn.tolist()
                )
                if int(c) in kept
            ]
            label_file = (
                out / "labels" / row["split"] / f"{Path(row['image']).stem}.txt"
            )
            existing = read_labels(label_file)
            merged = merge_pseudo(existing, predicted)
            if len(merged) > len(existing):
                write_labels(label_file, merged)
                row["pseudo_boxes"] = len(merged) - len(existing)
                row["boxes"] += row["pseudo_boxes"]
                added += row["pseudo_boxes"]
    return added


def write_outputs(out: Path, rows: list[dict], names: list[str]) -> None:
    data = {
        "path": str(out.resolve()),
        "train": "images/train",
        "val": "images/val",
        "names": {i: n for i, n in enumerate(names)},
    }
    (out / "data.yaml").write_text(
        yaml.safe_dump(data, sort_keys=False), encoding="utf-8"
    )
    fields = [
        "image",
        "source",
        "kind",
        "split",
        "boxes",
        "pseudo_boxes",
        "pseudo_label",
    ]
    with open(out / "manifest.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def count_classes(out: Path, rows: list[dict]) -> dict[str, tuple[Counter, Counter]]:
    """Per split: instances per class id and images per class id."""
    counts = {s: (Counter(), Counter()) for s in SPLITS}
    for row in rows:
        instances, images = counts[row["split"]]
        seen = set()
        for box in read_labels(
            out / "labels" / row["split"] / f"{Path(row['image']).stem}.txt"
        ):
            instances[box.cls] += 1
            seen.add(box.cls)
        for cls in seen:
            images[cls] += 1
    return counts


def report(
    counts: dict[str, tuple[Counter, Counter]], names: list[str], rows: list[dict]
) -> list[str]:
    print("\nimages per source and split")
    per_source = Counter((r["source"], r["split"]) for r in rows)
    for (source, split), n in sorted(per_source.items()):
        print(f"  {source:18s} {split:5s} {n:6d}")
    train_inst, train_img = counts["train"]
    val_inst, val_img = counts["val"]
    used = sorted(set(train_inst) | set(val_inst))
    print("\nper class (instances / images)")
    print(
        f"  {'id':>3} {'class':16s} {'train inst':>10} {'train img':>9} {'val inst':>8} {'val img':>7}"
    )
    for i in used:
        print(
            f"  {i:>3} {names[i]:16s} {train_inst[i]:>10} {train_img[i]:>9} {val_inst[i]:>8} {val_img[i]:>7}"
        )
    focus = [names[i] for i in used]
    warnings = imbalance_warnings(train_inst, val_inst, names, focus=focus)
    for hazard in HAZARD_LABELS:
        if hazard not in focus:
            warnings.append(
                f"'{hazard}' has no instances at all: its source has not been downloaded or converted yet (see ml/datasets.md)"
            )
    if warnings:
        print("\nWARNINGS")
        for w in warnings:
            print("  -", w)
    return warnings


def make_zip(out: Path, target: Path) -> None:
    print(
        f"\nzipping to {target} (images are already compressed, so they are stored as is)"
    )
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as z:
        for path in sorted(out.rglob("*")):
            if path.is_file():
                z.write(path, Path("hazards") / path.relative_to(out))
    print(f"  {target.stat().st_size / 1e9:.2f} GB")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--sources", type=Path, default=SOURCES_FILE)
    parser.add_argument(
        "--max-images",
        type=int,
        default=None,
        help="cap on images per source and split (overrides the registry)",
    )
    parser.add_argument(
        "--tiny",
        action="store_true",
        help="8 images per source and split, for a quick test run",
    )
    parser.add_argument(
        "--base-weights",
        default="yolo26n.pt",
        help="the base model used for pseudo-labels",
    )
    parser.add_argument("--pseudo-conf", type=float, default=0.5)
    parser.add_argument("--no-pseudo", action="store_true")
    parser.add_argument(
        "--val-percent",
        type=int,
        default=10,
        help="share of images held out when a source has no val split",
    )
    parser.add_argument(
        "--zip",
        action="store_true",
        help="also write <out>.zip for upload to Google Drive",
    )
    args = parser.parse_args()

    base = load_class_table(BASE_CLASS_MAP)
    ours = load_class_table(HAZARD_CLASS_MAP)
    names = [r["label"] for r in ours]
    ids = label_to_id(ours)
    kept = kept_ids(base)
    kept_labels = [base[i]["label"] for i in kept]
    sources = load_sources(args.sources, ours, kept_labels)
    limit = 8 if args.tiny else args.max_images

    if args.out.exists():
        print(f"replacing {args.out}")
        shutil.rmtree(args.out)
    rows: list[dict] = []
    print("importing sources")
    total = sum(
        import_source(s, args.out, ids, limit, args.val_percent, rows) for s in sources
    )
    if total == 0:
        raise SystemExit(
            "No images were imported. Download datasets into datasets/raw/ first (see ml/datasets.md)."
        )
    if not args.no_pseudo:
        added = pseudo_label(
            args.out, rows, args.base_weights, set(kept), args.pseudo_conf
        )
        print(f"  added {added} pseudo-labeled boxes")
    write_outputs(args.out, rows, names)
    report(count_classes(args.out, rows), names, rows)
    print(f"\nwrote {args.out / 'data.yaml'} and {args.out / 'manifest.csv'}")
    if args.zip:
        make_zip(args.out, args.out.with_suffix(".zip"))


if __name__ == "__main__":
    main()
