"""SQLite storage for clip records.

Clip records (who made a clip, its name, time range, status, whether it is
public, and so on) are kept in DATA_DIR/finclipper.db, so clips survive
restarts. What only matters while a clip is being made (the ffmpeg process,
progress, the subtitle download step) stays in memory in jobs.JobManager.

One connection is shared by all threads and guarded by a lock. Every
statement is small and the app is a single process, so this is simpler than
a connection per thread and never contends in practice. The database uses
write-ahead logging, so it also stays consistent if the container is killed
mid-write.
"""

import sqlite3
import threading

# Columns of the clips table. Updates may only name these.
COLUMNS = (
    "id", "user_id", "owner_name", "item_id", "title", "name", "start_time", "end_time", "mode",
    "description", "filename", "extension", "status", "error", "size", "created", "finished",
    "public", "shared_at", "unshared_at",
)

# Each entry upgrades the schema by one version, tracked in PRAGMA
# user_version. Never change an entry that has been released; add a new one.
# Times are Unix timestamps in seconds, and 0 means "not yet":
#   finished     when the clip reached a final state (done, failed...)
#   shared_at    when it was made public (0 while private)
#   unshared_at  when it was last made private (0 if never shared)
MIGRATIONS = [
    """
    CREATE TABLE clips (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        owner_name  TEXT NOT NULL DEFAULT '',
        item_id     TEXT NOT NULL,
        title       TEXT NOT NULL,
        name        TEXT NOT NULL DEFAULT '',
        start_time  REAL NOT NULL,
        end_time    REAL NOT NULL,
        mode        TEXT NOT NULL,
        description TEXT NOT NULL,
        filename    TEXT NOT NULL,
        extension   TEXT NOT NULL,
        status      TEXT NOT NULL,
        error       TEXT NOT NULL DEFAULT '',
        size        INTEGER NOT NULL DEFAULT 0,
        created     REAL NOT NULL,
        finished    REAL NOT NULL DEFAULT 0,
        public      INTEGER NOT NULL DEFAULT 0,
        shared_at   REAL NOT NULL DEFAULT 0,
        unshared_at REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX clips_by_user ON clips (user_id, created);
    CREATE INDEX clips_public ON clips (public, shared_at);
    """,
]


class ClipStore:
    """The clips table. Rows are returned as plain dicts keyed by column."""

    def __init__(self, path):
        self._lock = threading.Lock()
        # isolation_level=None: every statement commits on its own unless a
        # transaction is opened explicitly (only the migrations do that).
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        try:
            self._db.row_factory = sqlite3.Row
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=NORMAL")
            self._db.execute("PRAGMA busy_timeout=5000")
            self._migrate()
        except Exception:
            # Do not leave the file open when the database cannot be used.
            self._db.close()
            raise

    def _migrate(self):
        """Bring the schema up to date, one version per transaction."""
        with self._lock:
            version = self._db.execute("PRAGMA user_version").fetchone()[0]
            if version > len(MIGRATIONS):
                raise RuntimeError(
                    f"The clip database is schema version {version}, but this FinClipper only knows "
                    f"{len(MIGRATIONS)}. It was created by a newer FinClipper."
                )
            for number in range(version, len(MIGRATIONS)):
                try:
                    self._db.executescript(f"BEGIN; {MIGRATIONS[number]} PRAGMA user_version = {number + 1}; COMMIT;")
                except sqlite3.Error:
                    if self._db.in_transaction:
                        self._db.execute("ROLLBACK")
                    raise

    def schema_version(self):
        with self._lock:
            return self._db.execute("PRAGMA user_version").fetchone()[0]

    def close(self):
        with self._lock:
            self._db.close()

    def _rows(self, sql, args=()):
        with self._lock:
            return [dict(row) for row in self._db.execute(sql, args).fetchall()]

    def insert(self, record):
        """Add a clip. record maps column names to values."""
        columns = [column for column in COLUMNS if column in record]
        placeholders = ", ".join("?" for _ in columns)
        with self._lock:
            self._db.execute(
                f"INSERT INTO clips ({', '.join(columns)}) VALUES ({placeholders})",
                [record[column] for column in columns],
            )

    def update(self, clip_id, **fields):
        """Change some columns of a clip. Does nothing if the clip is gone."""
        unknown = set(fields) - set(COLUMNS)
        if unknown or not fields:
            raise ValueError(f"Cannot update columns {sorted(unknown) or 'none'}")
        assignments = ", ".join(f"{column} = ?" for column in fields)
        with self._lock:
            self._db.execute(f"UPDATE clips SET {assignments} WHERE id = ?", [*fields.values(), clip_id])

    def delete(self, clip_id):
        with self._lock:
            self._db.execute("DELETE FROM clips WHERE id = ?", (clip_id,))

    def get(self, clip_id):
        rows = self._rows("SELECT * FROM clips WHERE id = ?", (clip_id,))
        return rows[0] if rows else None

    def list_for_user(self, user_id):
        """A user's clips, newest first."""
        return self._rows("SELECT * FROM clips WHERE user_id = ? ORDER BY created DESC", (user_id,))

    def list_public(self, done_status, limit):
        """Finished public clips, most recently shared first."""
        return self._rows(
            "SELECT * FROM clips WHERE public = 1 AND status = ? ORDER BY shared_at DESC LIMIT ?",
            (done_status, limit),
        )

    def list_by_status(self, status):
        return self._rows("SELECT * FROM clips WHERE status = ?", (status,))

    def ids(self):
        with self._lock:
            return {row[0] for row in self._db.execute("SELECT id FROM clips").fetchall()}

    def mark_interrupted(self, active_statuses, failed_status, now):
        """Fail clips that were queued or being made when the app stopped.

        Their ffmpeg process died with the old app, and the command (with
        the user's Jellyfin token) was never stored, so they cannot resume.
        Returns how many clips were marked.
        """
        marks = ", ".join("?" for _ in active_statuses)
        with self._lock:
            cursor = self._db.execute(
                f"UPDATE clips SET status = ?, error = ?, finished = ? WHERE status IN ({marks})",
                (failed_status, "Interrupted because FinClipper restarted. Please create it again.", now, *active_statuses),
            )
            return cursor.rowcount

    def expired(self, active_statuses, now, retention_seconds, public_retention_seconds):
        """Clips whose time is up, worked out from the current settings.

        A private clip expires retention_seconds after it finished, or after
        it was last made private if that is later (so its owner still has
        time to download it). A public clip expires public_retention_seconds
        after it was shared, or never when that is 0. Clips still being made
        never expire.
        """
        marks = ", ".join("?" for _ in active_statuses)
        return self._rows(
            f"""
            SELECT * FROM clips
            WHERE status NOT IN ({marks}) AND (
                (public = 0 AND max(finished, unshared_at) < ?)
                OR (public = 1 AND ? > 0 AND shared_at < ?)
            )
            """,
            (*active_statuses, now - retention_seconds, public_retention_seconds, now - public_retention_seconds),
        )
