"""Tests for ml/eval_walks.py. Run with: uv run --group analysis python -m unittest ml.tests.test_eval_walks"""

import tempfile
import unittest
from pathlib import Path

try:
    import pandas as pd

    from ml import eval_walks as ev
except ImportError as error:  # the ml dependency group has no pandas or matplotlib
    raise unittest.SkipTest(f"needs the analysis group: {error}")

FIXTURE = Path(__file__).resolve().parents[2] / "field-tests" / "fixture"


def alert(i, name, time_s, priority="normal", tone_ms=None, speech_ms=None, outcomes=("started", "finished")):
    a = ev.Alert(f"a{i}", priority, f"{name.capitalize()}, 12 o'clock, about 2 meters.", time_s - 0.3, time_s - 0.25)
    a.tone_s = None if tone_ms is None else a.frame_s + tone_ms / 1000
    a.speech_s = None if speech_ms is None else a.frame_s + speech_ms / 1000
    a.outcomes = set(outcomes)
    return a


def labels(rows):
    df = pd.DataFrame(rows, columns=ev.LABEL_COLUMNS)
    df["in_path"] = df["in_path"].str.lower()
    return df


def walk(alerts, n_frames=600, gap_s=0.1, paused=()):
    frames = pd.DataFrame({"capture_s": [i * gap_s for i in range(n_frames)], "inference_ms": [40.0] * n_frames})
    return ev.Walk("w1", frames, alerts, list(paused), (n_frames - 1) * gap_s, {})


BACKPACK = ("w1", "o1", "backpack", 2.0, 8.0, "yes", "")
CHAIR = ("w1", "o2", "chair", 10.0, 14.0, "no", "")


class ScoreWalkTests(unittest.TestCase):
    def test_in_path_recall_needs_the_lead_time(self):
        early = alert(1, "backpack", 5.0)  # 3 s before it was reached
        late = alert(2, "backpack", 7.5)  # only 0.5 s before
        for a, recalled in ((early, 1), (late, 0)):
            score = ev.score_walk(walk([a]), labels([BACKPACK]), lead_s=1.0, slack_s=1.0)
            self.assertEqual(score.recalled, recalled)
            self.assertEqual(score.in_path_total, 1)

    def test_missed_obstacle_is_named(self):
        score = ev.score_walk(walk([]), labels([BACKPACK]), 1.0, 1.0)
        self.assertEqual(score.missed, ["o1"])
        self.assertEqual(score.recalled, 0)

    def test_mean_lead_time_and_repeats(self):
        alerts = [alert(1, "backpack", 5.0), alert(2, "backpack", 6.5), alert(3, "backpack", 7.0)]
        score = ev.score_walk(walk(alerts), labels([BACKPACK]), 1.0, 1.0)
        self.assertEqual(score.lead_s, [3.25])  # created_s is 0.25 s before the time passed to alert()
        self.assertEqual(score.repeats, {"o1": 2})

    def test_false_alerts_are_spoken_alerts_that_match_no_in_path_obstacle(self):
        alerts = [
            alert(1, "backpack", 5.0),  # matches
            alert(2, "chair", 12.0),  # real object, but labeled out of the path
            alert(3, "person", 3.0),  # nothing labeled
            alert(4, "backpack", 6.0, outcomes=("dropped-stale",)),  # never spoken
        ]
        score = ev.score_walk(walk(alerts, n_frames=601), labels([BACKPACK, CHAIR]), 1.0, 1.0)
        self.assertEqual(score.spoken, 3)
        self.assertEqual(score.false_alerts, 2)
        self.assertAlmostEqual(score.active_min, 1.0)

    def test_alert_time_prefers_speech_then_tone_then_creation(self):
        a = alert(1, "backpack", 5.0, tone_ms=150, speech_ms=350)
        self.assertAlmostEqual(a.time_s, a.frame_s + 0.35)
        a.speech_s = None
        self.assertAlmostEqual(a.time_s, a.frame_s + 0.15)
        a.tone_s = None
        self.assertEqual(a.time_s, a.created_s)

    def test_overlapping_obstacles_of_one_name_take_the_nearest_reach_time(self):
        rows = [("w1", "near", "chair", 0.0, 6.0, "yes", ""), ("w1", "far", "chair", 0.0, 12.0, "yes", "")]
        assigned = ev.assign_alerts([alert(1, "chair", 5.0), alert(2, "chair", 11.0)], labels(rows), 1.0)
        self.assertEqual([a.id for a in assigned["near"]], ["a1"])
        self.assertEqual([a.id for a in assigned["far"]], ["a2"])

    def test_latency_percentiles_split_urgent_tones(self):
        alerts = [alert(1, "backpack", 5.0, "urgent", tone_ms=200, speech_ms=400), alert(2, "backpack", 6.0, tone_ms=500, speech_ms=700)]
        score = ev.score_walk(walk(alerts), labels([BACKPACK]), 1.0, 1.0)
        self.assertEqual([round(x) for x in score.to_tone_urgent_ms], [200])
        self.assertEqual([round(x) for x in score.to_tone_ms], [200, 500])
        self.assertEqual([round(x) for x in score.to_speech_ms], [400, 700])

    def test_unlabeled_walk_is_still_timed(self):
        score = ev.score_walk(walk([alert(1, "backpack", 5.0, speech_ms=300)]), None, 1.0, 1.0)
        self.assertFalse(score.labeled)
        self.assertIsNone(score.false_alerts)
        self.assertEqual(len(score.to_speech_ms), 1)


