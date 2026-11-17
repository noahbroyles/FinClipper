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

# Vertical (9:16, phone screen) output sizes, as {height: width}. The height
# is what the API receives as max_height for a vertical clip. Must match
# VERTICAL_SIZES in frontend/src/constants.ts.
VERTICAL_SIZES = {1920: 1080, 1280: 720, 960: 540}

# How a horizontal picture is fitted into a vertical frame:
#   crop  cut off the sides (crop_x picks which part is kept). crop_width
#         says how much is kept: 0 is the narrowest cut, which fills the
#         frame, and 1 the whole width. Anything wider than the narrowest
#         cut is shown with black bars above and below.
#   blur  show the whole picture over a blurred, zoomed copy of itself
#   bars  show the whole picture with black bars above and below
VERTICAL_FITS = {"crop", "blur", "bars"}

# Subtitle codecs that are pictures (Blu-ray PGS, DVD, DVB). ffmpeg overlays
# them as they are, so the font styles below do not apply to them.
BITMAP_SUBTITLE_CODECS = {"pgssub", "hdmv_pgs_subtitle", "dvdsub", "dvd_subtitle", "dvbsub", "dvb_subtitle", "xsub"}

# Looks offered for burned-in text subtitles. Colours are ASS &HAABBGGRR
# values (AA is transparency, 00 is opaque). With border_style 1 the text
# gets an outline and a shadow; with 3 the outline colour fills a box behind
# each line instead, and "outline" is the box padding. The fonts are
# installed in the Docker image (fonts-liberation, fonts-dejavu-core).
SUBTITLE_STYLES = {
    "classic": {
        "label": "Classic (white, outlined)",
        "font": "Liberation Sans",
        "bold": True,
        "primary": "&H00FFFFFF",
        "outline_colour": "&H00000000",
        "back_colour": "&H80000000",
        "border_style": 1,
        "outline": 3,
        "shadow": 1,
    },
    "boxed": {
        "label": "Boxed (white on dark box)",
        "font": "DejaVu Sans",
        "bold": False,
        "primary": "&H00FFFFFF",
        "outline_colour": "&H40000000",
        "back_colour": "&H00000000",
        "border_style": 3,
        "outline": 10,
        "shadow": 0,
    },
    "yellow": {
        "label": "Yellow (outlined)",
        "font": "Liberation Sans",
        "bold": True,
        "primary": "&H0000FFFF",
        "outline_colour": "&H00000000",
        "back_colour": "&H80000000",
        "border_style": 1,
        "outline": 3,
        "shadow": 1,
    },
    "serif": {
        "label": "Serif (cinema)",
        "font": "Liberation Serif",
        "bold": False,
        "primary": "&H00FFFFFF",
        "outline_colour": "&H00000000",
        "back_colour": "&HA0000000",
        "border_style": 1,
        "outline": 2,
        "shadow": 2,
    },
}

# Canvas (PlayRes) and placement of burned-in text subtitles per layout.
# libass scales the canvas to the real frame by its height and never
# stretches the text, so one canvas per layout works for any frame size.
# A vertical clip puts the text about a fifth of the way up, clear of the
# buttons phone apps draw over the bottom of the video.
SUBTITLE_CANVAS = {
    "horizontal": {"width": 1920, "height": 1080, "font_size": 56, "margin_side": 120, "margin_bottom": 60},
    "vertical": {"width": 1080, "height": 1920, "font_size": 66, "margin_side": 70, "margin_bottom": 400},
}

# Characters that are not allowed in file names on common filesystems.
_UNSAFE_FILENAME = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*]')

# Most parts a multi-part clip may be spliced from. The UI is told the
# limit by /api/me.
MAX_CLIP_PARTS = 20

# Longest name a user may give a clip. Must match CLIP_NAME_MAX in
# frontend/src/constants.ts.
MAX_CLIP_NAME_LENGTH = 100

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


