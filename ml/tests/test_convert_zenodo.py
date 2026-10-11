import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from ml.convert_zenodo import OUT_NAMES, box_label, convert, image_boxes
from ml.yolo_utils import read_labels

CVAT = """<?xml version="1.0" encoding="utf-8"?>
<annotations>
  <version>1.1</version>
  <image id="0" name="images/street_001.jpg" width="1000" height="500">
    <box label="steps" occluded="0" xtl="100" ytl="300" xbr="300" ybr="350">
      <attribute name="height">more than 7cm</attribute>
      <attribute name="type">curb</attribute>
    </box>
    <box label="steps" occluded="0" xtl="400" ytl="300" xbr="500" ybr="340">
      <attribute name="height">3cm to 7cm</attribute>
      <attribute name="type">doorstep</attribute>
    </box>
    <box label="stairs" occluded="0" xtl="600" ytl="200" xbr="900" ybr="450">
      <attribute name="number of steps">8</attribute>
    </box>
    <box label="grab bars" occluded="0" xtl="10" ytl="10" xbr="60" ybr="60"/>
  </image>
  <image id="1" name="street_002.jpg" width="800" height="600">
    <box label="ramps" occluded="0" xtl="10" ytl="10" xbr="200" ybr="100"/>
  </image>
</annotations>
"""


class Labels(unittest.TestCase):
    def test_stairs_are_kept(self):
        self.assertEqual(box_label("stairs", {}, {"curb"}), "stairs")

    def test_the_dataset_s_singular_label_names_are_understood(self):
        self.assertEqual(box_label("stair", {}, {"curb"}), "stairs")
        self.assertEqual(box_label("step", {"type": "curb"}, {"curb"}), "curb")
        self.assertIsNone(box_label("step", {"type": "doorstep"}, {"curb"}))
        self.assertIsNone(box_label("grab_bar", {}, {"curb"}))
        self.assertIsNone(box_label("ramp", {}, {"curb"}))

    def test_steps_of_type_curb_become_curbs(self):
        self.assertEqual(box_label("steps", {"type": "curb"}, {"curb"}), "curb")
        self.assertEqual(box_label("Steps", {"type": " Curb "}, {"curb"}), "curb")

    def test_other_steps_ramps_and_grab_bars_are_dropped(self):
        self.assertIsNone(box_label("steps", {"type": "doorstep"}, {"curb"}))
        self.assertIsNone(box_label("steps", {}, {"curb"}))
        self.assertIsNone(box_label("ramps", {}, {"curb"}))
        self.assertIsNone(box_label("grab bars", {}, {"curb"}))

    def test_curb_types_can_be_widened(self):
        self.assertEqual(
            box_label("steps", {"type": "other"}, {"curb", "other"}), "curb"
        )


class Image(unittest.TestCase):
    def test_boxes_of_one_image(self):
        image = ET.fromstring(CVAT).findall("image")[0]
        name, boxes = image_boxes(image, {"curb"})
        self.assertEqual(name, "images/street_001.jpg")
        self.assertEqual([OUT_NAMES[b.cls] for b in boxes], ["curb", "stairs"])
        curb = boxes[0]
        self.assertAlmostEqual(curb.cx, 0.2)  # (100 + 300) / 2 / 1000
        self.assertAlmostEqual(curb.cy, 0.65)  # (300 + 350) / 2 / 500
        self.assertAlmostEqual(curb.w, 0.2)
        self.assertAlmostEqual(curb.h, 0.1)

    def test_an_image_with_only_dropped_labels_has_no_boxes(self):
        image = ET.fromstring(CVAT).findall("image")[1]
        self.assertEqual(image_boxes(image, {"curb"})[1], [])


class Conversion(unittest.TestCase):
    def test_converts_a_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / "src", Path(tmp) / "out"
            (src / "images").mkdir(parents=True)
            (src / "annotations.xml").write_text(CVAT, encoding="utf-8")
            (src / "images" / "street_001.jpg").write_bytes(b"fake")
            (src / "street_002.jpg").write_bytes(b"fake")
            counts = convert(src, out, {"curb"}, val_percent=100, keep_empty=False)
            labels = read_labels(out / "labels" / "val" / "street_001.txt")
            self.assertEqual([OUT_NAMES[b.cls] for b in labels], ["curb", "stairs"])
            self.assertTrue((out / "images" / "val" / "street_001.jpg").exists())
            # street_002 has only a ramp, so it is skipped unless empty images are kept
            self.assertFalse((out / "images" / "val" / "street_002.jpg").exists())
            self.assertEqual(counts["images val"], 1)
            self.assertEqual(counts["curb val"], 1)
            self.assertEqual(counts["stairs val"], 1)

    def test_files_sharing_a_name_are_told_apart_by_the_folder_in_the_xml(self):
        xml = (
            '<annotations><image id="0" name="a/dup.jpg" width="100" height="100">'
            '<box label="stairs" xtl="10" ytl="10" xbr="50" ybr="50"/></image>'
            '<image id="1" name="dup.jpg" width="100" height="100">'
            '<box label="stairs" xtl="10" ytl="10" xbr="50" ybr="50"/></image></annotations>'
        )
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / "src", Path(tmp) / "out"
            (src / "a").mkdir(parents=True)
            (src / "b").mkdir()
            (src / "a" / "dup.jpg").write_bytes(b"first")
            (src / "b" / "dup.jpg").write_bytes(b"second")
            (src / "annotations.xml").write_text(xml, encoding="utf-8")
            counts = convert(src, out, {"curb"}, val_percent=100, keep_empty=False)
            # "a/dup.jpg" names its folder, so it is found; plain "dup.jpg" could be either file, so it is skipped.
            self.assertEqual(counts["images val"], 1)
            self.assertEqual(counts["images skipped (file name not unique)"], 1)
            self.assertEqual(
                (out / "images" / "val" / "dup.jpg").read_bytes(), b"first"
            )

    def test_missing_images_are_counted_not_fatal(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / "src", Path(tmp) / "out"
            src.mkdir()
            (src / "annotations.xml").write_text(CVAT, encoding="utf-8")
            counts = convert(src, out, {"curb"}, val_percent=10, keep_empty=False)
            self.assertEqual(counts["images missing from disk"], 2)

    def test_no_xml_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(SystemExit):
            convert(Path(tmp), Path(tmp) / "out", {"curb"}, 10, False)


if __name__ == "__main__":
    unittest.main()
