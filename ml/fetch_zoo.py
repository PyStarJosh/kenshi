"""Download class-filtered subsets of Open Images V7 and COCO 2017 with FiftyOne and export them as YOLO datasets.

Open Images gives the hazard classes (Stairs, Door, Street light as our "pole", Desk and Countertop as our "desk") and
extra tables (Table, Kitchen & dining room table, Coffee table, all labeled "dining table"); COCO gives our kept obstacle
classes.
Output goes to datasets/raw/openimages-v7 and datasets/raw/coco-kept (images/{train,val}, labels/{train,val}).

  uv run --group ml python ml/fetch_zoo.py --openimages --coco
  uv run --group ml python ml/fetch_zoo.py --openimages --coco --tiny      # a few images each, to test the pipeline

For each class, FiftyOne picks images that contain it, keeping every label of the classes we use, so an image chosen
for "Door" still carries its stairs and street-light boxes. Images are copied, so allow a few GB of free disk.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ml.yolo_utils import BASE_CLASS_MAP, REPO_ROOT, kept_ids, load_class_table

OPEN_IMAGES_CLASSES = [
    "Stairs",
    "Door",
    "Street light",
    "Desk",
    "Countertop",
    "Table",
    "Kitchen & dining room table",
    "Coffee table",
]  # order = YOLO ids 0 to 7 in the export; ml/dataset_sources.json lists the same order
# Tables are common and already a COCO class, so they only top up "dining table": a third of the images per class.
TABLE_CLASSES = {"Table", "Kitchen & dining room table", "Coffee table"}
SEED = 51


def _label_field(dataset) -> str:
    """Open Images stores boxes in 'detections'; COCO in 'ground_truth'."""
    schema = dataset.get_field_schema()
    return "detections" if "detections" in schema else "ground_truth"


def _fetch(
    zoo_name: str,
    split: str,
    classes: list[str],
    per_class: int,
    keep: list[str],
    tag: str,
):
    """One FiftyOne dataset with `per_class` images for each class, labeled with every class in `keep`."""
    import fiftyone as fo
    import fiftyone.zoo as foz
    from fiftyone import ViewField as F

    merged = fo.Dataset(f"kenshi-{tag}-{split}", overwrite=True, persistent=False)
    field = None
    for cls in classes:
        part = foz.load_zoo_dataset(
            zoo_name,
            split=split,
            label_types=["detections"],
            classes=[cls],
            max_samples=per_class // 3 if cls in TABLE_CLASSES else per_class,
            shuffle=True,
            seed=SEED,
            dataset_name=f"kenshi-{tag}-{split}-{re.sub('[^A-Za-z0-9]+', '-', cls)}",
            drop_existing_dataset=True,
        )
        field = field or _label_field(part)
        merged.merge_samples(part, merge_lists=False)
    assert field is not None
    view = merged.filter_labels(field, F("label").is_in(keep), only_matches=True)
    return view, field


def _export(view, field: str, out: Path, split_out: str, classes: list[str]) -> None:
    import fiftyone as fo

    view.export(
        export_dir=str(out),
        dataset_type=fo.types.YOLOv5Dataset,
        label_field=field,
        classes=classes,
        split=split_out,
    )
    print(f"  {split_out}: {len(view)} images -> {out}")


def fetch_open_images(out: Path, per_class_train: int, per_class_val: int) -> None:
    print(
        f"Open Images V7 ({len(OPEN_IMAGES_CLASSES)} classes: {', '.join(OPEN_IMAGES_CLASSES)})"
    )
    for zoo_split, split_out, n in (
        ("train", "train", per_class_train),
        ("validation", "val", per_class_val),
    ):
        view, field = _fetch(
            "open-images-v7",
            zoo_split,
            OPEN_IMAGES_CLASSES,
            n,
            OPEN_IMAGES_CLASSES,
            "oi",
        )
        _export(view, field, out, split_out, OPEN_IMAGES_CLASSES)


def fetch_coco(out: Path, per_class_train: int, per_class_val: int) -> None:
    table = load_class_table(BASE_CLASS_MAP)
    kept = [table[i]["label"] for i in kept_ids(table)]
    print(f"COCO 2017 ({len(kept)} kept classes)")
    for zoo_split, split_out, n in (
        ("train", "train", per_class_train),
        ("validation", "val", per_class_val),
    ):
        view, field = _fetch("coco-2017", zoo_split, kept, n, kept, "coco")
        _export(view, field, out, split_out, kept)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--openimages",
        action="store_true",
        help="download the hazard, desk and table classes from Open Images V7",
    )
    parser.add_argument(
        "--coco", action="store_true", help="download the kept classes from COCO 2017"
    )
    parser.add_argument("--raw-dir", type=Path, default=REPO_ROOT / "datasets" / "raw")
    parser.add_argument(
        "--oi-per-class",
        type=int,
        default=1500,
        help="Open Images training images per class",
    )
    parser.add_argument("--oi-val-per-class", type=int, default=250)
    parser.add_argument(
        "--coco-per-class",
        type=int,
        default=300,
        help="COCO training images per kept class (about 4,000 unique images in all)",
    )
    parser.add_argument("--coco-val-per-class", type=int, default=40)
    parser.add_argument(
        "--tiny",
        action="store_true",
        help="a handful of images per class, to test the pipeline",
    )
    args = parser.parse_args()
    if not (args.openimages or args.coco):
        parser.error("choose --openimages and/or --coco")
    if args.tiny:
        (
            args.oi_per_class,
            args.oi_val_per_class,
            args.coco_per_class,
            args.coco_val_per_class,
        ) = 3, 2, 1, 1
    if args.openimages:
        fetch_open_images(
            args.raw_dir / "openimages-v7", args.oi_per_class, args.oi_val_per_class
        )
    if args.coco:
        fetch_coco(
            args.raw_dir / "coco-kept", args.coco_per_class, args.coco_val_per_class
        )


if __name__ == "__main__":
    main()
