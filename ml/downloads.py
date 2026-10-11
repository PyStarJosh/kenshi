"""Download one large file in parallel pieces over HTTP range requests, and resume after an interruption.

A single connection to a busy server can be slow; several pieces at once are often several times faster.
Progress is saved next to the file (<name>.progress.json), so running the same download again continues where it
stopped instead of starting over.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path

CHUNK_BYTES = 1 << 20
TIMEOUT_S = 60


def plan_pieces(size: int, pieces: int) -> list[tuple[int, int]]:
    """Split `size` bytes into at most `pieces` inclusive (start, end) byte ranges that cover it exactly."""
    if size <= 0:
        return []
    pieces = max(1, min(pieces, size))
    step = -(-size // pieces)  # ceiling division
    ranges = []
    for start in range(0, size, step):
        ranges.append((start, min(size - 1, start + step - 1)))
    return ranges


def total_size(url: str) -> int:
    """The file's size, from a one-byte range request. Raises if the server does not support ranges."""
    request = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        if response.status != 206:
            raise RuntimeError(
                f"{url} does not support range requests (status {response.status})"
            )
        content_range = response.headers.get("Content-Range", "")
    if "/" not in content_range:
        raise RuntimeError(
            f"{url} did not report the file size (Content-Range: {content_range!r})"
        )
    return int(content_range.rsplit("/", 1)[1])


def download(
    url: str,
    dest: Path,
    pieces: int = 8,
    retries: int = 8,
    log: Callable[[str], None] = print,
    report_every_s: float = 10.0,
) -> None:
    """Download `url` to `dest` in parallel pieces. Safe to run again after a failure: it resumes."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    progress_file = dest.with_name(dest.name + ".progress.json")
    size = total_size(url)
    ranges = plan_pieces(size, pieces)
    done = [0] * len(ranges)

    if dest.exists() and dest.stat().st_size == size and not progress_file.exists():
        log(f"already downloaded: {dest}")
        return
    resumable = dest.exists() and dest.stat().st_size == size and progress_file.exists()
    if resumable:
        saved = json.loads(progress_file.read_text(encoding="utf-8"))
        if (
            saved.get("size") == size
            and saved.get("done")
            and len(saved["done"]) == len(ranges)
        ):
            done = list(saved["done"])
            log(
                f"resuming: {sum(done) / 1e9:.2f} of {size / 1e9:.2f} GB already downloaded"
            )
    if sum(done) == 0:
        with open(dest, "wb") as f:
            f.truncate(size)

    lock = threading.Lock()
    failures: list[str] = []

    def save_progress() -> None:
        with lock:
            snapshot = list(done)
        progress_file.write_text(
            json.dumps({"size": size, "done": snapshot}), encoding="utf-8"
        )

    def worker(index: int) -> None:
        start, end = ranges[index]
        attempts = 0
        while start + done[index] <= end and not failures:
            offset = start + done[index]
            try:
                request = urllib.request.Request(
                    url, headers={"Range": f"bytes={offset}-{end}"}
                )
                with (
                    urllib.request.urlopen(request, timeout=TIMEOUT_S) as response,
                    open(dest, "r+b") as out,
                ):
                    if response.status != 206:
                        raise RuntimeError(
                            f"the server ignored the range request (status {response.status})"
                        )
                    out.seek(offset)
                    received = 0
                    while True:
                        chunk = response.read(CHUNK_BYTES)
                        if not chunk:
                            break
                        # Never write past this piece: the next piece's bytes belong to another worker.
                        room = end + 1 - (start + done[index])
                        chunk = chunk[:room]
                        out.write(chunk)
                        out.flush()
                        received += len(chunk)
                        with lock:
                            done[index] += len(chunk)
                        if start + done[index] > end:
                            break
                    if received == 0:
                        raise RuntimeError("the server sent no data")
            except Exception as error:  # noqa: BLE001 - any network problem is retried, then reported
                attempts += 1
                if attempts > retries:
                    failures.append(f"piece {index}: {error}")
                    return
                time.sleep(min(30.0, 2.0**attempts))

    save_progress()  # from now on a full-size file with no progress marker means "complete"
    stop_reporting = threading.Event()

    def reporter() -> None:
        started = time.time()
        base = sum(done)
        while not stop_reporting.wait(report_every_s):
            now = sum(done)
            speed = (now - base) / max(1e-9, time.time() - started) / 1e6
            log(
                f"{now / 1e9:.2f} of {size / 1e9:.2f} GB ({now / size:.0%}), {speed:.1f} MB/s"
            )
            save_progress()

    threads = [
        threading.Thread(target=worker, args=(i,), daemon=True)
        for i in range(len(ranges))
    ]
    watcher = threading.Thread(target=reporter, daemon=True)
    watcher.start()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    stop_reporting.set()
    watcher.join()
    save_progress()

    if failures:
        raise RuntimeError(
            "download incomplete, run it again to resume: " + "; ".join(failures)
        )
    if sum(done) != size or os.path.getsize(dest) != size:
        raise RuntimeError(
            f"download incomplete: {sum(done)} of {size} bytes; run it again to resume"
        )
    progress_file.unlink(missing_ok=True)
    log(f"downloaded {size / 1e9:.2f} GB to {dest}")
