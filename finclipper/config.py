"""Application configuration, read from environment variables.

Every setting has a sensible default except JELLYFIN_URL. See the README for
a description of each variable.
"""

import os
import secrets
from pathlib import Path


def _env_bool(name, default):
    """Read a boolean environment variable ("1", "true", "yes", "on" are true)."""
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name, default, minimum=None):
    """Read an integer environment variable, falling back to the default."""
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    try:
        number = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {value!r}") from exc
    if minimum is not None and number < minimum:
        raise ValueError(f"{name} must be >= {minimum}, got {number}")
    return number


def parse_path_map(raw):
    """Parse PATH_MAP into a list of (jellyfin_prefix, local_prefix) tuples.

    Format: comma separated "jellyfin_prefix=local_prefix" pairs, for example
    "/data/movies=/media/movies,/data/tv=/media/tv". The result is sorted so
    the longest Jellyfin prefix is tried first, which makes nested mappings
    behave predictably.
    """
    mappings = []
    for chunk in (raw or "").split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "=" not in chunk:
            raise ValueError(f"PATH_MAP entry {chunk!r} must look like /jellyfin/path=/local/path")
        remote, local = (part.strip() for part in chunk.split("=", 1))
        if not remote or not local:
            raise ValueError(f"PATH_MAP entry {chunk!r} has an empty side")
        # Strip trailing slashes so "/media/" and "/media" behave the same.
        # A bare "/" is kept as is.
        mappings.append((remote.rstrip("/") or "/", local.rstrip("/") or "/"))
    mappings.sort(key=lambda pair: len(pair[0]), reverse=True)
    return mappings


def _load_secret_key(data_dir):
    """Return SECRET_KEY from the environment, or a key persisted in DATA_DIR.

    Persisting the generated key means sessions survive container restarts
    without the user having to configure anything.
    """
    key = os.environ.get("SECRET_KEY", "").strip()
    if key:
        return key
    key_file = data_dir / "secret_key"
    if key_file.is_file():
        stored = key_file.read_text(encoding="utf-8").strip()
        if stored:
            return stored
    key = secrets.token_hex(32)
    # Create the file with owner-only permissions before writing the secret.
    fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(key)
    return key


class Config:
    """Settings object handed to Flask via app.config.from_object()."""

    def __init__(self):
        jellyfin_url = os.environ.get("JELLYFIN_URL", "").strip().rstrip("/")
        if not jellyfin_url:
            raise RuntimeError("JELLYFIN_URL is not set (for example http://jellyfin:8096)")
        if not jellyfin_url.startswith(("http://", "https://")):
            raise RuntimeError("JELLYFIN_URL must start with http:// or https://")

        # Where finished clips and the generated secret key live.
        self.DATA_DIR = Path(os.environ.get("DATA_DIR", "/data")).resolve()
        self.CLIPS_DIR = self.DATA_DIR / "clips"
        self.CLIPS_DIR.mkdir(parents=True, exist_ok=True)

        # Jellyfin connection.
        self.JELLYFIN_URL = jellyfin_url
        self.JELLYFIN_VERIFY_TLS = _env_bool("JELLYFIN_VERIFY_TLS", True)

        # Mapping from paths as Jellyfin sees them to paths inside this container.
        self.PATH_MAP = parse_path_map(os.environ.get("PATH_MAP", ""))
        # If the file is not reachable locally, read it over HTTP from Jellyfin.
        self.ALLOW_STREAM_FALLBACK = _env_bool("ALLOW_STREAM_FALLBACK", True)

        # Clip limits. MAX_CLIP_SECONDS of 0 disables the length limit.
        self.MAX_CLIP_SECONDS = _env_int("MAX_CLIP_SECONDS", 600, minimum=0)
        self.MAX_CONCURRENT_JOBS = _env_int("MAX_CONCURRENT_JOBS", 2, minimum=1)
        self.MAX_JOBS_PER_USER = _env_int("MAX_JOBS_PER_USER", 3, minimum=1)
        self.CLIP_RETENTION_HOURS = _env_int("CLIP_RETENTION_HOURS", 24, minimum=1)

        # Re-encode settings for "precise" mode.
        self.X264_PRESET = os.environ.get("X264_PRESET", "veryfast").strip() or "veryfast"
        self.X264_CRF = _env_int("X264_CRF", 20, minimum=0)

        # Only allow users that Jellyfin permits to download media.
        self.REQUIRE_DOWNLOAD_PERMISSION = _env_bool("REQUIRE_DOWNLOAD_PERMISSION", True)

        # Flask session settings.
        self.SECRET_KEY = _load_secret_key(self.DATA_DIR)
        self.SESSION_COOKIE_NAME = "finclipper_session"
        self.SESSION_COOKIE_HTTPONLY = True
        self.SESSION_COOKIE_SAMESITE = "Lax"
        self.SESSION_COOKIE_SECURE = _env_bool("SESSION_COOKIE_SECURE", False)
        self.PERMANENT_SESSION_LIFETIME = 60 * 60 * 24 * _env_int("SESSION_DAYS", 30, minimum=1)

        # Number of reverse proxies in front of the app (0 means none).
        self.TRUSTED_PROXIES = _env_int("TRUSTED_PROXIES", 0, minimum=0)

        # Reject oversized request bodies; the API only receives small JSON.
        self.MAX_CONTENT_LENGTH = 64 * 1024
