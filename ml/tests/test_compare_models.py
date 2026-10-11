import unittest
from typing import ClassVar

import numpy as np

from ml.compare_models import (
    Det,
    decode,
    edge_counts,
    match_counts,
    nms,
    precision_recall,
    recall_flags,
    touches_edge,
)
from ml.yolo_utils import Box


def det(cls, conf, cx, cy, w, h):
    return Det(cls, conf, Box(cls, cx, cy, w, h))


class Matching(unittest.TestCase):
    truth: ClassVar[list[Box]] = [
        Box(0, 0.25, 0.5, 0.2, 0.4),
        Box(0, 0.75, 0.5, 0.2, 0.4),
    ]

    def test_perfect_predictions(self):
        preds = [det(0, 0.9, 0.25, 0.5, 0.2, 0.4), det(0, 0.8, 0.75, 0.5, 0.2, 0.4)]
        self.assertEqual(match_counts(self.truth, preds, {0})[0], [2, 0, 0])

    def test_a_miss_and_a_false_alarm(self):
        preds = [det(0, 0.9, 0.25, 0.5, 0.2, 0.4), det(0, 0.8, 0.5, 0.1, 0.05, 0.05)]
        self.assertEqual(match_counts(self.truth, preds, {0})[0], [1, 1, 1])

    def test_a_box_is_matched_only_once(self):
        preds = [det(0, 0.9, 0.25, 0.5, 0.2, 0.4), det(0, 0.7, 0.25, 0.5, 0.2, 0.4)]
        tp, fp, fn = match_counts(self.truth, preds, {0})[0]
        self.assertEqual((tp, fp, fn), (1, 1, 1))

    def test_other_classes_are_ignored(self):
        preds = [det(5, 0.9, 0.25, 0.5, 0.2, 0.4)]
        counts = match_counts(self.truth, preds, {0})
        self.assertEqual(counts[0], [0, 0, 2])
        self.assertNotIn(5, counts)

    def test_wrong_class_at_the_right_place_is_a_miss(self):
        preds = [det(1, 0.9, 0.25, 0.5, 0.2, 0.4)]
        self.assertEqual(
            match_counts(self.truth, preds, {0, 1}), {0: [0, 0, 2], 1: [0, 1, 0]}
        )

    def test_precision_and_recall(self):
        self.assertEqual(precision_recall(8, 2, 2), (0.8, 0.8))
        self.assertEqual(precision_recall(0, 0, 0), (None, None))
        self.assertEqual(precision_recall(0, 3, 0), (0.0, None))


class EdgeCutOffObjects(unittest.TestCase):
    def test_a_box_reaching_any_border_is_cut_off(self):
        self.assertTrue(touches_edge(Box(0, 0.1, 0.5, 0.2, 0.3)))  # left border at 0.0
        self.assertTrue(touches_edge(Box(0, 0.9, 0.5, 0.2, 0.3)))  # right border at 1.0
        self.assertTrue(touches_edge(Box(0, 0.5, 0.9, 0.2, 0.2)))  # bottom
        self.assertTrue(touches_edge(Box(0, 0.5, 0.1, 0.2, 0.2)))  # top
        self.assertFalse(touches_edge(Box(0, 0.5, 0.5, 0.2, 0.3)))

    def test_only_cut_off_ground_truth_boxes_are_scored(self):
        truth = [
            Box(0, 0.1, 0.5, 0.2, 0.4),
            Box(0, 0.6, 0.5, 0.2, 0.4),
        ]  # first touches the left border
        found_only_the_whole_one = [det(0, 0.9, 0.6, 0.5, 0.2, 0.4)]
        self.assertEqual(edge_counts(truth, found_only_the_whole_one, {0})[0], [0, 1])
        found_the_cut_one = [det(0, 0.9, 0.1, 0.5, 0.2, 0.4)]
        self.assertEqual(edge_counts(truth, found_the_cut_one, {0})[0], [1, 0])

    def test_no_cut_off_objects_gives_zero_support(self):
        truth = [Box(0, 0.5, 0.5, 0.2, 0.4)]
        self.assertEqual(edge_counts(truth, [], {0})[0], [0, 0])