def subtitle_kind(stream):
    """Return "text" or "bitmap" for a subtitle that can be burned in, else None.

    Text subtitles (SRT, ASS, WebVTT...) are fetched from Jellyfin, which
    also serves external subtitle files. Picture subtitles are read by ffmpeg
    from the video file itself, so only embedded ones can be used.
    """
    codec = (stream.get("Codec") or "").lower()
    if codec in BITMAP_SUBTITLE_CODECS:
        return None if stream.get("IsExternal") else "bitmap"
    if stream.get("IsTextSubtitleStream"):
        return "text"
    return None


def subtitle_streams(source):
    """Subtitle streams of a media source that can be burned into a clip."""
    return [
        stream
        for stream in source.get("MediaStreams") or []
        if stream.get("Type") == "Subtitle" and subtitle_kind(stream)
    ]


def file_stream_index(source, stream):
    """Index of an embedded stream inside the media file itself, for ffmpeg.

    MediaStream.Index is the stream's place in Jellyfin's list for the
    media source, and that list also holds external files (subtitle or
    audio files next to the video). When one of those is listed before the
    embedded streams, every Index after it is one higher than the stream's
    index in the file, and ffmpeg would read the wrong stream or find none.
    Jellyfin's own ffmpeg calls count the embedded streams listed before
    the one they want (EncodingHelper.FindIndex); this does the same.
    """
    position = 0
    for other in source.get("MediaStreams") or []:
        if other.get("Index") == stream.get("Index"):
            return position
        if not other.get("IsExternal"):
            position += 1
    raise ValueError("The stream is not part of this media source")


def for_ffmpeg(source, stream):
    """A copy of an embedded stream whose Index is its index in the file.

    The functions that build ffmpeg commands and filter graphs take their
    streams in this form (see file_stream_index). Returns None for None.
    """
    if stream is None:
        return None
    return dict(stream, Index=file_stream_index(source, stream))


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
        "subtitles": [
            {
                "index": stream.get("Index"),
                "title": stream.get("DisplayTitle") or stream.get("Language") or stream.get("Codec") or "Subtitles",
                "kind": subtitle_kind(stream),
            }
            for stream in subtitle_streams(source)
        ],
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


def clean_clip_name(value):
    """Tidy a user supplied clip name, returning "" when there is none.

    Control characters (tabs, newlines...) become spaces and runs of
    whitespace collapse to one, so the name displays on a single line.
    Raises ValueError if the value is not text or is too long.
    """
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("The clip name must be text")
    cleaned = re.sub(r"[\x00-\x1f\x7f]", " ", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) > MAX_CLIP_NAME_LENGTH:
        raise ValueError(f"The clip name can be at most {MAX_CLIP_NAME_LENGTH} characters")
    return cleaned


def parse_clip_parts(data):
    """Read the parts of a clip from the body of a "create clip" request.

    "parts" is a list of objects with "start" and "end" (timestamps, see
    parse_timestamp) and optionally the "crop_x" and "crop_width" of a
    vertical crop (see VERTICAL_FITS). Parts are played in the order
    given, which need not be the order they have in the video. A request
    without "parts" describes a plain clip with "start" and "end" of its
    own. "crop_x" and "crop_width" next to "parts" apply to every part
    that does not have its own.

    Returns a list of dicts with start, end, crop_x and crop_width.
    Raises ValueError with a message for the user.
    """
    def fraction(value, default, what):
        if value is None:
            return default
        # NaN and infinity (which Python's JSON parser accepts) fail the range check.
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
            raise ValueError(f"Invalid crop {what}")
        return float(value)

    crop_x = fraction(data.get("crop_x"), 0.5, "position")
    crop_width = fraction(data.get("crop_width"), 0.0, "width")
    raw_parts = data.get("parts")
    if raw_parts is None:
        raw_parts = [{"start": data.get("start"), "end": data.get("end")}]
    if not isinstance(raw_parts, list) or not raw_parts or not all(isinstance(raw, dict) for raw in raw_parts):
        raise ValueError("Invalid clip parts")
    if len(raw_parts) > MAX_CLIP_PARTS:
        raise ValueError(f"A clip can have at most {MAX_CLIP_PARTS} parts")
    return [
        {
            "start": parse_timestamp(raw.get("start")),
            "end": parse_timestamp(raw.get("end")),
            "crop_x": fraction(raw.get("crop_x"), crop_x, "position"),
            "crop_width": fraction(raw.get("crop_width"), crop_width, "width"),
        }
        for raw in raw_parts
    ]


