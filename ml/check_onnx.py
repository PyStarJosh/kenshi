"""Run the exported 416 model with onnxruntime on the ultralytics sample images and print detections.

Run from the repo root: uv run --group ml python ml/check_onnx.py [--model PATH] [--top 6] [--images-dir DIR]
"""

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = REPO_ROOT / "web" / "public" / "models" / "yolo26n-416.onnx"
CLASS_MAP = REPO_ROOT / "ml" / "class_map.json"
IMAGES = ["bus.jpg", "zidane.jpg"]
SCORE_MIN = 0.25
NMS_IOU = 0.45


def letterbox(image: np.ndarray, size: int) -> tuple[np.ndarray, float, int, int]:
    h, w = image.shape[:2]
    scale = min(size / h, size / w)
    nh, nw = round(h * scale), round(w * scale)
    pad_y, pad_x = (size - nh) // 2, (size - nw) // 2
    canvas = np.full((size, size, 3), 114, np.uint8)
    canvas[pad_y : pad_y + nh, pad_x : pad_x + nw] = np.asarray(Image.fromarray(image).resize((nw, nh), Image.BILINEAR))
    return canvas, scale, pad_x, pad_y


def nms(boxes: np.ndarray, scores: np.ndarray) -> list[int]:
    order = scores.argsort()[::-1]
    kept: list[int] = []
    while order.size:
        i = order[0]
        kept.append(int(i))
        rest = order[1:]
        w = np.clip(np.minimum(boxes[i, 2], boxes[rest, 2]) - np.maximum(boxes[i, 0], boxes[rest, 0]), 0, None)
        h = np.clip(np.minimum(boxes[i, 3], boxes[rest, 3]) - np.maximum(boxes[i, 1], boxes[rest, 1]), 0, None)
        area = lambda b: (b[..., 2] - b[..., 0]) * (b[..., 3] - b[..., 1])
        iou = w * h / (area(boxes[i]) + area(boxes[rest]) - w * h)
        order = rest[iou <= NMS_IOU]
    return kept


def detect(session: ort.InferenceSession, image: np.ndarray, size: int) -> list[tuple[float, int, list[int]]]:
    canvas, scale, pad_x, pad_y = letterbox(image, size)
    blob = canvas.transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    out = session.run(None, {session.get_inputs()[0].name: blob})[0][0].T  # [N, 4 + nc]
    scores = out[:, 4:]
    ids = scores.argmax(axis=1)
    conf = scores.max(axis=1)
    keep = conf >= SCORE_MIN
    boxes = out[keep, :4]
    xyxy = np.stack(
        [(boxes[:, 0] - boxes[:, 2] / 2 - pad_x) / scale, (boxes[:, 1] - boxes[:, 3] / 2 - pad_y) / scale,
         (boxes[:, 0] + boxes[:, 2] / 2 - pad_x) / scale, (boxes[:, 1] + boxes[:, 3] / 2 - pad_y) / scale],
        axis=1,
    )
    result = []
    for cls in np.unique(ids[keep]):
        idx = np.where(ids[keep] == cls)[0]
        for i in nms(xyxy[idx], conf[keep][idx]):
            result.append((float(conf[keep][idx][i]), int(cls), [round(v) for v in xyxy[idx][i]]))
    return sorted(result, reverse=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--top", type=int, default=6)
    parser.add_argument("--images-dir", type=Path, help="folder with bus.jpg and zidane.jpg (default: ultralytics assets)")
    args = parser.parse_args()
    if args.images_dir is None:
        import ultralytics

        args.images_dir = Path(ultralytics.__file__).resolve().parent / "assets"
    labels = [c["label"] for c in json.loads(CLASS_MAP.read_text(encoding="utf-8"))]
    session = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    size = session.get_inputs()[0].shape[2]
    print(f"{args.model.name}: input {session.get_inputs()[0].shape}, output {session.get_outputs()[0].shape}")
    for name in IMAGES:
        image = np.asarray(Image.open(args.images_dir / name).convert("RGB"))
        found = detect(session, image, size)
        print(f"\n{name}: {len(found)} detections")
        for score, cls, box in found[: args.top]:
            print(f"  {labels[cls]:<12} {score:.2f}  box {box}")


if __name__ == "__main__":
    main()
