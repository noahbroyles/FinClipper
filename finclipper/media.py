"""Helpers for turning Jellyfin item data into an ffmpeg clip command.

Everything in here is a pure function (apart from the filesystem check in
resolve_local_path) so it can be unit tested without Jellyfin or ffmpeg.
"""

import re
import math
from pathlib import Path

# Item types that are single playable video files.
CLIPPABLE_TYPES = {"Movie", "Episode", "Video", "MusicVideo", "Trailer"}

# "Video" streams with these codecs are cover art, not real video tracks.
IMAGE_CODECS = {"mjpeg", "png", "bmp", "gif", "webp"}

# Codecs that can be stream copied into an MP4 container and still play on
# most devices. Anything else makes fast mode fall back to MKV (video) or
# re-encode to AAC (audio).
MP4_VIDEO_COPY = {"h264", "hevc", "av1", "vp9", "mpeg4", "mpeg2video"}
MP4_AUDIO_COPY = {"aac", "mp3", "ac3", "eac3"}

# Output heights offered for precise (re-encode) mode. 0 means "original".
ALLOWED_HEIGHTS = {0, 2160, 1440, 1080, 720, 480, 360}

# Characters that are not allowed in file names on common filesystems.
_UNSAFE_FILENAME = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*]')

# Accepts "SS", "SS.mmm", "MM:SS(.mmm)" and "HH:MM:SS(.mmm)".
_TIMESTAMP = re.compile(r"^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)$")


def parse_timestamp(value):
    """Parse seconds (number or string) or a HH:MM:SS.mmm string to float seconds.

    Raises ValueError for anything that is not a finite, non-negative time.
    """
    if isinstance(value, bool):
        # bool is a subclass of int, but True is not a sensible timestamp.
        raise ValueError("Invalid timestamp")
    if isinstance(value, (int, float)):
        seconds = float(value)
    elif isinstance(value, str):
        match = _TIMESTAMP.match(value.strip())
        if not match:
            raise ValueError(f"Invalid timestamp {value!r}")
        first, second, last = match.groups()
        # With one colon the regex fills the first group, so "MM:SS" lands
        # in (first, None, last) and "HH:MM:SS" in (first, second, last).
        if second is None:
            hours, minutes = 0, int(first or 0)
        else:
            hours, minutes = int(first), int(second)
        if second is not None and minutes >= 60:
            raise ValueError(f"Invalid minutes in {value!r}")
        if (first is not None) and float(last) >= 60:
            raise ValueError(f"Invalid seconds in {value!r}")
        seconds = hours * 3600 + minutes * 60 + float(last)
    else:
        raise ValueError("Invalid timestamp")
    if not math.isfinite(seconds) or seconds < 0:
        raise ValueError("Timestamp must be a non-negative number")
    return seconds