class FrameRateTests(unittest.TestCase):
    def test_windows_count_frames_and_skip_pauses(self):
        w = walk([], n_frames=300, gap_s=0.1, paused=[(10.0, 12.0)])
        fps = ev.fps_windows(w)
        self.assertTrue((fps["fps"] == 10.0).all())
        self.assertNotIn(10.0, fps["start_s"].tolist())  # the window that touches the pause
        self.assertNotIn(5.0 + 5.0, fps["start_s"].tolist())

    def test_a_slow_stretch_shows_in_the_trend(self):
        times = [i * 0.1 for i in range(100)] + [10 + i * 0.25 for i in range(40)] + [20 + i * 0.5 for i in range(20)]
        w = ev.Walk("w", pd.DataFrame({"capture_s": times, "inference_ms": 40.0}), [], [], 30.0, {})
        trend = ev.fps_trend(ev.fps_windows(w))
        first, last = (float(x) for x in trend.split(" -> "))
        self.assertGreater(first, last)


class TargetTests(unittest.TestCase):
    def test_pass_fail_and_missing(self):
        self.assertEqual(ev.check("NFR-1", 9.0), "PASS")
        self.assertEqual(ev.check("NFR-1", 7.9), "FAIL")
        self.assertEqual(ev.check("NFR-2", 120.0), "PASS")
        self.assertEqual(ev.check("NFR-4", 601.0), "FAIL")
        self.assertEqual(ev.check("NFR-5", 0.9), "PASS")
        self.assertEqual(ev.check("NFR-6", 1.5), "FAIL")
        self.assertEqual(ev.check("NFR-3", None), "NO DATA")


class LabelTests(unittest.TestCase):
    def test_bad_in_path_value_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "labels.csv"
            path.write_text("walk_id,obstacle_id,spoken_name,t_visible_s,t_reached_s,in_path,notes\nw,o,chair,1,2,maybe,\n")
            with self.assertRaisesRegex(ValueError, "yes or no"):
                ev.load_labels(path)

    def test_missing_column_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "labels.csv"
            path.write_text("walk_id,obstacle_id\nw,o\n")
            with self.assertRaisesRegex(ValueError, "missing columns"):
                ev.load_labels(path)

    def test_template_has_the_documented_columns(self):
        header = (Path(__file__).resolve().parents[2] / "field-tests" / "labels-template.csv").read_text().splitlines()[0]
        self.assertEqual(header.split(","), ev.LABEL_COLUMNS)


class FixtureReportTests(unittest.TestCase):
    def test_report_and_charts_are_written_from_the_fixture(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            code = ev.main(["fixture", "--out", str(out)])
            self.assertEqual(code, 0)
            report = (out / "report.md").read_text()
            for needle in ("## SRS targets", "NFR-5", "walk-fixture", "In-path recall", "## Per walk"):
                self.assertIn(needle, report)
            self.assertIn("| NFR-5 | In-path obstacle recall | at least 0.9 | 1.00 | PASS |", report)
            for name in ("fps_over_time.png", "latency.png", "timeline_walk-fixture.png"):
                self.assertGreater((out / name).stat().st_size, 1000)

    def test_missing_logs_is_an_error_not_a_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(ev.main(["nothing", "--logs", tmp, "--out", tmp]), 1)


if __name__ == "__main__":
    unittest.main()