def clip_filename(title, start, end, extension, name="", more_parts=0):
    """Build the download file name for a clip.

    A named clip is saved as "Name.ext". Otherwise the item title and the
    time range are used: "Title [HH.MM.SS-HH.MM.SS].ext". For a multi-part
    clip, start and end are those of the first part and more_parts counts
    the others: "Title [HH.MM.SS-HH.MM.SS + 2 more].ext".
    """
    if name:
        return f"{safe_filename(name)}.{extension}"
    span = f"{format_timestamp(start, '.', False)}-{format_timestamp(end, '.', False)}"
    if more_parts:
        span += f" + {more_parts} more"
    return f"{safe_filename(title)} [{span}].{extension}"


# "00:01:02,345 --> 00:01:04,000" (a dot instead of the comma is accepted too).
_SRT_TIMING = re.compile(
    r"(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})"
)
# ASS override blocks such as {\an8} that SRT files sometimes carry.
_ASS_OVERRIDE = re.compile(r"(\{\\[^}]*\})")


def _srt_seconds(hours, minutes, seconds, millis):
    # The fraction is milliseconds; pad short values ("5" means 500 ms).
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis.ljust(3, "0")) / 1000


def parse_srt(text):
    """Parse SubRip text into a list of (start, end, lines) tuples.

    Lenient on purpose: numbering lines are ignored, and a cue is any
    timing line followed by text up to the next blank line.
    """
    cues = []
    current = None
    for raw_line in text.lstrip("﻿").splitlines():
        line = raw_line.strip()
        timing = _SRT_TIMING.search(line)
        if timing:
            groups = timing.groups()
            current = (_srt_seconds(*groups[:4]), _srt_seconds(*groups[4:]), [])
            cues.append(current)
        elif not line:
            current = None
        elif current is not None:
            current[2].append(line)
    return [cue for cue in cues if cue[2] and cue[1] > cue[0]]


def _srt_text_to_ass(lines):
    """Convert SubRip cue text to ASS dialogue text.

    <i>, <b> and <u> become ASS overrides and other HTML-like tags (such as
    <font>) are dropped. ASS override blocks like {\\an8} are kept. Any
    other braces would hide text in ASS, so they become parentheses.
    """
    parts = _ASS_OVERRIDE.split("\n".join(lines))
    out = []
    for number, part in enumerate(parts):
        if number % 2:
            out.append(part)
            continue
        part = part.replace("{", "(").replace("}", ")")
        part = re.sub(
            r"<\s*(/?)\s*([ibu])\s*>",
            lambda match: "{\\%s%s}" % (match.group(2).lower(), "0" if match.group(1) else "1"),
            part,
            flags=re.IGNORECASE,
        )
        part = re.sub(r"<[^>]*>", "", part)
        out.append(part)
    return "".join(out).replace("\n", "\\N")


