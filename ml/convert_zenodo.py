"""Convert the Zenodo "Image Dataset of Accessibility Barriers" (CVAT XML) to YOLO labels.

Dataset: https://zenodo.org/records/6382090 (CC BY 4.0). Labels (singular in the files): step, stair, ramp, grab_bar.
Steps carry a "type" attribute (doorstep, curb, other); we keep stairs, and steps whose type is curb as "curb".
The plural spellings are accepted too.

  1. Download wm_barriers_data.zip (8 GB) from the Zenodo page and unzip it, for example to datasets/raw/zenodo-src/.
  2. Look at how this copy is labeled:   uv run --group ml python ml/convert_zenodo.py --src datasets/raw/zenodo-src --inspect
  3. Convert:                           uv run --group ml python ml/convert_zenodo.py --src datasets/raw/zenodo-src
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ml.yolo_utils import (
    IMAGE_SUFFIXES,
    REPO_ROOT,
    Box,
    split_for,
    write_labels,
    xyxy_to_box,
)

OUT_NAMES = [
    "stairs",
    "curb",
]  # YOLO class ids 0 and 1 in the converted copy (see ml/dataset_sources.json)


def box_label(
    label: str, attributes: dict[str, str], curb_types: set[str]
) -> str | None:
    """Our label for one CVAT box, or None to drop it."""
    label = label.strip().lower()
    if label in ("stair", "stairs"):
        return "stairs"
    if (
        label in ("step", "steps")
        and attributes.get("type", "").strip().lower() in curb_types
    ):
        return "curb"
    return None


def image_boxes(image: ET.Element, curb_types: set[str]) -> tuple[str, list[Box]]:
    """The image file name and its converted boxes, from one <image> element of a CVAT XML file."""
    name = image.get("name", "")
    width = int(float(image.get("width", "0")))
    height = int(float(image.get("height", "0")))
    boxes: list[Box] = []
    for element in image.findall("box"):
        attributes = {
            a.get("name", "").strip().lower(): (a.text or "")
            for a in element.findall("attribute")
        }
        label = box_label(element.get("label", ""), attributes, curb_types)
        if label is None:
            continue
        box = xyxy_to_box(
            OUT_NAMES.index(label),
            float(element.get("xtl", "0")),
            float(element.get("ytl", "0")),
            float(element.get("xbr", "0")),
            float(element.get("ybr", "0")),
            width,
            height,
        )
        if box is not None:
            boxes.append(box)
    return name, boxes


def inspect(xml_files: list[Path]) -> None:
    """Print how the dataset is labeled, so the conversion can be checked against it."""
    labels: Counter = Counter()
    attributes: dict[str, Counter] = {}
    images = 0
    for xml in xml_files:
        for _, element in ET.iterparse(xml, events=("end",)):
            if element.tag == "image":
                images += 1
                for box in element.findall("box"):
                    label = box.get("label", "?")
                    labels[label] += 1
                    for attribute in box.findall("attribute"):
                        key = f"{label}.{attribute.get('name', '?')}"
                        attributes.setdefault(key, Counter())[
                            (attribute.text or "").strip()
                        ] += 1
                element.clear()
    print(f"{len(xml_files)} XML file(s), {images} images")
    print("labels:", dict(labels))
    for key in sorted(attributes):
        print(f"  {key}: {dict(attributes[key])}")


def link_or_copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def convert(
    src: Path, out: Path, curb_types: set[str], val_percent: int, keep_empty: bool
) -> Counter:
    xml_files = sorted(src.rglob("*.xml"))
    if not xml_files:
        raise SystemExit(f"No .xml annotation files found under {src}")
    by_name: dict[str, list[Path]] = defaultdict(list)
    for p in src.rglob("*"):
        if p.suffix.lower() in IMAGE_SUFFIXES:
            by_name[p.name].append(p)
    counts: Counter = Counter()
    for xml in xml_files:
        for _, element in ET.iterparse(xml, events=("end",)):
            if element.tag != "image":
                continue
            name, boxes = image_boxes(element, curb_types)
            element.clear()
            # The XML name may carry folders; use them to tell apart files that share a name.
            wanted = Path(name).as_posix()
            matches = [
                p
                for p in by_name.get(Path(name).name, [])
                if p.as_posix().endswith(wanted)
            ]
            if not matches:
                counts["images missing from disk"] += 1
                continue
            if len(matches) > 1:
                counts["images skipped (file name not unique)"] += 1
                continue
            source = matches[0]
            if not boxes and not keep_empty:
                counts["images without stairs or curbs (skipped)"] += 1
                continue
            split = split_for(source.stem, val_percent)
            link_or_copy(source, out / "images" / split / source.name)
            write_labels(out / "labels" / split / f"{source.stem}.txt", boxes)
            counts[f"images {split}"] += 1
            for box in boxes:
                counts[f"{OUT_NAMES[box.cls]} {split}"] += 1
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--src", type=Path, required=True, help="the unzipped Zenodo dataset"
    )
    parser.add_argument(
        "--out", type=Path, default=REPO_ROOT / "datasets" / "raw" / "zenodo-barriers"
    )
    parser.add_argument(
        "--inspect", action="store_true", help="only print how the dataset is labeled"
    )
    parser.add_argument(
        "--curb-types",
        nargs="+",
        default=["curb"],
        help="values of the step 'type' attribute that count as curbs",
    )
    parser.add_argument("--val-percent", type=int, default=10)
    parser.add_argument(
        "--keep-empty",
        action="store_true",
        help="also keep images with no stairs or curbs",
    )
    args = parser.parse_args()

    if args.inspect:
        inspect(sorted(args.src.rglob("*.xml")))
        return
    counts = convert(
        args.src,
        args.out,
        {t.lower() for t in args.curb_types},
        args.val_percent,
        args.keep_empty,
    )
    print(f"wrote {args.out}")
    for key in sorted(counts):
        print(f"  {key}: {counts[key]}")


if __name__ == "__main__":
    main()
