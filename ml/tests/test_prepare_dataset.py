import tempfile
import unittest
from pathlib import Path

from ml.prepare_dataset import Source, collect_split, import_source, output_name


def touch(path: Path, text: str = "x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def make_source(root: Path) -> Source:
    return Source(
        name="argo",
        kind="kept",
        path=root,
        names=["person", "car"],
        mapping={"person": "person", "car": "car"},
        pseudo_label=False,
        max_images={"train": None, "val": None},
    )


class NestedLayout(unittest.TestCase):
    """Argoverse keeps images/<split>/<log>/<camera>/<name>.jpg and labels/<log>/<camera>/<name>.txt."""

    def test_labels_are_found_without_the_split_folder_and_names_stay_unique(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for split in ("train", "val"):
                for log in ("logA", "logB"):
                    touch(
                        root
                        / "images"
                        / split
                        / log
                        / "ring_front_center"
                        / "frame_1.jpg"
                    )
                    touch(
                        root
                        / "labels"
                        / split
                        / log
                        / "ring_front_center"
                        / "frame_1.txt",
                        "0 0.5 0.5 0.2 0.2\n",
                    )
            source = make_source(root)
            train = collect_split(source, "train", None, 10)
            self.assertEqual(len(train), 2)
            for image, label in train:
                self.assertTrue(label.exists(), f"no label found for {image}")
            names = {
                output_name("argo", image, root / "images" / "train")
                for image, _ in train
            }
            self.assertEqual(
                len(names), 2
            )  # same file name in two logs must not collide

    def test_labels_mirroring_the_image_folder_without_split(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            touch(root / "images" / "train" / "logA" / "cam" / "f1.jpg")
            touch(root / "images" / "val" / "logB" / "cam" / "f2.jpg")
            touch(root / "labels" / "logA" / "cam" / "f1.txt", "0 0.5 0.5 0.2 0.2\n")
            touch(root / "labels" / "logB" / "cam" / "f2.txt", "1 0.5 0.5 0.2 0.2\n")
            source = make_source(root)
            for split in ("train", "val"):
                (pair,) = collect_split(source, split, None, 10)
                self.assertTrue(pair[1].exists())

    def test_a_unique_label_name_elsewhere_is_used_as_a_last_resort(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            touch(root / "images" / "train" / "logA" / "f1.jpg")
            touch(root / "images" / "val" / "logB" / "f2.jpg")
            touch(
                root / "labels" / "somewhere" / "else" / "f1.txt", "0 0.5 0.5 0.2 0.2\n"
            )
            (pair,) = collect_split(make_source(root), "train", None, 10)
            self.assertEqual(pair[1].name, "f1.txt")
            self.assertTrue(pair[1].exists())

    def test_an_ambiguous_label_name_is_not_guessed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            touch(root / "images" / "train" / "logA" / "f1.jpg")
            touch(root / "images" / "val" / "logB" / "f2.jpg")
            touch(root / "labels" / "x" / "f1.txt", "0 0.5 0.5 0.2 0.2\n")
            touch(root / "labels" / "y" / "f1.txt", "1 0.5 0.5 0.2 0.2\n")
            (pair,) = collect_split(make_source(root), "train", None, 10)
            self.assertFalse(pair[1].exists())

    def test_import_copies_nested_images_and_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            touch(root / "images" / "train" / "logA" / "cam" / "f1.jpg")
            touch(root / "images" / "val" / "logB" / "cam" / "f2.jpg")
            touch(root / "labels" / "logA" / "cam" / "f1.txt", "0 0.5 0.5 0.2 0.2\n")
            touch(root / "labels" / "logB" / "cam" / "f2.txt", "1 0.5 0.5 0.2 0.2\n")
            rows: list[dict] = []
            ids = {"person": 0, "car": 2}
            total = import_source(make_source(root), out, ids, None, 10, rows)
            self.assertEqual(total, 2)
            self.assertEqual(len(list((out / "images" / "train").iterdir())), 1)
            self.assertEqual(len(list((out / "labels" / "val").iterdir())), 1)


class FlatLayout(unittest.TestCase):
    def test_flat_sources_still_work_and_keep_plain_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            touch(root / "images" / "train" / "a.jpg")
            touch(root / "labels" / "train" / "a.txt", "0 0.5 0.5 0.2 0.2\n")
            (pair,) = collect_split(make_source(root), "train", None, 0)
            self.assertEqual(pair[1], root / "labels" / "train" / "a.txt")
            self.assertEqual(
                output_name("argo", pair[0], root / "images" / "train"), "argo__a"
            )


if __name__ == "__main__":
    unittest.main()
