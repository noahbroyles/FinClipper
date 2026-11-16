"""Background clip jobs.

Jobs live in memory, so the app must run as a single process (gunicorn with
one worker and several threads). A fixed pool of worker threads takes jobs
from a queue, which caps how many ffmpeg processes run at the same time.
"""

import os
import time
import uuid
import queue
import logging
import threading
import subprocess
from pathlib import Path
from collections import deque
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

# Job states. "queued" and "running" are active, the rest are final.
QUEUED = "queued"
RUNNING = "running"
DONE = "done"
FAILED = "failed"
CANCELLED = "cancelled"
ACTIVE_STATES = {QUEUED, RUNNING}


class JobLimitError(Exception):
    """Raised when a user already has too many active jobs."""


@dataclass
class Job:
    """One clip request and its progress."""

    user_id: str
    item_id: str
    title: str
    start: float
    end: float
    mode: str
    description: str
    filename: str
    extension: str
    command: list
    redacted_command: list
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    status: str = QUEUED
    progress: float = 0.0
    error: str = ""
    size: int = 0
    created: float = field(default_factory=time.time)
    finished: float = 0.0
    cancel_requested: bool = False
    process: object = None

    @property
    def duration(self):
        return self.end - self.start

    def to_dict(self):
        """Public view of the job for the JSON API (no paths or commands)."""
        return {
            "id": self.id,
            "item_id": self.item_id,
            "title": self.title,
            "start": self.start,
            "end": self.end,
            "duration": self.duration,
            "mode": self.mode,
            "description": self.description,
            "filename": self.filename,
            "status": self.status,
            "progress": round(self.progress, 4),
            "error": self.error,
            "size": self.size,
            "created": self.created,
            "finished": self.finished or None,
        }


