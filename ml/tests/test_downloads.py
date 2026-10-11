import itertools
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ml.downloads import download, plan_pieces, total_size

DATA = bytes(range(256)) * 20_000  # about 5 MB with no repeating block boundary


def make_handler(data: bytes, honor_ranges: bool = True, fail_first: int = 0):
    state = {"failures_left": fail_first}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # keep test output quiet
            pass

        def do_GET(self):
            header = self.headers.get("Range")
            if (
                state["failures_left"] > 0
                and header
                and not header.startswith("bytes=0-0")
            ):
                state["failures_left"] -= 1
                self.send_response(500)
                self.end_headers()
                return
            if not honor_ranges or not header:
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            start, end = header.removeprefix("bytes=").split("-")
            start, end = int(start), int(end) if end else len(data) - 1
            body = data[start : end + 1]
            self.send_response(206)
            self.send_header(
                "Content-Range", f"bytes {start}-{start + len(body) - 1}/{len(data)}"
            )
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


class Server:
    def __init__(self, handler):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/file.bin"

    def __enter__(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


class PlanPieces(unittest.TestCase):
    def test_pieces_cover_the_file_exactly_with_no_overlap(self):
        for size, pieces in [(100, 8), (7, 8), (1, 4), (1000, 3), (7_972_407_510, 8)]:
            ranges = plan_pieces(size, pieces)
            self.assertEqual(ranges[0][0], 0)
            self.assertEqual(ranges[-1][1], size - 1)
            for (_, end), (start, _) in itertools.pairwise(ranges):
                self.assertEqual(start, end + 1)
            self.assertEqual(sum(end - start + 1 for start, end in ranges), size)

    def test_never_more_pieces_than_bytes_and_never_empty_ones(self):
        self.assertEqual(len(plan_pieces(3, 8)), 3)
        self.assertEqual(plan_pieces(0, 8), [])

    def test_a_single_piece_is_the_whole_file(self):
        self.assertEqual(plan_pieces(50, 1), [(0, 49)])


class Download(unittest.TestCase):
    def test_total_size_comes_from_the_content_range(self):
        with Server(make_handler(DATA)) as server:
            self.assertEqual(total_size(server.url), len(DATA))

    def test_a_server_without_range_support_is_refused_clearly(self):
        with (
            Server(make_handler(DATA, honor_ranges=False)) as server,
            self.assertRaises(RuntimeError) as caught,
        ):
            total_size(server.url)
        self.assertIn("range", str(caught.exception))

    def test_downloads_the_exact_bytes_in_parallel_pieces(self):
        with tempfile.TemporaryDirectory() as tmp, Server(make_handler(DATA)) as server:
            dest = Path(tmp) / "sub" / "file.bin"
            download(server.url, dest, pieces=6, log=lambda _: None)
            self.assertEqual(dest.read_bytes(), DATA)
            self.assertFalse(dest.with_name("file.bin.progress.json").exists())

    def test_a_piece_that_fails_is_retried(self):
        with (
            tempfile.TemporaryDirectory() as tmp,
            Server(make_handler(DATA, fail_first=3)) as server,
        ):
            dest = Path(tmp) / "file.bin"
            download(server.url, dest, pieces=4, retries=6, log=lambda _: None)
            self.assertEqual(dest.read_bytes(), DATA)

    def test_giving_up_reports_which_piece_failed_and_keeps_progress_for_a_resume(self):
        with (
            tempfile.TemporaryDirectory() as tmp,
            Server(make_handler(DATA, fail_first=10_000)) as server,
        ):
            dest = Path(tmp) / "file.bin"
            with self.assertRaises(RuntimeError) as caught:
                download(server.url, dest, pieces=2, retries=0, log=lambda _: None)
            self.assertIn("run it again to resume", str(caught.exception))
            self.assertTrue(dest.with_name("file.bin.progress.json").exists())

    def test_resumes_from_saved_progress_without_fetching_what_it_already_has(self):
        with tempfile.TemporaryDirectory() as tmp, Server(make_handler(DATA)) as server:
            dest = Path(tmp) / "file.bin"
            # A previous run finished the first half of every piece.
            ranges = plan_pieces(len(DATA), 4)
            damaged = bytearray(len(DATA))  # everything not yet downloaded is zeros
            done = []
            for start, end in ranges:
                half = (end - start + 1) // 2
                damaged[start : start + half] = DATA[start : start + half]
                done.append(half)
            dest.write_bytes(bytes(damaged))
            dest.with_name("file.bin.progress.json").write_text(
                json.dumps({"size": len(DATA), "done": done})
            )
            logs: list[str] = []
            download(server.url, dest, pieces=4, log=logs.append)
            self.assertEqual(dest.read_bytes(), DATA)
            self.assertTrue(any("resuming" in line for line in logs))

    def test_an_already_complete_download_is_left_alone(self):
        with tempfile.TemporaryDirectory() as tmp, Server(make_handler(DATA)) as server:
            dest = Path(tmp) / "file.bin"
            download(server.url, dest, pieces=3, log=lambda _: None)
            before = dest.stat().st_mtime_ns
            logs: list[str] = []
            download(server.url, dest, pieces=3, log=logs.append)
            self.assertEqual(dest.read_bytes(), DATA)
            self.assertEqual(dest.stat().st_mtime_ns, before)  # not rewritten
            self.assertTrue(any("already downloaded" in line for line in logs))

    def test_a_crash_right_after_the_start_is_not_mistaken_for_a_finished_download(
        self,
    ):
        with (
            tempfile.TemporaryDirectory() as tmp,
            Server(make_handler(DATA, fail_first=10_000)) as server,
        ):
            dest = Path(tmp) / "file.bin"
            with self.assertRaises(RuntimeError):
                download(server.url, dest, pieces=2, retries=0, log=lambda _: None)
        # The full-size placeholder file is there, but so is the progress marker, so it counts as unfinished.
        with tempfile.TemporaryDirectory() as tmp, Server(make_handler(DATA)) as server:
            dest = Path(tmp) / "file.bin"
            dest.write_bytes(bytes(len(DATA)))
            dest.with_name("file.bin.progress.json").write_text(
                json.dumps({"size": len(DATA), "done": [0, 0]})
            )
            download(server.url, dest, pieces=2, log=lambda _: None)
            self.assertEqual(dest.read_bytes(), DATA)


if __name__ == "__main__":
    unittest.main()
