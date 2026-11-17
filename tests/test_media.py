"""Unit tests for finclipper.media and the playlist rewriting in finclipper.api.

Run with: python -m unittest discover -s tests
"""

import json
import shutil
import struct
import tempfile
import unittest
import subprocess
from pathlib import Path
from finclipper import media
from finclipper.config import parse_path_map

HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def make_pgs(path, width, height, cues):
    """Write a minimal Blu-ray PGS subtitle file (.sup) for tests.

    Each cue is (start, end, (x, y, w, h)) and shows a white rectangle.
    ffmpeg cannot encode PGS, so the segments are written by hand: a display
    set that shows the rectangle (composition, window, palette, object,
    end), then one with no objects that clears it. The file starts with an
    empty display set at 0 s, because ffmpeg shifts every input file so its
    first timestamp is 0, which would move the first cue.
    """

    def segment(seconds, kind, payload):
        # "PG", PTS and DTS in 90 kHz units, segment type, payload size.
        return b"PG" + struct.pack(">IIBH", round(seconds * 90000), 0, kind, len(payload)) + payload

    def composition(number, state, rect):
        objects = struct.pack(">HBBHH", 0, 0, 0, rect[0], rect[1]) if state else b""
        # Size, frame rate code, number, state, palette update, palette id, object count.
        return struct.pack(">HHBHBBBB", width, height, 0x10, number, state, 0, 0, 1 if state else 0) + objects

    empty_window = struct.pack(">BBHHHH", 1, 0, 0, 0, width, height)
    data = segment(0, 0x16, composition(0, 0x00, None)) + segment(0, 0x17, empty_window) + segment(0, 0x80, b"")
    for number, (start, end, rect) in enumerate(cues, start=1):
        x, y, w, h = rect
        window = struct.pack(">BBHHHH", 1, 0, x, y, w, h)
        # One palette entry: index 1 is opaque white (Y, Cr, Cb, alpha).
        palette = struct.pack(">BB", 0, 0) + bytes([1, 235, 128, 128, 255])
        # Run-length data: per line, a run of w pixels of colour 1, then end of line.
        line = bytes([0, 0xC0 | (w >> 8), w & 0xFF, 1, 0, 0])
        bitmap = struct.pack(">HH", w, h) + line * h
        obj = struct.pack(">HBB", 0, 0, 0xC0) + len(bitmap).to_bytes(3, "big") + bitmap
        data += segment(start, 0x16, composition(number * 2, 0x80, rect))
        data += segment(start, 0x17, window) + segment(start, 0x14, palette)
        data += segment(start, 0x15, obj) + segment(start, 0x80, b"")
        data += segment(end, 0x16, composition(number * 2 + 1, 0x00, rect))
        data += segment(end, 0x17, window) + segment(end, 0x80, b"")
    Path(path).write_bytes(data)