def _ass_time(seconds):
    """Format seconds as an ASS timestamp, H:MM:SS.cc."""
    centis = int(round(seconds * 100))
    hours, rest = divmod(centis, 360_000)
    minutes, rest = divmod(rest, 6_000)
    secs, centis = divmod(rest, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{centis:02d}"


def build_ass(srt_text, start, end, style_key, layout):
    """Turn a full SubRip track into an ASS file for a clip of one range."""
    return build_ass_parts(srt_text, [(start, end)], style_key, layout)


def build_ass_parts(srt_text, ranges, style_key, layout):
    """Turn a full SubRip track into an ASS file for one clip.

    ranges lists the (start, end) of each part of the clip, in the order
    they are played. Only cues that overlap a part are kept, and their
    times are shifted to where that part sits in the clip (the first part
    starts at 0), matching the timestamps of the frames ffmpeg produces. A
    cue already on screen when a part starts is kept and clipped, so a cue
    that runs across a join is shown on both sides of it. style_key picks
    a SUBTITLE_STYLES entry and layout a SUBTITLE_CANVAS entry.
    """
    style = SUBTITLE_STYLES[style_key]
    canvas = SUBTITLE_CANVAS[layout]
    # Box padding and outlines are defined for the 1080 tall horizontal
    # canvas; scale them with the font size for the vertical one.
    factor = canvas["font_size"] / SUBTITLE_CANVAS["horizontal"]["font_size"]
    outline = round(style["outline"] * factor, 1)
    shadow = round(style["shadow"] * factor, 1)
    style_line = ",".join(str(value) for value in (
        "Default", style["font"], canvas["font_size"],
        style["primary"], style["primary"], style["outline_colour"], style["back_colour"],
        -1 if style["bold"] else 0, 0, 0, 0,  # bold, italic, underline, strikeout
        100, 100, 0, 0,  # scale x, scale y, spacing, angle
        style["border_style"], outline, shadow,
        2,  # alignment: bottom centre
        canvas["margin_side"], canvas["margin_side"], canvas["margin_bottom"],
        1,  # encoding
    ))
    lines = [
        "[Script Info]",
        "; Generated by FinClipper",
        "ScriptType: v4.00+",
        f"PlayResX: {canvas['width']}",
        f"PlayResY: {canvas['height']}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: {style_line}",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    cues = parse_srt(srt_text)
    offset = 0.0  # where the current part starts in the clip
    for start, end in ranges:
        for cue_start, cue_end, cue_lines in cues:
            if cue_end <= start or cue_start >= end:
                continue
            shifted_start = max(cue_start, start) - start + offset
            shifted_end = min(cue_end, end) - start + offset
            if _ass_time(shifted_end) == _ass_time(shifted_start):
                # Shorter than a hundredth of a second after clipping.
                continue
            lines.append(
                f"Dialogue: 0,{_ass_time(shifted_start)},{_ass_time(shifted_end)},Default,,0,0,0,,"
                + _srt_text_to_ass(cue_lines)
            )
        offset += end - start
    return "\n".join(lines) + "\n"


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
    """Scale filter for horizontal clips: never upscales, even dimensions.

    The width comes from the display aspect ratio (dar), and setsar=1 marks
    the pixels square, so anamorphic sources such as DVDs come out the
    right shape in apps that ignore the sample aspect ratio. libx264 with
    yuv420p requires even width and height. The expressions are single
    quoted so their commas are not read as filter separators; the width can
    refer to the output height (oh) because ffmpeg evaluates it twice.
    """
    height = f"trunc(min({max_height},ih)/2)*2" if max_height else "trunc(ih/2)*2"
    return f"scale=w='trunc(oh*dar/2)*2':h='{height}',setsar=1"


def _join(filters):
    """Join filters into a chain; "null" (pass through) when there are none."""
    return ",".join(filters) or "null"


def _video_graph(video, max_height, layout, fit, crop_x, crop_width, subtitle):
    """Build the -filter_complex graph for a precise (re-encoded) clip.

    The graph reads the video stream (and a picture subtitle stream) of
    input 0 and ends in the [vout] pad. See _part_graph for the steps.
    subtitle is None, {"kind": "text", "file": name} with the ASS file name
    relative to ffmpeg's working directory, or {"kind": "bitmap", "index": n}
    with the stream's index in the input file (see file_stream_index).
    """
    bitmap = subtitle if subtitle and subtitle["kind"] == "bitmap" else None
    text = subtitle if subtitle and subtitle["kind"] == "text" else None
    graph, source, steps = _part_graph(video, max_height, layout, fit, crop_x, crop_width, bitmap)
    if text:
        # After the colour conversion, so HDR sources get SDR subtitle colours.
        steps.append(f"subtitles=filename={text['file']}")
    graph.append(f"{source}{_join(steps)}[vout]")
    return ";".join(graph)


def _multipart_graph(video, audio, max_height, layout, fit, parts, subtitle):
    """Build the -filter_complex graph for a clip spliced from several parts.

    Part number n is read from input n (the same file, opened once per
    part at that part's start). Each part goes through the same steps as a
    single clip (see _part_graph) with its own crop, then the concat filter
    joins the parts, video and audio together, so sound stays in step with
    the picture across the joins. Text subtitles are drawn on the joined
    video, from an ASS file timed for the whole clip (build_ass_parts).

    A part rarely starts exactly on a frame: its first frame can come up to
    a frame after its sound starts. The timestamps are left as they are,
    which keeps picture and sound exactly in step. The price is that the
    encoder now and then holds the last frame of a part for one extra
    frame to cover such a gap. (Shifting each part's video to start at 0
    with setpts would avoid that, but setpts drops the frame durations,
    which loses the last frame of the clip, and puts the picture up to a
    frame ahead of the sound.)

    The graph ends in the [vout] pad and, when there is audio, [aout].
    """
    bitmap = subtitle if subtitle and subtitle["kind"] == "bitmap" else None
    text = subtitle if subtitle and subtitle["kind"] == "text" else None
    graph = []
    pads = ""
    for number, part in enumerate(parts):
        part_graph, source, steps = _part_graph(
            video, max_height, layout, fit, part["crop_x"], part["crop_width"], bitmap, number
        )
        graph += part_graph
        graph.append(f"{source}{_join(steps)}[v{number}]")
        pads += f"[v{number}]"
        if audio is not None:
            pads += f"[{number}:{audio['Index']}]"
    audio_out = "[aout]" if audio is not None else ""
    joined = f"{pads}concat=n={len(parts)}:v=1:a={1 if audio is not None else 0}"
    if text:
        graph.append(f"{joined}[joined]{audio_out}")
        graph.append(f"[joined]subtitles=filename={text['file']}[vout]")
    else:
        graph.append(f"{joined}[vout]{audio_out}")
    return ";".join(graph)


def _part_graph(video, max_height, layout, fit, crop_x, crop_width, bitmap, number=None):
    """Filter chains that turn the video of one input into finished frames.

    Returns (graph, source, steps): the chains that are complete, and the
    input pads and filters of the last chain, which the caller finishes
    and names. number is the input to read for a part of a multi-part
    clip (it also keeps the pad names of the parts apart), or None for a
    single clip, which reads input 0. bitmap is None or a picture subtitle
    {"kind": "bitmap", "index": n} to draw. Steps, in order:

    1. deinterlace (yadif) when Jellyfin reports interlaced video
    2. picture subtitles, drawn at the source resolution, unless the clip
       is a vertical crop (see 4)
    3. resize: horizontal clips scale down to max_height; vertical clips
       first get square pixels, then are cropped (and given black bars if
       the crop is wider than the frame), fitted with a blurred background,
       or fitted with black bars into the 9:16 frame
    4. vertical crop only: picture subtitles are scaled to the frame width
       and drawn after the crop, because a crop would cut off the ends of
       most lines
    5. conversion to the pixel format the encoder is given

    Text subtitles are added by the caller, on the final frame. HDR tone
    mapping runs right after the first resize, so the expensive float
    conversion happens at the output resolution, not the source's.
    """
    is_hdr = (video.get("VideoRange") or "").upper() == "HDR"
    tonemap = _tonemap_filters(video) if is_hdr else []
    vertical_crop = layout == "vertical" and fit == "crop"
    file = number or 0  # which input to read
    tag = "" if number is None else str(number)  # makes pad names unique per part

    graph = []  # finished chains, joined with ";" at the end
    source = f"[{file}:{video['Index']}]"  # input pad(s) of the chain being built
    steps = ["yadif"] if video.get("IsInterlaced") else []

    if bitmap and not vertical_crop:
        # The subtitle canvas is normally the size of the video, but some
        # files keep a 1920x1080 canvas on video that was cropped to a wider
        # shape. Scaling the canvas to the video width and pinning it to the
        # bottom keeps the text on screen either way.
        canvas = f"scale=w={video['Width']}:h=-2" if video.get("Width") else "null"
        graph.append(f"{source}{_join(steps)}[pre{tag}]")
        graph.append(f"[{file}:{bitmap['index']}]{canvas}[subs{tag}]")
        source = f"[pre{tag}][subs{tag}]"
        steps = ["overlay=x=(W-w)/2:y=H-h:eof_action=pass"]

    if layout == "horizontal":
        steps += [_scale_filter(max_height), *tonemap]
    else:
        width, height = VERTICAL_SIZES[max_height], max_height
        # Square pixels first, so the 9:16 maths below works on the shape
        # the picture is really shown at.
        steps.append("scale=w='trunc(iw*sar/2)*2':h='trunc(ih/2)*2',setsar=1")
        fit_inside = f"scale=w={width}:h={height}:force_original_aspect_ratio=decrease:force_divisible_by=2"
        if fit == "crop":
            # "narrow" is the width of the largest 9:16 area of the picture,
            # which is what fills the frame. crop_width widens the crop from
            # there (0) to the whole picture (1), and crop_x (0 = left edge,
            # 1 = right edge) picks where it sits. Pictures taller than 9:16
            # are cropped top and bottom instead, around the middle.
            narrow = "min(iw,ih*9/16)"
            steps += [
                f"crop=w='trunc(({narrow}+(iw-{narrow})*{crop_width:.4f})/2)*2':h='trunc(min(ih,iw*16/9)/2)*2'"
                f":x='(iw-ow)*{crop_x:.4f}':y='(ih-oh)/2'",
                # Full frame width. A crop wider than 9:16 comes out less
                # tall than the frame, and pad adds black bars above and
                # below it. The min() makes the narrowest crop, which is
                # only 9:16 to the nearest pixel, fill the frame exactly.
                f"scale=w={width}:h='min({height},round({width}*ih/iw/2)*2)'",
                *tonemap,
                f"pad={width}:{height}:0:(oh-ih)/2:color=black",
            ]
        elif fit == "bars":
            steps += [fit_inside, *tonemap, f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"]
        else:
            # The background is made from a tiny copy (a tenth of the frame),
            # which makes the blur cheap, then scaled back up.
            small_w, small_h = width // 10 // 2 * 2, height // 10 // 2 * 2
            steps += [fit_inside, *tonemap, f"split=2[fg{tag}][bgsrc{tag}]"]
            graph.append(f"{source}{_join(steps)}")
            graph.append(
                f"[bgsrc{tag}]scale=w={small_w}:h={small_h}:force_original_aspect_ratio=increase,"
                f"crop={small_w}:{small_h},boxblur=luma_radius=8:luma_power=2,scale={width}:{height}[bg{tag}]"
            )
            source = f"[bg{tag}][fg{tag}]"
            steps = ["overlay=x=(W-w)/2:y=(H-h)/2"]
        steps.append("setsar=1")

    if bitmap and vertical_crop:
        # Bottom of the scaled canvas at 78% of the frame height, so the
        # text sits where phone captions usually go.
        graph.append(f"{source}{_join(steps)}[main{tag}]")
        graph.append(f"[{file}:{bitmap['index']}]scale=w={VERTICAL_SIZES[max_height]}:h=-2[subs{tag}]")
        source = f"[main{tag}][subs{tag}]"
        steps = ["overlay=x=(W-w)/2:y=H*0.78-h:eof_action=pass"]

    steps.append("format=yuv420p")
    return graph, source, steps


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
    layout="horizontal",
    fit="crop",
    crop_x=0.5,
    crop_width=0.0,
    subtitle=None,
):
    """Build the ffmpeg argument list for one clip.

    source       local file path or http(s) URL of the original file
    start        clip start in seconds
    duration     clip length in seconds
    video/audio  Jellyfin MediaStream dicts (audio may be None) whose Index
                 is the stream's index in the file, see for_ffmpeg()
    mode         "fast" (stream copy) or "precise" (re-encode)
    max_height   horizontal: output height limit for precise mode, 0 for
                 original; vertical: the output height (a VERTICAL_SIZES key)
    plan         result of plan_output()
    http_headers raw header block sent when source is a URL
    layout       "horizontal" or "vertical" (precise mode only)
    fit, crop_x, crop_width
                 how a vertical clip is framed (see VERTICAL_FITS)
    subtitle     subtitles to burn in (precise mode only), see _video_graph

    The command must run with the clips directory as its working directory
    when a text subtitle file is used, because the file is referred to by
    name only (a full path would need escaping inside the filter graph).
    """
    if mode != "precise" and (layout != "horizontal" or subtitle):
        raise ValueError("Vertical clips and burned-in subtitles need precise mode")
    _check_subtitle_file(subtitle)
    cmd = list(_FFMPEG)

    if http_headers:
        # Input options must come before -i. rw_timeout (microseconds)
        # stops ffmpeg hanging forever if Jellyfin stops responding.
        cmd += ["-headers", http_headers, "-rw_timeout", "30000000"]

    # Input seeking (-ss before -i) is fast. When re-encoding, ffmpeg still
    # decodes from the previous keyframe and drops frames before the start,
    # so the cut is frame accurate.
    cmd += ["-ss", f"{start:.3f}", "-i", str(source), "-t", f"{duration:.3f}"]

    if mode == "precise":
        # The filter graph reads the video (and picture subtitle) streams
        # itself; its output pad is mapped like a stream.
        cmd += ["-filter_complex", _video_graph(video, max_height, layout, fit, crop_x, crop_width, subtitle), "-map", "[vout]"]
    else:
        cmd += ["-map", f"0:{video['Index']}"]
    if audio is not None:
        cmd += ["-map", f"0:{audio['Index']}"]

    # Drop source tags and chapters; chapter marks outside the clip are confusing.
    cmd += ["-map_metadata", "-1", "-map_chapters", "-1"]

    if mode == "precise":
        cmd += _precise_codec_args(video, audio, preset, crf)
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

    return cmd + _output_args(plan, output_path)


def build_multipart_command(
    source,
    parts,
    video,
    audio,
    max_height,
    output_path,
    plan,
    preset="veryfast",
    crf=20,
    http_headers=None,
    layout="horizontal",
    fit="crop",
    subtitle=None,
):
    """Build the ffmpeg argument list for a clip spliced from several parts.

    parts lists the parts in the order they are played, each a dict with
    "start" and "end" in seconds and the "crop_x" and "crop_width" of a
    vertical crop (see VERTICAL_FITS), so every part can be framed on its
    own. The other arguments are as for build_ffmpeg_command.

    Multi-part clips are always re-encoded (precise mode): stream copy can
    only cut on keyframes, which would show unwanted frames at every join.
    The source is opened once per part, each seeking straight to its part,
    and the filter graph joins them (see _multipart_graph).
    """
    _check_subtitle_file(subtitle)
    cmd = list(_FFMPEG)
    for part in parts:
        if http_headers:
            # As for a single clip, plus reconnecting: the inputs of later
            # parts sit idle while the earlier parts are encoded, and the
            # server may drop a connection that is not being read.
            cmd += ["-headers", http_headers, "-rw_timeout", "30000000", "-reconnect", "1", "-reconnect_delay_max", "5"]
        # -t before -i limits how much of this input is read.
        cmd += ["-ss", f"{part['start']:.3f}", "-t", f"{part['end'] - part['start']:.3f}", "-i", str(source)]

    cmd += ["-filter_complex", _multipart_graph(video, audio, max_height, layout, fit, parts, subtitle), "-map", "[vout]"]
    if audio is not None:
        cmd += ["-map", "[aout]"]
    cmd += ["-map_metadata", "-1", "-map_chapters", "-1"]
    cmd += _precise_codec_args(video, audio, preset, crf)
    return cmd + _output_args(plan, output_path)


# Start of every command. nice keeps Jellyfin playback responsive while a
# clip is being encoded.
_FFMPEG = ("nice", "-n", "10", "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y")


def _check_subtitle_file(subtitle):
    if subtitle and subtitle["kind"] == "text" and not re.fullmatch(r"[\w.-]+", subtitle["file"]):
        raise ValueError("The subtitle file name must not need escaping")


def _precise_codec_args(video, audio, preset, crf):
    """Encoder settings for precise mode: H.264 video and stereo AAC audio."""
    args = ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high"]
    if (video.get("VideoRange") or "").upper() == "HDR":
        # Tag the tonemapped output so players do not guess the colors.
        args += ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
    if audio is not None:
        args += ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
    return args


def _output_args(plan, output_path):
    args = []
    if plan["format"] == "mp4":
        # Put the index at the front so the clip can start playing while downloading.
        args += ["-movflags", "+faststart"]
    # Machine readable progress on stdout, no interactive stats on stderr.
    return args + ["-progress", "pipe:1", "-nostats", "-f", plan["format"], str(output_path)]
