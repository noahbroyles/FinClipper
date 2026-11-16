"""Unit tests for finclipper.media and the playlist rewriting in finclipper.api.

Run with: python -m unittest discover -s tests
"""

import json
import shutil
import tempfile
import unittest
import subprocess
from pathlib import Path
from finclipper import media
from finclipper.config import parse_path_map

HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


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
