"""Unit tests for finclipper.jobs and finclipper.store: clip records in
SQLite, restarts, expiry and sharing.

Run with: python -m unittest discover -s tests
"""

import time
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path
from finclipper.store import MIGRATIONS, ClipStore
from finclipper.jobs import CANCELLED, DONE, FAILED, QUEUED, RUNNING, Job, JobLimitError, JobManager

HAVE_FFMPEG = shutil.which("ffmpeg") is not None
HOUR = 3600


def make_job(user_id="u1", status=DONE, **extra):
    """A job with sensible defaults; any field can be overridden."""
    fields = dict(
        user_id=user_id, item_id="a" * 32, title="Film", start=0, end=5, mode="fast",
        description="copy", filename="Film.mp4", extension="mp4", status=status,
    )
    fields.update(extra)
    return Job(**fields)


class StoreTestCase(unittest.TestCase):
    """Gives each test a fresh data directory, database and job manager."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.clips = self.tmp / "clips"
        self.clips.mkdir()
        self.db_path = self.tmp / "finclipper.db"
        self.stores = []
        self.manager = self.new_manager()

    def tearDown(self):
        for store in self.stores:
            store.close()
        shutil.rmtree(self.tmp)

    def new_manager(self, retention_hours=1, public_retention_hours=0, max_per_user=3):
        """A manager on the same database, as after a restart. Not started,
        so no worker threads run unless a test starts it."""
        store = ClipStore(self.db_path)
        self.stores.append(store)
        return JobManager(
            self.clips, store, max_concurrent=1, max_per_user=max_per_user,
            retention_hours=retention_hours, public_retention_hours=public_retention_hours,
        )

    def add(self, job, with_file=True):
        """Store a job directly (as if it had been made earlier)."""
        self.manager.store.insert(job.to_record())
        if with_file and job.status == DONE:
            self.manager.output_path(job).write_bytes(b"video")
        return job


class StoreTests(StoreTestCase):
    def test_schema_version(self):
        self.assertEqual(self.manager.store.schema_version(), len(MIGRATIONS))

    def test_database_from_before_multi_part_clips_is_upgraded(self):
        path = self.tmp / "old.db"
        db = sqlite3.connect(path)
        db.executescript(MIGRATIONS[0] + "PRAGMA user_version = 1;")
        db.execute(
            "INSERT INTO clips (id, user_id, item_id, title, start_time, end_time, mode, description, filename,"
            " extension, status, created) VALUES ('old', 'u1', 'i1', 'Film', 10, 25, 'fast', 'copy', 'Film.mp4', 'mp4', 'done', 1)"
        )
        db.commit()
        db.close()
        store = ClipStore(path)
        self.stores.append(store)
        self.assertEqual(store.schema_version(), len(MIGRATIONS))
        job = Job.from_record(store.get("old"))
        # An old clip is the single range it always was.
        self.assertEqual((job.parts, job.duration), ([(10, 25)], 15))
        self.assertEqual(job.to_dict()["parts"], [{"start": 10, "end": 25}])
        # Its settings were never kept.
        self.assertIsNone(job.to_dict()["settings"])

    def test_parts_round_trip(self):
        job = make_job(start=50, end=20, parts=[(50, 62.5), (10, 20)])
        self.add(job)
        loaded = Job.from_record(self.manager.store.get(job.id))
        self.assertEqual(loaded.parts, [(50, 62.5), (10, 20)])
        # The length of the finished clip, not the span from start to end.
        self.assertEqual(loaded.duration, 22.5)
        self.assertEqual(loaded.to_dict()["parts"], [{"start": 50, "end": 62.5}, {"start": 10, "end": 20}])
        self.assertEqual(loaded.to_dict()["duration"], 22.5)
        self.assertEqual(loaded.to_public_dict("u2")["duration"], 22.5)

    def test_settings_round_trip(self):
        settings = {
            "source_id": "s1", "mode": "precise", "audio_index": 2, "subtitle_index": None, "subtitle_style": "boxed",
            "layout": "vertical", "fit": "crop", "max_height": 1280,
            "parts": [{"start": 50, "end": 62.5, "crop_x": 0.25, "crop_width": 0.6}],
        }
        job = self.add(make_job(start=50, end=62.5, settings=settings))
        loaded = Job.from_record(self.manager.store.get(job.id))
        self.assertEqual(loaded.settings, settings)
        self.assertEqual(loaded.to_dict()["settings"], settings)
        # Not part of the public list; "Re-clip" asks for them separately.
        self.assertNotIn("settings", loaded.to_public_dict("u2"))

    def test_owner_view_says_whether_the_browser_can_play_the_clip(self):
        self.assertTrue(make_job().to_dict()["playable"])
        self.assertFalse(make_job(extension="mkv", filename="Film.mkv").to_dict()["playable"])

    def test_plain_clip_is_one_part(self):
        job = make_job(start=3, end=8)
        self.assertEqual((job.parts, job.duration), ([(3, 8)], 5))

    def test_newer_database_is_refused(self):
        db = sqlite3.connect(self.tmp / "newer.db")
        db.execute("PRAGMA user_version = 99")
        db.close()
        with self.assertRaises(RuntimeError):
            ClipStore(self.tmp / "newer.db")

    def test_record_round_trip(self):
        job = make_job(name="Best bit", owner_name="Alice", public=True, shared_at=12.5, size=42, finished=10.0)
        self.add(job)
        loaded = Job.from_record(self.manager.store.get(job.id))
        for attribute in ("id", "user_id", "owner_name", "item_id", "title", "name", "start", "end", "mode",
                          "description", "filename", "extension", "status", "size", "finished", "public", "shared_at"):
            self.assertEqual(getattr(loaded, attribute), getattr(job, attribute), attribute)
        self.assertEqual(loaded.progress, 1.0)

    def test_update_rejects_unknown_columns(self):
        with self.assertRaises(ValueError):
            self.manager.store.update("x", status="done; DROP TABLE clips", nonsense=1)


class RestartTests(StoreTestCase):
    def test_clips_survive_a_restart(self):
        job = self.add(make_job(finished=time.time()))
        self.manager.rename(job.id, "u1", "Kept", "Kept.mp4")
        self.manager.set_public(job.id, True, "u1")
        manager = self.new_manager()
        manager.recover()
        loaded = manager.get(job.id, "u1")
        self.assertEqual((loaded.name, loaded.filename, loaded.public, loaded.status), ("Kept", "Kept.mp4", True, DONE))
        self.assertTrue(manager.output_path(loaded).is_file())
        self.assertEqual([clip.id for clip in manager.list_public(10)], [job.id])

    def test_restart_marks_unfinished_jobs_failed(self):
        queued = self.add(make_job(status=QUEUED))
        running = self.add(make_job(status=RUNNING))
        manager = self.new_manager()
        manager.recover()
        for job in (queued, running):
            loaded = manager.get(job.id, "u1")
            self.assertEqual(loaded.status, FAILED)
            self.assertIn("restarted", loaded.error)
            self.assertGreater(loaded.finished, 0)

    def test_restart_tidies_files(self):
        done = self.add(make_job(finished=time.time()))
        gone = self.add(make_job(finished=time.time()), with_file=False)
        running = self.add(make_job(status=RUNNING))
        leftovers = [
            self.manager.temp_path(running),  # half written clip
            self.manager.subtitle_path(running),  # subtitle file of an interrupted job
            self.clips / ("f" * 32 + ".mp4"),  # no record at all
        ]
        for path in leftovers:
            path.write_bytes(b"x")
        manager = self.new_manager()
        with self.assertLogs("finclipper.jobs", level="WARNING") as logs:
            manager.recover()
        self.assertIn(f"Dropped clip {gone.id}", "\n".join(logs.output))
        self.assertTrue(manager.output_path(done).is_file())
        for path in leftovers:
            self.assertFalse(path.exists(), path.name)
        # A finished clip whose file is missing could never be downloaded.
        self.assertIsNone(manager.get(gone.id, "u1"))


class ExpiryTests(StoreTestCase):
    def test_private_clips_expire_after_retention(self):
        now = time.time()
        old = self.add(make_job(finished=now - 2 * HOUR))
        fresh = self.add(make_job(finished=now - 0.5 * HOUR))
        failed = self.add(make_job(status=FAILED, finished=now - 2 * HOUR))
        self.assertEqual(self.manager.expire(now), 2)
        self.assertIsNone(self.manager.get(old.id, "u1"))
        self.assertIsNone(self.manager.get(failed.id, "u1"))
        self.assertFalse(self.manager.output_path(old).exists())
        self.assertIsNotNone(self.manager.get(fresh.id, "u1"))

    def test_unshared_clips_get_a_fresh_retention_period(self):
        now = time.time()
        job = self.add(make_job(finished=now - 5 * HOUR, unshared_at=now - 0.2 * HOUR))
        self.assertEqual(self.manager.expire(now), 0)
        self.assertEqual(self.manager.expire(now + HOUR), 1)
        self.assertIsNone(self.manager.get(job.id, "u1"))

    def test_public_clips_kept_until_made_private_by_default(self):
        now = time.time()
        job = self.add(make_job(finished=now - 100 * HOUR, public=True, shared_at=now - 99 * HOUR))
        self.assertEqual(self.manager.expire(now), 0)
        self.manager.set_public(job.id, False, "u1")
        # Making it private starts the normal retention period.
        self.assertEqual(self.manager.expire(time.time() + 0.5 * HOUR), 0)
        self.assertEqual(self.manager.expire(time.time() + 2 * HOUR), 1)

    def test_public_retention_setting(self):
        now = time.time()
        self.add(make_job(finished=now - 3 * HOUR, public=True, shared_at=now - 3 * HOUR))
        self.add(make_job(finished=now - 3 * HOUR, public=True, shared_at=now - HOUR))
        manager = self.new_manager(public_retention_hours=2)
        self.assertEqual(manager.expire(now), 1)

    def test_active_jobs_never_expire(self):
        self.add(make_job(status=RUNNING, finished=0))
        self.assertEqual(self.manager.expire(time.time() + 1000 * HOUR), 0)


class SharingTests(StoreTestCase):
    def test_owner_shares_and_unshares(self):
        job = self.add(make_job())
        shared = self.manager.set_public(job.id, True, "u1")
        self.assertTrue(shared.public)
        self.assertGreater(shared.shared_at, 0)
        self.assertEqual(self.manager.get_public(job.id).id, job.id)
        unshared = self.manager.set_public(job.id, False, "u1")
        self.assertEqual((unshared.public, unshared.shared_at), (False, 0.0))
        self.assertGreater(unshared.unshared_at, 0)
        self.assertIsNone(self.manager.get_public(job.id))

    def test_other_users_cannot_change_sharing(self):
        job = self.add(make_job())
        self.assertIsNone(self.manager.set_public(job.id, True, "u2"))
        self.assertFalse(self.manager.get(job.id, "u1").public)
        # user_id None (the administrator path) skips the owner check.
        self.manager.set_public(job.id, True, "u1")
        self.assertFalse(self.manager.set_public(job.id, False).public)
        self.assertFalse(self.manager.get(job.id, "u1").public)

    def test_only_finished_clips_can_be_shared(self):
        job = self.add(make_job(status=RUNNING))
        with self.assertRaises(ValueError):
            self.manager.set_public(job.id, True, "u1")
        self.assertFalse(self.manager.get(job.id, "u1").public)

    def test_sharing_again_keeps_the_original_time(self):
        job = self.add(make_job())
        shared_at = self.manager.set_public(job.id, True, "u1").shared_at
        self.assertEqual(self.manager.set_public(job.id, True, "u1").shared_at, shared_at)

    def test_public_list_newest_first_and_finished_only(self):
        older = self.add(make_job(public=True, shared_at=100.0))
        newer = self.add(make_job("u2", public=True, shared_at=200.0))
        self.add(make_job())  # private
        self.add(make_job(status=RUNNING, public=True, shared_at=300.0))  # not finished
        self.assertEqual([job.id for job in self.manager.list_public(10)], [newer.id, older.id])
        self.assertEqual([job.id for job in self.manager.list_public(1)], [newer.id])

    def test_public_view_hides_owner_only_fields(self):
        job = make_job(owner_name="Alice", public=True, shared_at=5.0)
        view = job.to_public_dict("u2")
        self.assertEqual((view["owner_name"], view["mine"], view["playable"]), ("Alice", False, True))
        self.assertTrue(job.to_public_dict("u1")["mine"])
        for private in ("status", "error", "progress", "user_id"):
            self.assertNotIn(private, view)

    def test_deleting_a_shared_clip_removes_it(self):
        job = self.add(make_job(public=True, shared_at=1.0))
        self.assertTrue(self.manager.delete(job.id, "u1"))
        self.assertEqual(self.manager.list_public(10), [])
        self.assertIsNone(self.manager.store.get(job.id))
        self.assertFalse(self.manager.output_path(job).exists())


class QueueTests(StoreTestCase):
    def queued_job(self, user_id="u1"):
        return make_job(user_id, status=QUEUED, command=["true"], redacted_command=["true"])

    def test_submit_stores_the_job(self):
        job = self.manager.submit(self.queued_job())
        self.assertEqual(self.manager.store.get(job.id)["status"], QUEUED)
        # The live object is returned while it is active.
        self.assertIs(self.manager.get(job.id, "u1"), job)
        self.assertEqual([clip.id for clip in self.manager.list("u1")], [job.id])

    def test_per_user_limit(self):
        manager = self.new_manager(max_per_user=1)
        manager.submit(self.queued_job())
        with self.assertRaises(JobLimitError):
            manager.submit(self.queued_job())
        manager.submit(self.queued_job("u2"))

    def test_cancelling_a_queued_job_is_stored(self):
        job = self.manager.submit(self.queued_job())
        self.manager.cancel(job.id, "u1")
        row = self.manager.store.get(job.id)
        self.assertEqual(row["status"], CANCELLED)
        self.assertGreater(row["finished"], 0)
        self.assertNotIn(job.id, self.manager._active)

    def test_rename_updates_the_live_job_and_the_record(self):
        job = self.manager.submit(self.queued_job())
        self.manager.rename(job.id, "u1", "New", "New.mp4")
        self.assertEqual(job.name, "New")
        self.assertEqual(self.manager.store.get(job.id)["name"], "New")
        self.assertIsNone(self.manager.rename(job.id, "u2", "Mine now", "x.mp4"))

    @unittest.skipUnless(HAVE_FFMPEG, "ffmpeg is not installed")
    def test_worker_runs_ffmpeg_and_stores_the_result(self):
        job = make_job(status=QUEUED, end=1)
        job.command = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=1",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-progress", "pipe:1", "-nostats",
            "-f", "mp4", str(self.manager.temp_path(job)),
        ]
        job.redacted_command = job.command
        self.manager.start()
        self.manager.submit(job)
        deadline = time.time() + 30
        while self.manager.get(job.id, "u1").status in (QUEUED, RUNNING) and time.time() < deadline:
            time.sleep(0.05)
        row = self.manager.store.get(job.id)
        self.assertEqual((row["status"], row["error"]), (DONE, ""))
        self.assertGreater(row["size"], 0)
        self.assertGreater(row["finished"], 0)
        self.assertTrue(self.manager.output_path(job).is_file())
        self.assertFalse(self.manager.temp_path(job).exists())
        # Finished jobs are no longer held in memory; reads come from the database.
        self.assertNotIn(job.id, self.manager._active)
        self.assertIsNot(self.manager.get(job.id, "u1"), job)