class ParseTimestampTests(unittest.TestCase):
    def test_valid_values(self):
        cases = {
            "0": 0.0,
            "5": 5.0,
            "5.25": 5.25,
            "1:05": 65.0,
            "90:00": 5400.0,
            "01:02:03": 3723.0,
            "01:02:03.456": 3723.456,
            " 00:00:10.5 ": 10.5,
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertAlmostEqual(media.parse_timestamp(text), expected)

    def test_numbers(self):
        self.assertEqual(media.parse_timestamp(12), 12.0)
        self.assertEqual(media.parse_timestamp(12.5), 12.5)

    def test_invalid_values(self):
        for value in ["", "abc", "-1", "1:60", "1:61:00", "1:2:3:4", ".5", None, True, -3, float("nan"), float("inf"), [1]]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    media.parse_timestamp(value)

    def test_format_round_trip(self):
        for seconds in [0, 0.001, 59.999, 61.5, 3723.456, 86399.999]:
            with self.subTest(seconds=seconds):
                text = media.format_timestamp(seconds)
                self.assertAlmostEqual(media.parse_timestamp(text), seconds, places=3)

    def test_filename_format(self):
        self.assertEqual(media.format_timestamp(3723.456, ".", False), "01.02.03")


class TitleAndFilenameTests(unittest.TestCase):
    def test_episode_title(self):
        item = {"Type": "Episode", "Name": "Pilot", "SeriesName": "Show", "ParentIndexNumber": 1, "IndexNumber": 2}
        self.assertEqual(media.item_title(item), "Show - S01E02 - Pilot")

    def test_movie_title(self):
        self.assertEqual(media.item_title({"Type": "Movie", "Name": "Film", "ProductionYear": 1999}), "Film (1999)")
        # Unmatched movies may already carry the year in their name.
        self.assertEqual(media.item_title({"Type": "Movie", "Name": "Film (1999)", "ProductionYear": 1999}), "Film (1999)")

    def test_safe_filename(self):
        self.assertEqual(media.safe_filename('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j")
        self.assertEqual(media.safe_filename("  ..  "), "clip")
        self.assertEqual(len(media.safe_filename("x" * 500)), 150)

    def test_clip_filename(self):
        self.assertEqual(media.clip_filename("Film: Part 2", 61, 75.5, "mp4"), "Film_ Part 2 [00.01.01-00.01.15].mp4")

    def test_named_clip_filename(self):
        # A name replaces the title and the time range, and is made file safe.
        self.assertEqual(media.clip_filename("Film", 61, 75.5, "mkv", "Best bit: car/chase"), "Best bit_ car_chase.mkv")
        # An empty name falls back to the default.
        self.assertEqual(media.clip_filename("Film", 61, 75.5, "mp4", ""), "Film [00.01.01-00.01.15].mp4")

    def test_clean_clip_name(self):
        self.assertEqual(media.clean_clip_name(None), "")
        self.assertEqual(media.clean_clip_name("   "), "")
        # Control characters become spaces and whitespace collapses.
        self.assertEqual(media.clean_clip_name("  Car\tchase\n\nscene  "), "Car chase scene")
        self.assertEqual(media.clean_clip_name("x" * media.MAX_CLIP_NAME_LENGTH), "x" * media.MAX_CLIP_NAME_LENGTH)

    def test_clean_clip_name_rejects_bad_values(self):
        with self.assertRaises(ValueError):
            media.clean_clip_name("x" * (media.MAX_CLIP_NAME_LENGTH + 1))
        for value in (5, ["name"], {"name": "x"}, True):
            with self.assertRaises(ValueError):
                media.clean_clip_name(value)


class StreamSelectionTests(unittest.TestCase):
    source = {
        "Id": "abc",
        "DefaultAudioStreamIndex": 2,
        "MediaStreams": [
            {"Type": "Video", "Index": 0, "Codec": "mjpeg"},
            {"Type": "Video", "Index": 1, "Codec": "h264", "Width": 1920, "Height": 1080},
            {"Type": "Audio", "Index": 2, "Codec": "ac3", "Channels": 6},
            {"Type": "Audio", "Index": 3, "Codec": "aac", "Channels": 2, "IsDefault": True},
            {"Type": "Audio", "Index": 9, "Codec": "aac", "IsExternal": True},
            {"Type": "Subtitle", "Index": 4, "Codec": "subrip"},
        ],
    }

    def test_skips_cover_art(self):
        self.assertEqual([s["Index"] for s in media.video_streams(self.source)], [1])

    def test_skips_external_audio(self):
        self.assertEqual([s["Index"] for s in media.audio_streams(self.source)], [2, 3])

    def test_default_audio_prefers_jellyfin_default(self):
        self.assertEqual(media.default_audio_index(self.source), 2)

    def test_default_audio_falls_back_to_flag(self):
        source = dict(self.source, DefaultAudioStreamIndex=9)
        self.assertEqual(media.default_audio_index(source), 3)

    def test_disc_images_rejected(self):
        self.assertIsNotNone(media.source_problem(dict(self.source, VideoType="BluRay")))
        self.assertIsNone(media.source_problem(dict(self.source, VideoType="VideoFile")))


class SubtitleTests(unittest.TestCase):
    def test_subtitle_kinds(self):
        self.assertEqual(media.subtitle_kind({"Codec": "PGSSUB"}), "bitmap")
        self.assertEqual(media.subtitle_kind({"Codec": "dvdsub"}), "bitmap")
        # Picture subtitles must be inside the video file for ffmpeg to read.
        self.assertIsNone(media.subtitle_kind({"Codec": "PGSSUB", "IsExternal": True}))
        self.assertEqual(media.subtitle_kind({"Codec": "subrip", "IsTextSubtitleStream": True}), "text")
        self.assertEqual(media.subtitle_kind({"Codec": "ass", "IsTextSubtitleStream": True, "IsExternal": True}), "text")
        self.assertIsNone(media.subtitle_kind({"Codec": "eia_608", "IsTextSubtitleStream": False}))

    def test_subtitle_streams_in_summary(self):
        source = {
            "MediaStreams": [
                {"Type": "Video", "Index": 0, "Codec": "h264"},
                {"Type": "Subtitle", "Index": 2, "Codec": "subrip", "IsTextSubtitleStream": True, "DisplayTitle": "English"},
                {"Type": "Subtitle", "Index": 3, "Codec": "PGSSUB", "Language": "jpn"},
                {"Type": "Subtitle", "Index": 4, "Codec": "PGSSUB", "IsExternal": True},
            ]
        }
        self.assertEqual(
            media.summarize_source(source)["subtitles"],
            [{"index": 2, "title": "English", "kind": "text"}, {"index": 3, "title": "jpn", "kind": "bitmap"}],
        )

    def test_parse_srt(self):
        text = (
            "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\nthere\r\n\r\n"
            "2\n00:00:03.5 --> 00:00:04.25\nShort millis\n\n"
            "3\n00:00:05,000 --> 00:00:06,000\n\n"
            "4\n00:00:08,000 --> 00:00:07,000\nEnds before it starts\n"
        )
        self.assertEqual(media.parse_srt(text), [(1.0, 2.5, ["Hello", "there"]), (3.5, 4.25, ["Short millis"])])

    def test_build_ass_trims_and_shifts(self):
        srt = (
            "1\n00:00:01,000 --> 00:00:02,000\nBefore the clip\n\n"
            "2\n00:00:09,000 --> 00:00:11,000\nAlready showing\n\n"
            "3\n00:00:12,000 --> 00:00:13,500\n<i>Inside</i> {laughs} {\\an8}<font color=red>top</font>\n\n"
            "4\n00:00:19,000 --> 00:00:25,000\nRuns past the end\n\n"
            "5\n00:00:30,000 --> 00:00:31,000\nAfter the clip\n"
        )
        ass = media.build_ass(srt, 10, 20, "classic", "horizontal")
        events = [line for line in ass.splitlines() if line.startswith("Dialogue:")]
        self.assertEqual(events, [
            "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Already showing",
            "Dialogue: 0,0:00:02.00,0:00:03.50,Default,,0,0,0,,{\\i1}Inside{\\i0} (laughs) {\\an8}top",
            "Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,Runs past the end",
        ])
        self.assertIn("PlayResY: 1080", ass)
        self.assertIn("Style: Default,Liberation Sans,56,", ass)

    def test_build_ass_vertical_canvas_and_line_breaks(self):
        ass = media.build_ass("1\n00:00:00,000 --> 00:00:01,000\nOne\nTwo\n", 0, 5, "boxed", "vertical")
        self.assertIn("PlayResX: 1080", ass)
        self.assertIn("PlayResY: 1920", ass)
        self.assertIn(",,One\\NTwo", ass)
        # Box padding grows with the font size on the vertical canvas.
        style = next(line for line in ass.splitlines() if line.startswith("Style:")).split(",")
        self.assertEqual((style[1], style[15], style[16]), ("DejaVu Sans", "3", "11.8"))


class PathMapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "movies").mkdir()
        self.file = self.tmp / "movies" / "Film (2000).mkv"
        self.file.write_bytes(b"x")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_parse_sorts_longest_first(self):
        mapping = parse_path_map("/a=/x, /a/b/=/y/")
        self.assertEqual(mapping, [("/a/b", "/y"), ("/a", "/x")])

    def test_parse_rejects_garbage(self):
        with self.assertRaises(ValueError):
            parse_path_map("/only-one-side")

    def test_mapping(self):
        mapping = parse_path_map(f"/data/media={self.tmp}")
        self.assertEqual(media.resolve_local_path("/data/media/movies/Film (2000).mkv", mapping), self.file)

    def test_prefix_must_end_at_separator(self):
        # "/data/media2" must not match the "/data/media" prefix.
        mapping = parse_path_map(f"/data/media={self.tmp}")
        self.assertIsNone(media.resolve_local_path("/data/media2/movies/Film (2000).mkv", mapping))

    def test_identity_fallback(self):
        self.assertEqual(media.resolve_local_path(str(self.file), []), self.file)

    def test_windows_paths(self):
        mapping = parse_path_map(f"D:\\Media={self.tmp}")
        self.assertEqual(media.resolve_local_path("D:\\Media\\movies\\Film (2000).mkv", mapping), self.file)

    def test_urls_and_missing_files(self):
        self.assertIsNone(media.resolve_local_path("http://example/x.mkv", []))
        self.assertIsNone(media.resolve_local_path("/does/not/exist.mkv", []))
        self.assertIsNone(media.resolve_local_path(None, []))


class PlanAndCommandTests(unittest.TestCase):
    video = {"Index": 0, "Codec": "hevc"}
    audio_ok = {"Index": 1, "Codec": "eac3", "Channels": 6}
    audio_bad = {"Index": 1, "Codec": "truehd", "Channels": 8}

    def test_plan_copy_mp4(self):
        plan = media.plan_output("fast", self.video, self.audio_ok)
        self.assertEqual((plan["format"], plan["copy_audio"]), ("mp4", True))

    def test_plan_converts_unsupported_audio(self):
        plan = media.plan_output("fast", self.video, self.audio_bad)
        self.assertEqual((plan["format"], plan["copy_audio"]), ("mp4", False))

    def test_plan_mkv_for_odd_video(self):
        plan = media.plan_output("fast", {"Index": 0, "Codec": "vc1"}, self.audio_bad)
        self.assertEqual((plan["format"], plan["copy_audio"]), ("matroska", True))

    def test_fast_command(self):
        plan = media.plan_output("fast", self.video, self.audio_bad)
        cmd = media.build_ffmpeg_command("/m/in.mkv", 12.5, 30, self.video, self.audio_bad, "fast", 0, "/o/x.part", plan)
        joined = " ".join(cmd)
        self.assertIn("-ss 12.500 -i /m/in.mkv -t 30.000", joined)
        self.assertIn("-map 0:0 -map 0:1", joined)
        self.assertIn("-c:v copy -tag:v hvc1", joined)
        self.assertIn("-c:a aac -b:a 384k", joined)
        self.assertNotIn("avoid_negative_ts", joined)
        self.assertEqual(cmd[-3:], ["-f", "mp4", "/o/x.part"])

    def test_layout_and_subtitles_need_precise_mode(self):
        plan = media.plan_output("fast", self.video, None)
        with self.assertRaises(ValueError):
            media.build_ffmpeg_command("/m/in.mkv", 0, 5, self.video, None, "fast", 0, "/o/x.part", plan, layout="vertical")
        with self.assertRaises(ValueError):
            media.build_ffmpeg_command(
                "/m/in.mkv", 0, 5, self.video, None, "fast", 0, "/o/x.part", plan, subtitle={"kind": "bitmap", "index": 2}
            )

    def test_vertical_crop_graph(self):
        plan = media.plan_output("precise", self.video, None)
        cmd = media.build_ffmpeg_command(
            "/m/in.mkv", 0, 5, self.video, None, "precise", 1280, "/o/x.part", plan, layout="vertical", fit="crop", crop_x=0.25
        )
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertIn(":x='(iw-ow)*0.2500'", graph)
        # The narrowest crop by default: nothing is added to the 9:16 width.
        self.assertIn("crop=w='trunc((min(iw,ih*9/16)+(iw-min(iw,ih*9/16))*0.0000)/2)*2'", graph)
        self.assertIn("scale=w=720:h='min(1280,round(720*ih/iw/2)*2)'", graph)
        self.assertIn("pad=720:1280:0:(oh-ih)/2:color=black", graph)
        self.assertTrue(graph.endswith("[vout]"))
        self.assertEqual(cmd[cmd.index("[vout]") - 1], "-map")

    def test_vertical_crop_width(self):
        plan = media.plan_output("precise", self.video, None)
        cmd = media.build_ffmpeg_command(
            "/m/in.mkv", 0, 5, self.video, None, "precise", 1280, "/o/x.part", plan,
            layout="vertical", fit="crop", crop_x=0.5, crop_width=0.35,
        )
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertIn("(iw-min(iw,ih*9/16))*0.3500", graph)

    def test_text_subtitle_file_must_be_a_plain_name(self):
        plan = media.plan_output("precise", self.video, None)
        for name in ("/data/clips/x.ass", "a:b.ass", "x'.ass", "a,b.ass"):
            with self.assertRaises(ValueError):
                media.build_ffmpeg_command(
                    "/m/in.mkv", 0, 5, self.video, None, "precise", 0, "/o/x.part", plan,
                    subtitle={"kind": "text", "file": name},
                )

    def test_bitmap_subtitles_read_from_input(self):
        plan = media.plan_output("precise", self.video, None)
        video = dict(self.video, Width=1920)
        cmd = media.build_ffmpeg_command(
            "/m/in.mkv", 0, 5, video, None, "precise", 0, "/o/x.part", plan, subtitle={"kind": "bitmap", "index": 3}
        )
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertIn("[0:3]scale=w=1920:h=-2[subs]", graph)
        self.assertIn("overlay=x=(W-w)/2:y=H-h", graph)

    def test_http_headers_come_before_input(self):
        plan = media.plan_output("precise", self.video, None)
        cmd = media.build_ffmpeg_command(
            "http://jf/Videos/x/stream", 0, 5, self.video, None, "precise", 720, "/o/x.part", plan, http_headers="Authorization: t\r\n"
        )
        self.assertLess(cmd.index("-headers"), cmd.index("-i"))
        self.assertNotIn("-c:a", cmd)


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg is not installed")
class FfmpegIntegrationTests(unittest.TestCase):
    """Run the generated commands against a synthetic video."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.src = cls.tmp / "src.mkv"
        # 20 s, 25 fps, keyframe every 5 s, 5.1 AC-3 audio.
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=20",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
                "-c:v", "libx264", "-g", "125", "-keyint_min", "125", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
                "-c:a", "ac3", "-ac", "6", str(cls.src),
            ],
            check=True,
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def probe(self, path):
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration,format_name:stream=codec_name,codec_type,width,height,channels",
             "-of", "json", str(path)],
            check=True, capture_output=True, text=True,
        ).stdout
        return json.loads(out)

    def run_clip(self, mode, max_height, video, audio, name, extra_video=None):
        video = dict(video, **(extra_video or {}))
        plan = media.plan_output(mode, video, audio)
        out = self.tmp / name
        cmd = media.build_ffmpeg_command(self.src, 6.0, 4.0, video, audio, mode, max_height, out, plan)
        result = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        # -progress output must report the end position.
        self.assertIn("progress=end", result.stdout)
        return self.probe(out)

    def test_fast_copy(self):
        info = self.run_clip("fast", 0, {"Index": 0, "Codec": "h264"}, {"Index": 1, "Codec": "ac3", "Channels": 6}, "fast.part")
        self.assertIn("mp4", info["format"]["format_name"])
        codecs = sorted(s["codec_name"] for s in info["streams"])
        self.assertEqual(codecs, ["ac3", "h264"])
        # The edit list hides the keyframe pre-roll, so the length is close to 4 s.
        self.assertAlmostEqual(float(info["format"]["duration"]), 4.0, delta=0.3)

    def test_precise_scaled(self):
        info = self.run_clip("precise", 240, {"Index": 0, "Codec": "h264"}, {"Index": 1, "Codec": "ac3", "Channels": 6}, "precise.part")
        video = next(s for s in info["streams"] if s["codec_type"] == "video")
        audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
        self.assertEqual((video["codec_name"], video["height"], video["width"] % 2), ("h264", 240, 0))
        self.assertEqual((audio["codec_name"], audio["channels"]), ("aac", 2))
        self.assertAlmostEqual(float(info["format"]["duration"]), 4.0, delta=0.1)

    def test_precise_never_upscales(self):
        info = self.run_clip("precise", 1080, {"Index": 0, "Codec": "h264"}, None, "noupscale.part")
        video = info["streams"][0]
        self.assertEqual((video["height"], len(info["streams"])), (360, 1))

    def test_precise_hdr_tonemap_and_deinterlace_filters_parse(self):
        # The source is SDR, but this proves the filter chain is valid and
        # that zscale/tonemap/yadif exist in this ffmpeg build.
        info = self.run_clip(
            "precise", 0, {"Index": 0, "Codec": "h264"}, None, "hdr.part",
            extra_video={"VideoRange": "HDR", "VideoRangeType": "HDR10", "IsInterlaced": True},
        )
        self.assertEqual(info["streams"][0]["codec_name"], "h264")

    def test_mkv_fallback(self):
        info = self.run_clip("fast", 0, {"Index": 0, "Codec": "vc1"}, {"Index": 1, "Codec": "ac3"}, "mkv.part")
        self.assertIn("matroska", info["format"]["format_name"])


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg is not installed")
class LayoutAndSubtitleIntegrationTests(unittest.TestCase):
    """Vertical layouts and burned-in subtitles, run through ffmpeg.

    The source is plain grey, so any near-white pixels in the output must
    be subtitles. Both subtitle tracks show from 2 s to 3 s of the source,
    and clips start at 1.5 s, so they should appear 0.5 s to 1.5 s in.
    """

    video = {"Index": 0, "Codec": "h264", "Width": 640, "Height": 360}

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.src = cls.tmp / "grey.mkv"
        sup = cls.tmp / "subs.sup"
        # A white bar near the bottom of the 640x360 picture subtitle canvas.
        make_pgs(sup, 640, 360, [(2.0, 3.0, (160, 300, 320, 40))])
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "color=c=gray:size=640x360:rate=25:duration=6",
                "-i", str(sup), "-map", "0", "-map", "1",
                "-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-pix_fmt", "yuv420p",
                "-c:s", "copy", str(cls.src),
            ],
            check=True,
        )
        cls.srt = "1\n00:00:02,000 --> 00:00:03,000\nSUBTITLE TEXT HERE\n"

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def run_clip(self, name, layout="horizontal", fit="crop", max_height=0, subtitle=None, crop_width=0.0):
        plan = media.plan_output("precise", self.video, None)
        out = self.tmp / f"{name}.mp4"
        cmd = media.build_ffmpeg_command(
            self.src, 1.5, 2.5, self.video, None, "precise", max_height, out, plan,
            preset="ultrafast", layout=layout, fit=fit, subtitle=subtitle, crop_width=crop_width,
        )
        # The app runs ffmpeg in the clips directory; text subtitle files are
        # referred to by name relative to it.
        result = subprocess.run(cmd, cwd=self.tmp, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return out

    def size(self, path):
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio",
             "-of", "json", str(path)],
            check=True, capture_output=True, text=True,
        ).stdout
        stream = json.loads(out)["streams"][0]
        return stream["width"], stream["height"], stream.get("sample_aspect_ratio", "1:1")

    def bright_pixels(self, path, time, top=0.0, bottom=1.0):
        """Count near-white pixels between two heights (fractions of the frame) at a time."""
        width, height, _ = self.size(path)
        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", str(time), "-i", str(path), "-frames:v", "1",
             "-f", "rawvideo", "-pix_fmt", "gray", "-"],
            check=True, capture_output=True,
        ).stdout
        rows = raw[int(top * height) * width:int(bottom * height) * width]
        return sum(1 for value in rows if value > 200)

    def assert_shown_only_during_cue(self, path, top=0.0, bottom=1.0):
        self.assertEqual(self.bright_pixels(path, 0.2, top, bottom), 0)
        # Text is only about 19 px tall on a 360 px frame, and the thin serif
        # style has a few hundred white pixels; anything clearly above zero
        # shows the subtitle was drawn.
        self.assertGreater(self.bright_pixels(path, 1.0, top, bottom), 100)
        self.assertEqual(self.bright_pixels(path, 2.0, top, bottom), 0)

    def picture_rows(self, path, time=1.0):
        """First and last row of the frame that is not black, at a time."""
        width, height, _ = self.size(path)
        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", str(time), "-i", str(path), "-frames:v", "1",
             "-f", "rawvideo", "-pix_fmt", "gray", "-"],
            check=True, capture_output=True,
        ).stdout
        lit = [row for row in range(height) if sum(raw[row * width:(row + 1) * width]) / width > 60]
        return lit[0], lit[-1]

    def write_ass(self, name, layout, style="classic"):
        (self.tmp / name).write_text(media.build_ass(self.srt, 1.5, 4.0, style, layout), encoding="utf-8")
        return {"kind": "text", "file": name}

    def test_vertical_sizes(self):
        for fit in sorted(media.VERTICAL_FITS):
            with self.subTest(fit=fit):
                out = self.run_clip(f"vertical-{fit}", layout="vertical", fit=fit, max_height=960)
                self.assertEqual(self.size(out), (540, 960, "1:1"))

    def test_vertical_crop_width(self):
        # The 640x360 source in a 540x960 frame. The narrowest crop fills
        # the frame; wider crops are less tall, with black bars above and
        # below, down to the whole picture at 540x304.
        for crop_width, picture_height in ((0.0, 960), (0.5, 462), (1.0, 304)):
            with self.subTest(crop_width=crop_width):
                out = self.run_clip(f"crop-width-{crop_width}", "vertical", "crop", 960, crop_width=crop_width)
                self.assertEqual(self.size(out), (540, 960, "1:1"))
                first, last = self.picture_rows(out)
                # The picture is centred; allow a row or two of blending
                # where it meets the bars.
                self.assertAlmostEqual(first, (960 - picture_height) / 2, delta=2)
                self.assertAlmostEqual(last, (960 + picture_height) / 2 - 1, delta=2)

    def test_text_subtitles_horizontal(self):
        for style in media.SUBTITLE_STYLES:
            with self.subTest(style=style):
                out = self.run_clip(f"text-{style}", subtitle=self.write_ass(f"text-{style}.ass", "horizontal", style))
                self.assert_shown_only_during_cue(out, top=0.6)

    def test_text_subtitles_vertical(self):
        out = self.run_clip("text-vertical", "vertical", "blur", 960, self.write_ass("text-vertical.ass", "vertical"))
        # The vertical canvas puts the text about a fifth of the way up.
        self.assert_shown_only_during_cue(out, top=0.6, bottom=0.85)

    def test_bitmap_subtitles_horizontal(self):
        out = self.run_clip("bitmap", subtitle={"kind": "bitmap", "index": 1})
        # The white bar covers rows 300 to 340 of 360.
        self.assert_shown_only_during_cue(out, top=0.82, bottom=0.95)

    def test_bitmap_subtitles_vertical_crop(self):
        out = self.run_clip("bitmap-crop", "vertical", "crop", 960, {"kind": "bitmap", "index": 1})
        # The canvas is scaled to 540x304 with its bottom at 78% of 960, which
        # puts the bar at about rows 698 to 732: the whole bar, not cropped.
        self.assert_shown_only_during_cue(out, top=0.72, bottom=0.77)
        self.assertGreater(self.bright_pixels(out, 1.0, top=0.72, bottom=0.77), 270 * 30)


class PlaylistRewriteTests(unittest.TestCase):
    def test_strips_tokens(self):
        from finclipper.api import rewrite_playlist

        playlist = "\n".join([
            "#EXTM3U",
            '#EXT-X-MAP:URI="hls1/main/-1.mp4?ApiKey=secret&MediaSourceId=a"',
            "#EXTINF:6.0,",
            "hls1/main/0.ts?DeviceId=d&api_key=secret&PlaySessionId=p",
            '#EXT-X-IMAGE-STREAM-INF:URI="Trickplay/320/tiles.m3u8?MediaSourceId=a&ApiKey=secret"',
            "main.m3u8?VideoCodec=h264",
        ])
        rewritten = rewrite_playlist(playlist)
        self.assertNotIn("secret", rewritten)
        self.assertIn("hls1/main/0.ts?DeviceId=d&PlaySessionId=p", rewritten)
        self.assertIn('URI="hls1/main/-1.mp4?MediaSourceId=a"', rewritten)
        self.assertIn("main.m3u8?VideoCodec=h264", rewritten)

    def test_hls_path_allowlist(self):
        from finclipper.api import HLS_PATH_RE

        for good in ["master.m3u8", "main.m3u8", "hls1/main/0.ts", "hls1/main/-1.mp4", "hls1/abc_1/12.ts"]:
            self.assertTrue(HLS_PATH_RE.match(good), good)
        for bad in ["../Items", "hls1/main/0.ts/../../x", "stream", "master.m3u8/x", "Trickplay/320/tiles.m3u8", "hls1/main/0.exe"]:
            self.assertFalse(HLS_PATH_RE.match(bad), bad)


if __name__ == "__main__":
    unittest.main()