class JobManager:
    """Queues clip jobs and runs ffmpeg for them in worker threads."""

    def __init__(self, clips_dir, max_concurrent, max_per_user, retention_hours):
        self.clips_dir = Path(clips_dir)
        self.max_concurrent = max_concurrent
        self.max_per_user = max_per_user
        self.retention_seconds = retention_hours * 3600
        self._jobs = {}
        self._lock = threading.Lock()
        self._queue = queue.Queue()
        self._started = False

    # ----- lifecycle -------------------------------------------------------

    def start(self):
        """Clean leftovers from a previous run and start the worker threads."""
        if self._started:
            return
        self._started = True
        self._purge_orphans()
        for number in range(self.max_concurrent):
            threading.Thread(target=self._worker, name=f"clip-worker-{number}", daemon=True).start()
        threading.Thread(target=self._janitor, name="clip-janitor", daemon=True).start()

    def _purge_orphans(self):
        """Delete clip files left over from before a restart.

        Jobs are kept in memory only, so files from a previous process can
        never be downloaded again and would just waste disk space.
        """
        for path in self.clips_dir.iterdir():
            if path.is_file():
                try:
                    path.unlink()
                except OSError:
                    log.warning("Could not remove leftover file %s", path)

    # ----- public API ------------------------------------------------------

    def submit(self, job):
        """Queue a job, enforcing the per-user active job limit."""
        with self._lock:
            active = sum(
                1
                for other in self._jobs.values()
                if other.user_id == job.user_id and other.status in ACTIVE_STATES
            )
            if active >= self.max_per_user:
                raise JobLimitError(
                    f"You already have {active} clips in progress. Wait for one to finish."
                )
            self._jobs[job.id] = job
        log.info("Queued job %s: %s", job.id, " ".join(job.redacted_command))
        self._queue.put(job.id)
        return job

    def get(self, job_id, user_id):
        """Return a job owned by user_id, or None."""
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None or job.user_id != user_id:
            return None
        return job

    def list(self, user_id):
        """All jobs of a user, newest first."""
        with self._lock:
            jobs = [job for job in self._jobs.values() if job.user_id == user_id]
        return sorted(jobs, key=lambda job: job.created, reverse=True)

    def cancel(self, job_id, user_id):
        """Cancel a queued or running job. Returns the job or None."""
        job = self.get(job_id, user_id)
        if job is None:
            return None
        with self._lock:
            if job.status == QUEUED:
                # The worker will see the final state and skip it.
                job.status = CANCELLED
                job.finished = time.time()
            elif job.status == RUNNING:
                job.cancel_requested = True
                if job.process is not None:
                    job.process.terminate()
        return job

    def delete(self, job_id, user_id):
        """Cancel (if needed) and forget a job, removing its file."""
        job = self.cancel(job_id, user_id)
        if job is None:
            return False
        with self._lock:
            self._jobs.pop(job.id, None)
        self._remove_files(job)
        return True

    def output_path(self, job):
        """Path of the finished clip file."""
        return self.clips_dir / f"{job.id}.{job.extension}"

    def temp_path(self, job):
        """Path ffmpeg writes to before the clip is complete."""
        return self.clips_dir / f"{job.id}.part"

    # ----- internals -------------------------------------------------------

    def _remove_files(self, job):
        for path in (self.output_path(job), self.temp_path(job)):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                log.warning("Could not remove %s", path)

    def _worker(self):
        while True:
            job_id = self._queue.get()
            try:
                with self._lock:
                    job = self._jobs.get(job_id)
                    if job is None or job.status != QUEUED:
                        # Deleted or cancelled while waiting in the queue.
                        continue
                    job.status = RUNNING
                self._run(job)
            except Exception:
                log.exception("Unexpected error in clip worker")
            finally:
                self._queue.task_done()

    def _run(self, job):
        """Run ffmpeg for one job and record the outcome."""
        stderr_tail = deque(maxlen=15)
        try:
            process = subprocess.Popen(
                job.command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                bufsize=1,
            )
        except OSError as exc:
            self._finish(job, FAILED, f"Could not start ffmpeg: {exc}")
            return

        with self._lock:
            job.process = process
            cancel_now = job.cancel_requested
        if cancel_now:
            # Cancel arrived between RUNNING and Popen; honour it now.
            process.terminate()

        # Drain stderr in its own thread so a chatty ffmpeg can never block
        # on a full pipe while we are reading stdout.
        def read_stderr():
            for line in process.stderr:
                line = line.strip()
                if line:
                    stderr_tail.append(line)

        stderr_thread = threading.Thread(target=read_stderr, daemon=True)
        stderr_thread.start()

        # -progress writes key=value lines; out_time_us is the output position.
        for line in process.stdout:
            key, _, value = line.strip().partition("=")
            if key == "out_time_us" and value.isdigit() and job.duration > 0:
                job.progress = min(1.0, int(value) / 1_000_000 / job.duration)

        return_code = process.wait()
        stderr_thread.join(timeout=5)

        with self._lock:
            job.process = None

        temp = self.temp_path(job)
        if job.cancel_requested:
            temp.unlink(missing_ok=True)
            self._finish(job, CANCELLED, "")
        elif return_code != 0:
            temp.unlink(missing_ok=True)
            message = stderr_tail[-1] if stderr_tail else f"ffmpeg exited with code {return_code}"
            log.error("Job %s failed (code %s): %s", job.id, return_code, " | ".join(stderr_tail))
            self._finish(job, FAILED, message)
        elif not temp.is_file() or temp.stat().st_size == 0:
            temp.unlink(missing_ok=True)
            self._finish(job, FAILED, "ffmpeg produced an empty file")
        else:
            final = self.output_path(job)
            os.replace(temp, final)
            job.size = final.stat().st_size
            job.progress = 1.0
            self._finish(job, DONE, "")
            log.info("Job %s finished (%d bytes)", job.id, job.size)

    def _finish(self, job, status, error):
        with self._lock:
            job.status = status
            job.error = error
            job.finished = time.time()

    def _sweep_untracked(self):
        """Remove files that no job refers to any more.

        This catches the rare case where a job is deleted at the exact moment
        ffmpeg finishes and the file is renamed after the delete ran. Only
        files older than an hour are touched, so a job that is just starting
        is never affected.
        """
        cutoff = time.time() - 3600
        with self._lock:
            known = set(self._jobs)
        for path in self.clips_dir.iterdir():
            # File names are "<job id>.<ext>" or "<job id>.part".
            if path.is_file() and path.name.split(".", 1)[0] not in known:
                try:
                    if path.stat().st_mtime < cutoff:
                        path.unlink()
                        log.info("Removed untracked file %s", path.name)
                except OSError:
                    log.warning("Could not remove untracked file %s", path)

    def _janitor(self):
        """Every few minutes, forget finished jobs older than the retention time."""
        while True:
            time.sleep(300)
            try:
                cutoff = time.time() - self.retention_seconds
                with self._lock:
                    expired = [
                        job
                        for job in self._jobs.values()
                        if job.status not in ACTIVE_STATES and job.finished and job.finished < cutoff
                    ]
                    for job in expired:
                        self._jobs.pop(job.id, None)
                for job in expired:
                    self._remove_files(job)
                    log.info("Expired job %s", job.id)
                self._sweep_untracked()
            except Exception:
                log.exception("Janitor failed")
