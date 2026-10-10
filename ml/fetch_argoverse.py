"""Download Argoverse-HD (ring-front-center camera) in YOLO format using Ultralytics' own dataset check.

WARNING: about 31.5 GB to download, and about the same again to unpack. Check your free disk space first.
The data is labeled CC BY-NC-SA 4.0 (non-commercial) on the Ultralytics page:
https://docs.ultralytics.com/datasets/detect/argoverse

  uv run --group ml python ml/fetch_argoverse.py --dry-run   # show where it would go
  uv run --group ml python ml/fetch_argoverse.py             # download to datasets/raw/Argoverse

For this run only, Ultralytics' download folder is pointed at datasets/raw/, so your global Ultralytics settings
(and any other project's datasets) are left alone.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ml.yolo_utils import REPO_ROOT


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--raw-dir", type=Path, default=REPO_ROOT / "datasets" / "raw")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    import ultralytics

    config = Path(ultralytics.__file__).parent / "cfg" / "datasets" / "Argoverse.yaml"
    info = yaml.safe_load(config.read_text(encoding="utf-8"))
    root = args.raw_dir / info["path"]  # datasets/raw/Argoverse
    print(f"destination: {root} (images in {root / 'Argoverse-1.1' / 'images'})")
    print(f"classes: {list(info['names'].values())}")
    if args.dry_run:
        print("dry run: nothing downloaded.")
        return

    import ultralytics.data.utils as ultralytics_data

    args.raw_dir.mkdir(parents=True, exist_ok=True)
    # check_det_dataset puts relative dataset paths under this folder.
    ultralytics_data.DATASETS_DIR = args.raw_dir
    ultralytics_data.check_det_dataset("Argoverse.yaml")


if __name__ == "__main__":
    main()
