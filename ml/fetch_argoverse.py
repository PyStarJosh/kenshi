"""Download Argoverse-HD (ring-front-center camera) and convert it to YOLO format.

WARNING: 31.5 GB to download, and about the same again to unpack. Check your free disk space first.
The data is labeled CC BY-NC-SA 4.0 (non-commercial) on the Ultralytics page:
https://docs.ultralytics.com/datasets/detect/argoverse

  uv run --group ml python ml/fetch_argoverse.py --dry-run   # show the plan
  uv run --group ml python ml/fetch_argoverse.py             # download, unzip, convert

Steps, each skipped if it is already done, so the command is safe to run again after an interruption:
  1. Download Argoverse-HD-Full.zip from the Google Drive file Ultralytics points to, in parallel resumable pieces.
  2. Unzip it into datasets/raw/Argoverse/.
  3. Run Ultralytics' own converter (it renames tracking/ to images/ and writes YOLO labels).
  4. Delete the zip (keep it with --keep-zip).
Ultralytics' converter prints a warning that the dataset "MUST be downloaded manually"; that is its own message about the
download step, which this script has already done. If Google ever refuses the download (a quota or a login page), download
the file in a browser from the link in that warning, put it at datasets/raw/Argoverse/Argoverse-HD-Full.zip, and run this again.
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

import yaml

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ml.downloads import download
from ml.yolo_utils import REPO_ROOT

# The Google Drive file named in Ultralytics' Argoverse.yaml, as a direct (large-file) download.
ARGOVERSE_URL = "https://drive.usercontent.google.com/download?id=1st9qW3BeIwQsnR0t8mRpvbsSWIo16ACi&export=download&confirm=t"
ZIP_NAME = "Argoverse-HD-Full.zip"


def is_converted(root: Path) -> bool:
    """The converter has run once the tracking/ folder has become images/ and labels/ exists."""
    base = root / "Argoverse-1.1"
    return (
        (base / "images").exists()
        and (base / "labels").exists()
        and not (base / "tracking").exists()
    )


def unzip(archive: Path, root: Path) -> None:
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        print(f"unzipping {len(names)} files to {root}", flush=True)
        for i, name in enumerate(names, 1):
            z.extract(name, root)
            if i % 5000 == 0:
                print(f"  {i} of {len(names)}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--raw-dir", type=Path, default=REPO_ROOT / "datasets" / "raw")
    parser.add_argument(
        "--pieces", type=int, default=8, help="parallel download pieces"
    )
    parser.add_argument("--keep-zip", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    import ultralytics

    config = Path(ultralytics.__file__).parent / "cfg" / "datasets" / "Argoverse.yaml"
    info = yaml.safe_load(config.read_text(encoding="utf-8"))
    root = args.raw_dir / info["path"]  # datasets/raw/Argoverse
    archive = root / ZIP_NAME
    print(f"destination: {root} (images in {root / 'Argoverse-1.1' / 'images'})")
    print(f"classes: {list(info['names'].values())}")
    if args.dry_run:
        print(
            f"dry run: would download {ARGOVERSE_URL} to {archive}, unzip it, and convert it. Nothing done."
        )
        return
    if is_converted(root):
        print("already downloaded and converted, nothing to do")
        return

    base = root / "Argoverse-1.1"
    if not (base / "tracking").exists():
        download(
            ARGOVERSE_URL,
            archive,
            pieces=args.pieces,
            log=lambda line: print(line, flush=True),
        )
        unzip(archive, root)
    if not (base / "tracking").exists():
        raise SystemExit(
            f"expected {base / 'tracking'} after unzipping; check what is in {root}"
        )

    import ultralytics.data.utils as ultralytics_data

    # check_det_dataset puts relative dataset paths under this folder and runs the dataset's converter.
    ultralytics_data.DATASETS_DIR = args.raw_dir
    ultralytics_data.check_det_dataset("Argoverse.yaml")
    if not is_converted(root):
        raise SystemExit(
            "the conversion did not produce Argoverse-1.1/images and labels; see the messages above"
        )
    if archive.exists() and not args.keep_zip:
        archive.unlink()
        print(f"deleted {archive}", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
