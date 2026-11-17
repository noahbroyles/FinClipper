"""Background clip jobs.

Clip records are stored in SQLite (see store.py) and survive restarts. A
fixed pool of worker threads takes jobs from an in-memory queue, which caps
how many ffmpeg processes run at the same time. Because that queue and the
running processes live in this process, the app must still run as a single
process (gunicorn with one worker and several threads).

Jobs that are queued or running are also kept in memory with their runtime
state (ffmpeg process, progress, the prepare step). Every change of status
is written to the database at the same time, under the same lock, so the
in-memory copy and the database never disagree about a job.
"""

import os
import json
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
ACTIVE_STATES = (QUEUED, RUNNING)

# Clip files are "<id>.<extension>"; these suffixes are only used while a
# clip is being made, so any left at startup belong to interrupted jobs.
WORK_SUFFIXES = (".part", ".ass")


class JobLimitError(Exception):
    """Raised when a user already has too many active jobs."""


@dataclass
class Job:
    """One clip: its stored record plus, while it is being made, its progress."""

    user_id: str
    item_id: str
    title: str
    start: float
    end: float
    mode: str
    description: str
    filename: str
    extension: str
    # The ffmpeg command, and a copy with the Jellyfin token hidden for logs.
    # Only known for jobs created by this process; never stored, because it
    # can contain the user's token.
    command: list = field(default_factory=list)
    redacted_command: list = field(default_factory=list)
    # Optional name chosen by the user. "" means unnamed (the title is shown).
    name: str = ""
    # Jellyfin name of the user who made the clip, shown on public clips.
    owner_name: str = ""
    # Optional function run by the worker before ffmpeg starts (for example
    # to download subtitles). If it raises, the job fails with its message.
    prepare: object = None
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    status: str = QUEUED
    # What a running job is doing: "preparing" (running prepare) or
    # "encoding" (running ffmpeg). Empty before the job starts.
    phase: str = ""
    progress: float = 0.0
    error: str = ""
    size: int = 0
    created: float = field(default_factory=time.time)
    finished: float = 0.0
    cancel_requested: bool = False
    process: object = None
    # Whether other signed in users can see the clip under "Public clips",
    # when it was shared (sorts that list, newest first) and when it was
    # last made private (private clips expire counting from then).
    public: bool = False
    shared_at: float = 0.0
    unshared_at: float = 0.0
    # The time ranges the clip is spliced from, as (start, end) pairs in
    # the order they are played. A plain clip has one. For a multi-part
    # clip, start and end are the stretch of the video the parts are taken
    # from (the earliest start and the latest end). Left empty, it becomes
    # the single range start to end.
    parts: list = field(default_factory=list)
    # The choices the clip was made with, as the "create clip" request
    # gave them once checked (see api.create_clip), for "Re-clip". Empty
    # for clips made before these were kept.
    settings: dict = field(default_factory=dict)

    def __post_init__(self):
        if not self.parts:
            self.parts = [(self.start, self.end)]

    @property
    def duration(self):
        """Length of the finished clip in seconds."""
        return sum(end - start for start, end in self.parts)

    def parts_dicts(self):
        return [{"start": start, "end": end} for start, end in self.parts]

    def to_record(self):
        """The columns stored in the database for this job."""
        return {
            "id": self.id,
            "user_id": self.user_id,
            "owner_name": self.owner_name,
            "item_id": self.item_id,
            "title": self.title,
            "name": self.name,
            "start_time": self.start,
            "end_time": self.end,
            "mode": self.mode,
            "description": self.description,
            "filename": self.filename,
            "extension": self.extension,
            "status": self.status,
            "error": self.error,
            "size": self.size,
            "created": self.created,
            "finished": self.finished,
            "public": int(self.public),
            "shared_at": self.shared_at,
            "unshared_at": self.unshared_at,
            "parts": json.dumps([list(part) for part in self.parts]),
            "settings": json.dumps(self.settings) if self.settings else "",
        }

    @classmethod
    def from_record(cls, row):
        """Rebuild a job from a database row (without any runtime state)."""
        return cls(
            id=row["id"],
            user_id=row["user_id"],
            owner_name=row["owner_name"],
            item_id=row["item_id"],
            title=row["title"],
            name=row["name"],
            start=row["start_time"],
            end=row["end_time"],
            mode=row["mode"],
            description=row["description"],
            filename=row["filename"],
            extension=row["extension"],
            status=row["status"],
            error=row["error"],
            size=row["size"],
            created=row["created"],
            finished=row["finished"],
            public=bool(row["public"]),
            shared_at=row["shared_at"],
            unshared_at=row["unshared_at"],
            # '' for clips stored before multi-part clips existed.
            parts=[tuple(part) for part in json.loads(row["parts"] or "[]")],
            settings=json.loads(row["settings"] or "{}"),
            # Only finished jobs are read back from the database.
            progress=1.0 if row["status"] == DONE else 0.0,
        )

    def to_public_dict(self, viewer_id):
        """View of a public clip for any signed in user.

        Leaves out what only the owner needs (status, errors, progress) and
        says whether the viewer is the owner, so the page can offer them
        the "Make private" button.
        """
        return {
            "id": self.id,
            "item_id": self.item_id,
            "title": self.title,
            "name": self.name,
            "owner_name": self.owner_name,
            "mine": self.user_id == viewer_id,
            "start": self.start,
            "end": self.end,
            "parts": self.parts_dicts(),
            "duration": self.duration,
            "description": self.description,
            "filename": self.filename,
            # Browsers can play MP4 but usually not MKV.
            "playable": self.extension == "mp4",
            "size": self.size,
            "shared_at": self.shared_at,
        }

    def to_dict(self):
        """Owner's view of the job for the JSON API (no paths or commands)."""
        return {
            "id": self.id,
            "item_id": self.item_id,
            "title": self.title,
            "name": self.name,
            "start": self.start,
            "end": self.end,
            "parts": self.parts_dicts(),
            "duration": self.duration,
            "mode": self.mode,
            "description": self.description,
            "filename": self.filename,
            # Browsers can play MP4 but usually not MKV.
            "playable": self.extension == "mp4",
            # null for clips made before the settings were kept.
            "settings": self.settings or None,
            "status": self.status,
            "public": self.public,
            "phase": self.phase,
            "progress": round(self.progress, 4),
            "error": self.error,
            "size": self.size,
            "created": self.created,
            "finished": self.finished or None,
        }