def format_timestamp(seconds, separator=":", millis=True):
    """Format seconds as HH:MM:SS.mmm (or HH.MM.SS for file names)."""
    total_ms = int(round(seconds * 1000))
    hours, rest = divmod(total_ms, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, ms = divmod(rest, 1000)
    text = f"{hours:02d}{separator}{minutes:02d}{separator}{secs:02d}"
    if millis:
        text += f".{ms:03d}"
    return text


def ticks_to_seconds(ticks):
    """Convert Jellyfin ticks (100 ns units) to seconds, or None."""
    if not ticks:
        return None
    return ticks / 10_000_000


def item_title(item):
    """Human readable title used for display and for the download file name."""
    name = item.get("Name") or "Untitled"
    if item.get("Type") == "Episode":
        series = item.get("SeriesName") or ""
        season = item.get("ParentIndexNumber")
        episode = item.get("IndexNumber")
        code = ""
        if season is not None and episode is not None:
            code = f"S{season:02d}E{episode:02d}"
        elif episode is not None:
            code = f"E{episode:02d}"
        parts = [part for part in (series, code, name) if part]
        return " - ".join(parts)
    year = item.get("ProductionYear")
    # Unmatched movies can keep the year in their name ("Film (2020)"), so
    # only add it when it is not already there.
    if item.get("Type") == "Movie" and year and not name.endswith(f"({year})"):
        return f"{name} ({year})"
    return name


def video_streams(source):
    """Real (non cover art) video streams of a media source."""
    return [
        stream
        for stream in source.get("MediaStreams") or []
        if stream.get("Type") == "Video"
        and not stream.get("IsExternal")
        and (stream.get("Codec") or "").lower() not in IMAGE_CODECS
    ]


def audio_streams(source):
    """Audio streams embedded in the media file.

    External audio files are skipped because their Index does not refer to a
    stream inside the main file, so ffmpeg could not map them.
    """
    return [
        stream
        for stream in source.get("MediaStreams") or []
        if stream.get("Type") == "Audio" and not stream.get("IsExternal")
    ]


def default_audio_index(source):
    """Pick the audio stream Jellyfin would play by default."""
    streams = audio_streams(source)
    if not streams:
        return None
    wanted = source.get("DefaultAudioStreamIndex")
    if any(stream.get("Index") == wanted for stream in streams):
        return wanted
    for stream in streams:
        if stream.get("IsDefault"):
            return stream.get("Index")
    return streams[0].get("Index")


def summarize_source(source):
    """Reduce a Jellyfin MediaSourceInfo to what the editor UI needs."""
    videos = video_streams(source)
    video = videos[0] if videos else None
    return {
        "id": source.get("Id"),
        "name": source.get("Name") or "Default",
        "container": source.get("Container"),
        "duration": ticks_to_seconds(source.get("RunTimeTicks")),
        "video": None if video is None else {
            "index": video.get("Index"),
            "codec": video.get("Codec"),
            "width": video.get("Width"),
            "height": video.get("Height"),
            "range": video.get("VideoRangeType") or video.get("VideoRange"),
            "title": video.get("DisplayTitle"),
        },
        "audio": [
            {
                "index": stream.get("Index"),
                "title": stream.get("DisplayTitle") or stream.get("Codec") or "Audio",
                "codec": stream.get("Codec"),
                "channels": stream.get("Channels"),
                "language": stream.get("Language"),
            }
            for stream in audio_streams(source)
        ],
        "default_audio": default_audio_index(source),
    }


def clip_problem(item):
    """Return a reason why an item cannot be clipped, or None if it can."""
    if item.get("IsFolder") or item.get("Type") not in CLIPPABLE_TYPES:
        return "This item is not a single video file."
    if item.get("MediaType") not in (None, "Video"):
        return "This item is not a video."
    sources = item.get("MediaSources") or []
    if not sources:
        return "Jellyfin has no media source for this item."
    return None


def source_problem(source):
    """Return a reason why a specific media source cannot be clipped, or None."""
    video_type = source.get("VideoType")
    if video_type and video_type != "VideoFile":
        return f"Disc images and folders ({video_type}) are not supported."
    if not video_streams(source):
        return "This file has no video stream."
    return None


def resolve_local_path(jellyfin_path, path_map):
    """Translate a path reported by Jellyfin into a readable local file.

    PATH_MAP entries are tried longest prefix first. If none matches, the
    path is tried unchanged, which works when media is mounted at the same
    path in both containers. Returns a Path, or None if the file is not
    reachable from this container (FinClipper then streams it from Jellyfin
    instead, if allowed).
    """
    if not jellyfin_path or "://" in jellyfin_path:
        return None
    candidates = []
    for remote_prefix, local_prefix in path_map:
        matches = (
            remote_prefix == "/"
            or jellyfin_path == remote_prefix
            or jellyfin_path.startswith(remote_prefix + "/")
            or jellyfin_path.startswith(remote_prefix + "\\")
        )
        if matches:
            relative = jellyfin_path[len(remote_prefix):].replace("\\", "/").lstrip("/")
            candidates.append(f"{local_prefix.rstrip('/')}/{relative}")
            break
    candidates.append(jellyfin_path)
    for candidate in candidates:
        path = Path(candidate)
        if path.is_file():
            return path
    return None


def safe_filename(name, max_length=150):
    """Make a string safe to use as a download file name."""
    cleaned = _UNSAFE_FILENAME.sub("_", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    if len(cleaned) > max_length:
        cleaned = cleaned[:max_length].rstrip(" .")
    return cleaned or "clip"


def clip_filename(title, start, end, extension):
    """Build "Title [HH.MM.SS-HH.MM.SS].ext" for the downloaded clip."""
    span = f"{format_timestamp(start, '.', False)}-{format_timestamp(end, '.', False)}"
    return f"{safe_filename(title)} [{span}].{extension}"


def plan_output(mode, video, audio):
    """Decide the container and codec handling for a clip.

    Returns a dict with "extension", "format", "copy_audio" and a short
    human readable "description" shown in the UI.
    """
    if mode == "precise":
        return {
            "extension": "mp4",
            "format": "mp4",
            "copy_audio": False,
            "description": "H.264 + AAC stereo (MP4)",
        }
    video_codec = (video.get("Codec") or "").lower()
    audio_codec = (audio.get("Codec") or "").lower() if audio else ""
    if video_codec in MP4_VIDEO_COPY:
        copy_audio = audio is None or audio_codec in MP4_AUDIO_COPY
        description = f"Original {video_codec}"
        if audio is not None:
            description += f" + {audio_codec}" if copy_audio else f" + {audio_codec} converted to AAC"
        return {
            "extension": "mp4",
            "format": "mp4",
            "copy_audio": copy_audio,
            "description": description + " (MP4)",
        }
    # Unusual video codecs (vc1, msmpeg4, ...) go into MKV, which can hold anything.
    description = f"Original {video_codec or 'video'}"
    if audio is not None:
        description += f" + {audio_codec}"
    return {
        "extension": "mkv",
        "format": "matroska",
        "copy_audio": True,
        "description": description + " (MKV)",
    }


def _scale_filter(max_height):
    """Scale filter that never upscales and always yields even dimensions.

    libx264 with yuv420p requires even width and height. The expressions are
    single quoted so their commas are not read as filter separators.
    """
    if max_height:
        return f"scale=w=-2:h='trunc(min({max_height},ih)/2)*2'"
    return "scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'"


def _tonemap_filters(video):
    """Filters that convert HDR (PQ or HLG) video to SDR BT.709.

    setparams first tags the frames with the HDR color properties (as
    Jellyfin does), because zscale fails with "no path between colorspaces"
    when a later stage cannot work out the input colorspace.
    """
    range_type = (video.get("VideoRangeType") or "").upper()
    transfer = "arib-std-b67" if "HLG" in range_type else "smpte2084"
    return [
        f"setparams=color_primaries=bt2020:color_trc={transfer}:colorspace=bt2020nc:range=tv",
        "zscale=t=linear:npl=100",
        "format=gbrpf32le",
        "zscale=p=bt709",
        "tonemap=tonemap=hable:desat=0",
        "zscale=t=bt709:m=bt709:r=tv",
    ]


def build_ffmpeg_command(
    source,
    start,
    duration,
    video,
    audio,
    mode,
    max_height,
    output_path,
    plan,
    preset="veryfast",
    crf=20,
    http_headers=None,
):
    """Build the ffmpeg argument list for one clip.

    source       local file path or http(s) URL of the original file
    start        clip start in seconds
    duration     clip length in seconds
    video/audio  Jellyfin MediaStream dicts (audio may be None)
    mode         "fast" (stream copy) or "precise" (re-encode)
    max_height   output height limit for precise mode, 0 for original
    plan         result of plan_output()
    http_headers raw header block sent when source is a URL
    """
    # nice keeps Jellyfin playback responsive while a clip is being encoded.
    cmd = ["nice", "-n", "10", "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]

    if http_headers:
        # Input options must come before -i. rw_timeout (microseconds)
        # stops ffmpeg hanging forever if Jellyfin stops responding.
        cmd += ["-headers", http_headers, "-rw_timeout", "30000000"]

    # Input seeking (-ss before -i) is fast. When re-encoding, ffmpeg still
    # decodes from the previous keyframe and drops frames before the start,
    # so the cut is frame accurate.
    cmd += ["-ss", f"{start:.3f}", "-i", str(source), "-t", f"{duration:.3f}"]

    cmd += ["-map", f"0:{video['Index']}"]
    if audio is not None:
        cmd += ["-map", f"0:{audio['Index']}"]

    # Drop source tags and chapters; chapter marks outside the clip are confusing.
    cmd += ["-map_metadata", "-1", "-map_chapters", "-1"]

    if mode == "precise":
        filters = []
        if video.get("IsInterlaced"):
            filters.append("yadif")
        filters.append(_scale_filter(max_height))
        is_hdr = (video.get("VideoRange") or "").upper() == "HDR"
        if is_hdr:
            filters += _tonemap_filters(video)
        filters.append("format=yuv420p")
        cmd += ["-vf", ",".join(filters)]
        cmd += ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high"]
        if is_hdr:
            # Tag the tonemapped output so players do not guess the colors.
            cmd += ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
        if audio is not None:
            cmd += ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
    else:
        cmd += ["-c:v", "copy"]
        if plan["format"] == "mp4" and (video.get("Codec") or "").lower() == "hevc":
            # Apple players only accept HEVC in MP4 with the hvc1 tag.
            cmd += ["-tag:v", "hvc1"]
        if audio is not None:
            if plan["copy_audio"]:
                cmd += ["-c:a", "copy"]
            else:
                channels = audio.get("Channels") or 2
                bitrate = "192k" if channels <= 2 else "384k"
                cmd += ["-c:a", "aac", "-b:a", bitrate]
        # Stream copy has to start at the keyframe before the requested start.
        # In MP4 the muxer writes an edit list that hides those extra frames,
        # so the clip still opens on the exact start frame in most players.
        # Forcing make_zero would undo that, so it is only used for MKV,
        # which has no edit lists (the clip then starts at the keyframe).
        if plan["format"] == "matroska":
            cmd += ["-avoid_negative_ts", "make_zero"]

    if plan["format"] == "mp4":
        # Put the index at the front so the clip can start playing while downloading.
        cmd += ["-movflags", "+faststart"]

    # Machine readable progress on stdout, no interactive stats on stderr.
    cmd += ["-progress", "pipe:1", "-nostats", "-f", plan["format"], str(output_path)]
    return cmd