class RecallFlags(unittest.TestCase):
    names: ClassVar[list[str]] = ["person", "chair", "car"]

    @staticmethod
    def result(recall, support=100):
        return {"recall": recall, "support": support}

    def test_flags_a_drop_of_more_than_three_points(self):
        base = {0: self.result(0.90), 1: self.result(0.80)}
        hazard = {0: self.result(0.85), 1: self.result(0.79)}
        flags = recall_flags(base, hazard, [0, 1], self.names)
        self.assertEqual(len(flags), 1)
        self.assertIn("person", flags[0])
        self.assertIn("5.0 points", flags[0])

    def test_exactly_three_points_is_not_flagged(self):
        flags = recall_flags(
            {0: self.result(0.90)}, {0: self.result(0.87)}, [0], self.names
        )
        self.assertEqual(flags, [])

    def test_improvements_and_missing_data_are_not_flagged(self):
        self.assertEqual(
            recall_flags({0: self.result(0.5)}, {0: self.result(0.9)}, [0], self.names),
            [],
        )
        self.assertEqual(
            recall_flags(
                {0: self.result(None)}, {0: self.result(0.9)}, [0], self.names
            ),
            [],
        )
        self.assertEqual(recall_flags({}, {}, [0, 1], self.names), [])

    def test_a_flag_on_a_class_with_few_examples_says_so(self):
        flags = recall_flags(
            {2: self.result(0.9, support=5)},
            {2: self.result(0.5, support=5)},
            [2],
            self.names,
        )
        self.assertIn("few examples", flags[0])


class ModelLayout(unittest.TestCase):
    def test_an_end_to_end_export_is_refused_with_a_clear_message(self):
        import tempfile
        from pathlib import Path

        import onnx
        from onnx import TensorProto, helper

        from ml.compare_models import OnnxDetector

        # A tiny model whose output is [1, 300, 6] (boxes already selected), not [1, 4 + classes, N].
        inp = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, 32, 32])
        out = helper.make_tensor_value_info("output0", TensorProto.FLOAT, [1, 300, 6])
        node = helper.make_node(
            "Constant",
            [],
            ["output0"],
            value=helper.make_tensor("c", TensorProto.FLOAT, [1, 300, 6], [0.0] * 1800),
        )
        model = helper.make_model(
            helper.make_graph([node], "g", [inp], [out]),
            opset_imports=[helper.make_opsetid("", 13)],
        )
        model.ir_version = 10  # the newest file format onnxruntime accepts is older than onnx's default
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "end2end.onnx"
            onnx.save(model, path)
            with self.assertRaises(ValueError) as caught:
                OnnxDetector(path)
        self.assertIn("raw output", str(caught.exception))


class Decoding(unittest.TestCase):
    def test_decodes_boxes_through_the_letterbox_and_applies_the_threshold(self):
        # 3 anchors, 2 classes; input 100 x 100 holding a picture 100 wide and 50 tall (pad_y 25).
        output = np.array(
            [
                [50.0, 50.0, 10.0],  # cx
                [50.0, 50.0, 10.0],  # cy
                [40.0, 40.0, 5.0],  # w
                [20.0, 20.0, 5.0],  # h
                [0.9, 0.1, 0.2],  # class 0
                [0.1, 0.8, 0.3],  # class 1
            ]
        )
        detections = decode(output, (0, 25, 100, 50), conf=0.5, nms_iou=0.45)
        self.assertEqual(len(detections), 2)  # the third anchor is below the threshold
        first = max(detections, key=lambda d: d.conf)
        self.assertEqual(first.cls, 0)
        self.assertAlmostEqual(first.box.cx, 0.5)
        self.assertAlmostEqual(first.box.cy, 0.5)  # (50 - 25) / 50
        self.assertAlmostEqual(first.box.w, 0.4)
        self.assertAlmostEqual(first.box.h, 0.4)  # 20 / 50

    def test_nms_suppresses_same_class_overlaps_only(self):
        a = det(0, 0.9, 0.5, 0.5, 0.4, 0.4)
        b = det(0, 0.6, 0.51, 0.5, 0.4, 0.4)
        c = det(1, 0.7, 0.5, 0.5, 0.4, 0.4)
        kept = nms([a, b, c], 0.45)
        self.assertEqual([(d.cls, d.conf) for d in kept], [(0, 0.9), (1, 0.7)])


if __name__ == "__main__":
    unittest.main()