class JobManager:
    """Queues clip jobs, runs ffmpeg for them and keeps their records."""

    def __init__(self, clips_dir, store, max_concurrent, max_per_user, retention_hours, public_retention_hours=0):
        self.clips_dir = Path(clips_dir)
        self.store = store
        self.max_concurrent = max_concurrent
        self.max_per_user = max_per_user
        self.retention_seconds = retention_hours * 3600
        # 0 means public clips are kept until they are made private.
        self.public_retention_seconds = public_retention_hours * 3600
        # Queued and running jobs, with their runtime state.
        self._active = {}
        self._lock = threading.Lock()
        self._queue = queue.Queue()
        self._started = False

    # ----- lifecycle -------------------------------------------------------

    def start(self):
        """Tidy up after the previous run and start the worker threads."""
        if self._started:
            return
        self._started = True
        self.recover()
        for number in range(self.max_concurrent):
            threading.Thread(target=self._worker, name=f"clip-worker-{number}", daemon=True).start()
        threading.Thread(target=self._janitor, name="clip-janitor", daemon=True).start()

    def recover(self):
        """Make the database and the clips directory agree after a restart.

        Jobs that were queued or running are marked as interrupted, work
        files they left (.part, .ass) and files without a record are
        deleted, and records of finished clips whose file is missing are
        dropped, since they could never be downloaded.
        """
        interrupted = self.store.mark_interrupted(ACTIVE_STATES, FAILED, time.time())
        if interrupted:
            log.info("Marked %d clip(s) interrupted by the restart as failed", interrupted)
        known = self.store.ids()
        for path in self.clips_dir.iterdir():
            if not path.is_file():
                continue
            if path.suffix in WORK_SUFFIXES or path.name.split(".", 1)[0] not in known:
                try:
                    path.unlink()
                    log.info("Removed leftover file %s", path.name)
                except OSError:
                    log.warning("Could not remove leftover file %s", path)
        for row in self.store.list_by_status(DONE):
            job = Job.from_record(row)
            if not self.output_path(job).is_file():
                self.store.delete(job.id)
                log.warning("Dropped clip %s because its file is missing", job.id)

    # ----- public API ------------------------------------------------------

    def submit(self, job):
        """Store and queue a job, enforcing the per-user active job limit."""
        with self._lock:
            active = sum(1 for other in self._active.values() if other.user_id == job.user_id)
            if active >= self.max_per_user:
                raise JobLimitError(
                    f"You already have {active} clips in progress. Wait for one to finish."
                )
            self.store.insert(job.to_record())
            self._active[job.id] = job
        log.info("Queued job %s: %s", job.id, " ".join(job.redacted_command))
        self._queue.put(job.id)
        return job

    def _find_locked(self, job_id):
        """The live job if it is active, else a copy from the database, or None.

        The caller must hold self._lock, so a job cannot finish (and move
        from memory to the database only) half way through the lookup.
        """
        job = self._active.get(job_id)
        if job is not None:
            return job
        row = self.store.get(job_id)
        return Job.from_record(row) if row else None

    def get(self, job_id, user_id):
        """Return a job owned by user_id, or None."""
        with self._lock:
            job = self._find_locked(job_id)
        if job is None or job.user_id != user_id:
            return None
        return job

    def list(self, user_id):
        """All jobs of a user, newest first, with live progress for active ones."""
        with self._lock:
            rows = self.store.list_for_user(user_id)
            active = dict(self._active)
        return [active.get(row["id"]) or Job.from_record(row) for row in rows]

    def cancel(self, job_id, user_id):
        """Cancel a queued or running job. Returns the job or None.

        Finished jobs are returned unchanged.
        """
        with self._lock:
            job = self._active.get(job_id)
            if job is not None and job.user_id == user_id:
                if job.status == QUEUED:
                    # The worker will find it gone from the active jobs and skip it.
                    self._finish_locked(job, CANCELLED, "")
                elif job.status == RUNNING:
                    job.cancel_requested = True
                    if job.process is not None:
                        job.process.terminate()
                return job
        return self.get(job_id, user_id)

    def rename(self, job_id, user_id, name, filename):
        """Set a job's name and download file name. Returns the job or None.

        The file on disk is named after the job id, so only the name shown
        in the app and the name offered when downloading change.
        """
        with self._lock:
            job = self._find_locked(job_id)
            if job is None or job.user_id != user_id:
                return None
            self.store.update(job_id, name=name, filename=filename)
            # Also updates the live copy of an active job.
            job.name = name
            job.filename = filename
        return job

    def set_public(self, job_id, public, user_id=None):
        """Share or stop sharing a clip. Returns the job or None.

        Only the owner may change a clip, unless user_id is None, which
        skips the owner check (administrators taking a clip down). Raises
        ValueError when sharing a clip that is not finished.
        """
        with self._lock:
            job = self._find_locked(job_id)
            if job is None or (user_id is not None and job.user_id != user_id):
                return None
            if public and job.status != DONE:
                raise ValueError("Only finished clips can be made public")
            if public != job.public:
                now = time.time()
                job.public = public
                if public:
                    job.shared_at = now
                else:
                    job.shared_at, job.unshared_at = 0.0, now
                self.store.update(job_id, public=int(public), shared_at=job.shared_at, unshared_at=job.unshared_at)
        return job

    def get_public(self, job_id):
        """Return a finished public job, or None."""
        row = self.store.get(job_id)
        if row is None or not row["public"] or row["status"] != DONE:
            return None
        return Job.from_record(row)

    def list_public(self, limit):
        """Finished public jobs, most recently shared first."""
        return [Job.from_record(row) for row in self.store.list_public(DONE, limit)]

    def delete(self, job_id, user_id):
        """Cancel (if needed) and forget a job, removing its file."""
        job = self.cancel(job_id, user_id)
        if job is None:
            return False
        with self._lock:
            # A running job stays with its worker until ffmpeg has stopped;
            # finishing it then updates a row that no longer exists, which
            # does nothing.
            self._active.pop(job.id, None)
            self.store.delete(job.id)
        self._remove_files(job)
        return True

    def output_path(self, job):
        """Path of the finished clip file."""
        return self.clips_dir / f"{job.id}.{job.extension}"

    def temp_path(self, job):
        """Path ffmpeg writes to before the clip is complete."""
        return self.clips_dir / f"{job.id}.part"

    def subtitle_path(self, job):
        """Path of the ASS file with the subtitles to burn in, if any."""
        return self.clips_dir / self.subtitle_name(job.id)

    @staticmethod
    def subtitle_name(job_id):
        """File name of a job's subtitle file inside the clips directory.

        ffmpeg runs in the clips directory and is given this bare name,
        which needs no escaping in the filter graph (it is hex plus .ass).
        """
        return f"{job_id}.ass"

    # ----- internals -------------------------------------------------------

    def _remove_files(self, job):
        for path in (self.output_path(job), self.temp_path(job), self.subtitle_path(job)):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                log.warning("Could not remove %s", path)

    def _worker(self):
        while True:
            job_id = self._queue.get()
            try:
                with self._lock:
                    job = self._active.get(job_id)
                    if job is None or job.status != QUEUED:
                        # Deleted or cancelled while waiting in the queue.
                        continue
                    job.status = RUNNING
                    self.store.update(job.id, status=RUNNING)
                self._run(job)
            except Exception:
                log.exception("Unexpected error in clip worker")
            finally:
                self._queue.task_done()

    def _run(self, job):
        """Prepare and run ffmpeg for one job, then record the outcome."""
        try:
            self._run_ffmpeg(job)
        finally:
            # The subtitle file is only needed while ffmpeg runs.
            try:
                self.subtitle_path(job).unlink(missing_ok=True)
            except OSError:
                log.warning("Could not remove %s", self.subtitle_path(job))
            if job.status in ACTIVE_STATES:
                # An unexpected error escaped before the job was finished.
                self._finish(job, FAILED, "Unexpected error while making the clip")

    def _run_ffmpeg(self, job):
        if job.prepare is not None:
            job.phase = "preparing"
            # Taken off the job so whatever it holds (such as the user's
            # Jellyfin client and token) is not kept in memory any longer.
            prepare, job.prepare = job.prepare, None
            try:
                prepare()
            except Exception as exc:
                log.warning("Job %s failed while preparing: %s", job.id, exc)
                self._finish(job, FAILED, str(exc) or exc.__class__.__name__)
                return
            if job.cancel_requested:
                # Cancelled while preparing; there is no process to stop.
                self._finish(job, CANCELLED, "")
                return
        job.phase = "encoding"

        stderr_tail = deque(maxlen=15)
        try:
            process = subprocess.Popen(
                job.command,
                # Lets the filter graph refer to the subtitle file by name.
                cwd=self.clips_dir,
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
        # Close the pipes now rather than leaving them to the garbage
        # collector. stderr is left alone in the unlikely case that its
        # reader thread is still running, since closing it would break it.
        process.stdout.close()
        if not stderr_thread.is_alive():
            process.stderr.close()

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
            self._finish_locked(job, status, error)

    def _finish_locked(self, job, status, error):
        """Record a final state; from now on the job lives only in the database."""
        job.status = status
        job.error = error
        job.finished = time.time()
        self.store.update(job.id, status=status, error=error, finished=job.finished, size=job.size)
        self._active.pop(job.id, None)

    def expire(self, now=None):
        """Delete clips whose time is up (see ClipStore.expired). Returns how many."""
        now = time.time() if now is None else now
        # Find and delete the records under one lock, so a clip that is made
        # public (or renamed) in between is not deleted from a stale list.
        with self._lock:
            rows = self.store.expired(ACTIVE_STATES, now, self.retention_seconds, self.public_retention_seconds)
            for row in rows:
                self.store.delete(row["id"])
        # The files are removed outside the lock, since that can be slow.
        for row in rows:
            job = Job.from_record(row)
            self._remove_files(job)
            log.info("Expired job %s", job.id)
        return len(rows)

    def _sweep_untracked(self):
        """Remove files that no job refers to any more.

        This catches the rare case where a job is deleted at the exact moment
        ffmpeg finishes and the file is renamed after the delete ran. Only
        files older than an hour are touched, so a job that is just starting
        is never affected.
        """
        cutoff = time.time() - 3600
        with self._lock:
            known = self.store.ids() | set(self._active)
        for path in self.clips_dir.iterdir():
            # File names are "<job id>.<ext>", "<job id>.part" or "<job id>.ass".
            if path.is_file() and path.name.split(".", 1)[0] not in known:
                try:
                    if path.stat().st_mtime < cutoff:
                        path.unlink()
                        log.info("Removed untracked file %s", path.name)
                except OSError:
                    log.warning("Could not remove untracked file %s", path)

    def _janitor(self):
        """Every few minutes, delete expired clips and stray files."""
        while True:
            time.sleep(300)
            try:
                self.expire()
                self._sweep_untracked()
            except Exception:
                log.exception("Janitor failed")
