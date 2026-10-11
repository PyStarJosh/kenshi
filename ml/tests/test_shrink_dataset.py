import os
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from ml.shrink_dataset import shrink_image, target_size


def write_image(path: Path, width: int, height: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    noise = np.random.default_rng(0).integers(
        0, 255, (height, width, 3), dtype=np.uint8
    )
    cv2.imwrite(str(path), noise)


class TargetSize(unittest.TestCase):
    def test_small_images_are_left_alone(self):
        self.assertIsNone(target_size(640, 480, 640))
        self.assertIsNone(target_size(300, 200, 640))

    def test_the_longer_side_is_capped_and_the_aspect_ratio_kept(self):
        self.assertEqual(target_size(1920, 1200, 640), (640, 400))
        self.assertEqual(target_size(3000, 4000, 640), (480, 640))

    def test_never_returns_a_zero_side(self):
        width, height = target_size(10000, 3, 640)
        self.assertGreaterEqual(height, 1)
        self.assertEqual(width, 640)


class ShrinkImage(unittest.TestCase):
    def test_shrinks_a_big_image_and_keeps_the_hard_linked_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw" / "big.jpg"
            write_image(raw, 1920, 1200)
            copy = Path(tmp) / "hazards" / "images" / "train" / "big.jpg"
            copy.parent.mkdir(parents=True)
            os.link(raw, copy)
            original_size = raw.stat().st_size
            self.assertTrue(shrink_image(copy, 640))
            shrunk = cv2.imread(str(copy))
            self.assertEqual(shrunk.shape[:2], (400, 640))
            self.assertEqual(
                raw.stat().st_size, original_size
            )  # the download is untouched
            self.assertEqual(cv2.imread(str(raw)).shape[:2], (1200, 1920))
            self.assertFalse(copy.with_name("big.jpg.tmp").exists())

    def test_a_second_run_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.jpg"
            write_image(path, 2000, 1000)
            self.assertTrue(shrink_image(path, 640))
            before = path.stat().st_mtime_ns
            self.assertFalse(shrink_image(path, 640))
            self.assertEqual(path.stat().st_mtime_ns, before)

    def test_an_unreadable_file_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.jpg"
            path.write_bytes(b"not an image")
            with self.assertRaises(ValueError):
                shrink_image(path, 640)


if __name__ == "__main__":
    unittest.main()
