"""Shrink the images in datasets/hazards/ so the zip is small and Colab trains faster.

Training runs at 416 px, but phone photos are 12 megapixels and Argoverse frames are 1920x1200. Decoding those is the
bottleneck on Colab's two CPUs, and they make the upload several times bigger than it needs to be. This caps the longer
side of every image (default 640 px, which still leaves room for zoom augmentation). Labels are fractions of the image,
so they stay as they are.

Images in datasets/hazards/ are hard links to the downloads in datasets/raw/. Each image is written to a new file and
swapped in, so the downloads are never touched. Running it again skips images that are already small.

  uv run --group ml python ml/shrink_dataset.py --zip
"""

from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ml.prepare_dataset import DEFAULT_OUT, make_zip
from ml.yolo_utils import IMAGE_SUFFIXES

DEFAULT_MAX_SIDE = 640
JPEG_QUALITY = 90


def target_size(width: int, height: int, max_side: int) -> tuple[int, int] | None:
    """The (width, height) to shrink to, or None if the image already fits."""
    longest = max(width, height)
    if longest <= max_side:
        return None
    scale = max_side / longest
    return max(1, round(width * scale)), max(1, round(height * scale))


def shrink_image(path: Path, max_side: int, quality: int = JPEG_QUALITY) -> bool:
    """Shrink one image in place (as a new file, so hard links elsewhere keep the original). True if it changed."""
    data = np.fromfile(path, dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"cannot read {path}")
    size = target_size(image.shape[1], image.shape[0], max_side)
    if size is None:
        return False
    small = cv2.resize(image, size, interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(
        path.suffix.lower() if path.suffix.lower() in {".png"} else ".jpg",
        small,
        [cv2.IMWRITE_JPEG_QUALITY, quality],
    )
    if not ok:
        raise ValueError(f"cannot encode {path}")
    temp = path.with_name(path.name + ".tmp")
    encoded.tofile(temp)
    os.replace(
        temp, path
    )  # replaces the directory entry; the hard-linked original keeps its data
    return True


def folder_bytes(directory: Path) -> int:
    return sum(p.stat().st_size for p in directory.rglob("*") if p.is_file())


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--max-side", type=int, default=DEFAULT_MAX_SIDE)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--zip", action="store_true", help="write <dir>.zip afterwards")
    args = parser.parse_args()

    images = [
        p
        for p in (args.dir / "images").rglob("*")
        if p.suffix.lower() in IMAGE_SUFFIXES
    ]
    before = folder_bytes(args.dir / "images")
    print(
        f"{len(images)} images, {before / 1e9:.2f} GB; longer side capped at {args.max_side} px"
    )
    with ThreadPoolExecutor(args.threads) as pool:
        changed = sum(pool.map(lambda p: shrink_image(p, args.max_side), images))
    after = folder_bytes(args.dir / "images")
    print(f"shrunk {changed} images: {before / 1e9:.2f} GB -> {after / 1e9:.2f} GB")
    if args.zip:
        make_zip(args.dir, args.dir.with_suffix(".zip"))


if __name__ == "__main__":
    main()
