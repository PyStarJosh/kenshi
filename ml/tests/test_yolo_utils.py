import tempfile
import unittest
from collections import Counter
from pathlib import Path
from typing import ClassVar

from ml.yolo_utils import (
    BASE_CLASS_MAP,
    HAZARD_CLASS_MAP,
    HAZARD_LABELS,
    Box,
    imbalance_warnings,
    iou,
    kept_ids,
    label_to_id,
    load_class_table,
    merge_pseudo,
    read_labels,
    remap_boxes,
    sample_stems,
    split_for,
    write_labels,
    xyxy_to_box,
)


class ClassTables(unittest.TestCase):
    def test_hazard_table_extends_the_base_table_without_renumbering(self):
        base = load_class_table(BASE_CLASS_MAP)
        hazard = load_class_table(HAZARD_CLASS_MAP)
        self.assertEqual(len(base), 80)
        self.assertEqual(len(hazard), 84)
        self.assertEqual(hazard[:80], base)
        self.assertEqual([r["label"] for r in hazard[80:]], list(HAZARD_LABELS))
        self.assertEqual([r["id"] for r in hazard[80:]], [80, 81, 82, 83])

    def test_new_classes_are_announced(self):
        hazard = load_class_table(HAZARD_CLASS_MAP)
        self.assertTrue(all(r["alertable"] for r in hazard[80:]))

    def test_kept_ids_are_the_alertable_coco_classes(self):
        base = load_class_table(BASE_CLASS_MAP)
        ids = kept_ids(base)
        self.assertEqual(len(ids), 17)
        self.assertIn(label_to_id(base)["person"], ids)
        self.assertNotIn(label_to_id(base)["tv"], ids)

    def test_ids_must_be_consecutive(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text(
                '[{"id": 0, "label": "a"}, {"id": 2, "label": "b"}]', encoding="utf-8"
            )
            with self.assertRaises(ValueError):
                load_class_table(path)


class LabelFiles(unittest.TestCase):
    def test_round_trip(self):
        boxes = [Box(3, 0.5, 0.25, 0.2, 0.1), Box(80, 0.1, 0.9, 0.05, 0.3)]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a" / "label.txt"
            write_labels(path, boxes)
            back = read_labels(path)
        for original, loaded in zip(boxes, back):
            self.assertEqual(original.cls, loaded.cls)
            self.assertAlmostEqual(original.cx, loaded.cx, places=5)
            self.assertAlmostEqual(original.h, loaded.h, places=5)
        self.assertEqual(len(back), 2)

    def test_missing_file_means_no_objects(self):
        self.assertEqual(read_labels(Path("does-not-exist.txt")), [])

    def test_segmentation_lines_are_refused_not_misread_as_boxes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "label.txt"
            path.write_text("1 0.1 0.1 0.2 0.1 0.2 0.2 0.1 0.2\n", encoding="utf-8")
            with self.assertRaises(ValueError) as caught:
                read_labels(path)
            self.assertIn("segmentation", str(caught.exception))

    def test_short_lines_are_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "label.txt"
            path.write_text("1 0.5 0.5 0.1 0.1\n\n2 0.5\n", encoding="utf-8")
            self.assertEqual(len(read_labels(path)), 1)


class BoxMath(unittest.TestCase):
    def test_iou(self):
        a = Box(0, 0.25, 0.25, 0.5, 0.5)
        self.assertAlmostEqual(iou(a, a), 1.0)
        self.assertEqual(iou(a, Box(0, 0.9, 0.9, 0.1, 0.1)), 0.0)
        self.assertAlmostEqual(iou(a, Box(0, 0.5, 0.25, 0.5, 0.5)), 1 / 3)

    def test_remap_renames_and_drops(self):
        boxes = [
            Box(0, 0.5, 0.5, 0.1, 0.1),
            Box(1, 0.2, 0.2, 0.1, 0.1),
            Box(2, 0.7, 0.7, 0.1, 0.1),
        ]
        mapped = remap_boxes(boxes, {0: 80, 2: 83})
        self.assertEqual([b.cls for b in mapped], [80, 83])

    def test_pixel_corners_become_a_normalized_box(self):
        box = xyxy_to_box(1, 100, 50, 300, 150, 1000, 500)
        self.assertEqual((box.cx, box.cy, box.w, box.h), (0.2, 0.2, 0.2, 0.2))

    def test_corners_are_clamped_to_the_image(self):
        box = xyxy_to_box(0, -50, -50, 200, 100, 400, 200)
        self.assertAlmostEqual(box.cx - box.w / 2, 0.0)
        self.assertAlmostEqual(box.cy - box.h / 2, 0.0)

    def test_degenerate_boxes_are_dropped(self):
        self.assertIsNone(xyxy_to_box(0, 10, 10, 10.5, 50, 100, 100))
        self.assertIsNone(xyxy_to_box(0, 500, 500, 600, 600, 100, 100))


class PseudoLabels(unittest.TestCase):
    def test_adds_boxes_that_are_not_already_labeled(self):
        existing = [Box(80, 0.3, 0.5, 0.2, 0.4)]
        predicted = [Box(0, 0.7, 0.5, 0.2, 0.4)]  # a person elsewhere in the picture
        merged = merge_pseudo(existing, predicted)
        self.assertEqual([b.cls for b in merged], [80, 0])

    def test_skips_a_duplicate_of_an_existing_box_of_the_same_class(self):
        existing = [Box(0, 0.5, 0.5, 0.2, 0.4)]
        predicted = [Box(0, 0.51, 0.5, 0.2, 0.4)]
        self.assertEqual(merge_pseudo(existing, predicted), existing)

    def test_keeps_an_overlapping_box_of_a_different_class(self):
        existing = [Box(80, 0.5, 0.5, 0.2, 0.4)]
        predicted = [Box(0, 0.5, 0.5, 0.2, 0.4)]
        self.assertEqual(len(merge_pseudo(existing, predicted)), 2)

    def test_does_not_modify_its_input(self):
        existing = [Box(80, 0.3, 0.5, 0.2, 0.4)]
        merge_pseudo(existing, [Box(0, 0.7, 0.5, 0.2, 0.4)])
        self.assertEqual(len(existing), 1)


class Splits(unittest.TestCase):
    def test_split_is_stable(self):
        self.assertEqual(split_for("img_001"), split_for("img_001"))

    def test_split_share_is_close_to_the_requested_percentage(self):
        names = [f"image_{i}" for i in range(5000)]
        val = sum(split_for(n, 10) == "val" for n in names)
        self.assertTrue(400 < val < 600, val)

    def test_zero_percent_means_everything_trains(self):
        self.assertTrue(all(split_for(f"x{i}", 0) == "train" for i in range(200)))

    def test_sampling_is_reproducible_and_bounded(self):
        items = [f"file{i}" for i in range(100)]
        self.assertEqual(sample_stems(items, 10), sample_stems(items, 10))
        self.assertEqual(len(sample_stems(items, 10)), 10)
        self.assertEqual(sample_stems(items, None), items)
        self.assertEqual(sample_stems(items, 500), items)
        self.assertNotEqual(
            sample_stems(items, 10, seed=1), sample_stems(items, 10, seed=2)
        )


class Balance(unittest.TestCase):
    names: ClassVar[list[str]] = ["a", "b", "c"]

    def test_no_warnings_for_a_healthy_set(self):
        warnings = imbalance_warnings(
            Counter({0: 1000, 1: 800, 2: 600}),
            Counter({0: 100, 1: 100, 2: 100}),
            self.names,
        )
        self.assertEqual(warnings, [])

    def test_warns_about_strong_imbalance(self):
        warnings = imbalance_warnings(
            Counter({0: 20000, 1: 800, 2: 600}),
            Counter({0: 100, 1: 100, 2: 100}),
            self.names,
        )
        self.assertTrue(any("strong imbalance" in w and "'a'" in w for w in warnings))

    def test_warns_about_missing_and_thin_classes(self):
        warnings = imbalance_warnings(
            Counter({0: 1000, 1: 50}),
            Counter({0: 100, 1: 5}),
            self.names,
            focus=["a", "b", "c"],
        )
        text = " ".join(warnings)
        self.assertIn("'c' has no training instances", text)
        self.assertIn("'b' has only 50 training instances", text)
        self.assertIn("'b' has only 5 validation instances", text)

    def test_focus_limits_the_checks(self):
        warnings = imbalance_warnings(
            Counter({0: 1000}), Counter({0: 100}), self.names, focus=["a"]
        )
        self.assertEqual(warnings, [])


if __name__ == "__main__":
    unittest.main()
