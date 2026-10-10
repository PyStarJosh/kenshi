"""Export YOLO26n to ONNX at each input size and copy the files into the web app.

Run from the repo root: uv run --group ml python ml/export_onnx.py [--sizes 320 416]
"""

import argparse
import shutil
from pathlib import Path

import onnx
from ultralytics import YOLO

REPO_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = REPO_ROOT / "web" / "public" / "models"
MAX_BYTES = 15 * 1024 * 1024


def export(weights: str, size: int) -> Path:
    exported = Path(YOLO(weights).export(format="onnx", imgsz=size, simplify=True, dynamic=False))
    target = MODELS_DIR / f"{Path(weights).stem}-{size}.onnx"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(exported, target)
    if target.stat().st_size >= MAX_BYTES:
        raise SystemExit(f"{target.name} is {target.stat().st_size} bytes; the limit is 15 MB")
    return target


def describe(path: Path) -> None:
    graph = onnx.load(path).graph
    inputs = [(i.name, [d.dim_value for d in i.type.tensor_type.shape.dim]) for i in graph.input]
    outputs = [(o.name, [d.dim_value for d in o.type.tensor_type.shape.dim]) for o in graph.output]
    print(f"{path.name}: {path.stat().st_size / 1e6:.1f} MB, inputs {inputs}, outputs {outputs}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", default="yolo26n.pt")
    parser.add_argument("--sizes", type=int, nargs="+", default=[320, 416])
    args = parser.parse_args()
    for size in args.sizes:
        describe(export(args.weights, size))


if __name__ == "__main__":
    main()
