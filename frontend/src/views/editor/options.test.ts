import { describe, expect, test } from "bun:test";
import type { Source } from "../../types";
import {
    clipRequest,
    describeOutput,
    heightChoices,
    initialOptions,
    needsPrecise,
    optionsReducer,
    type ClipOptions,
} from "./options";

const STYLES = [
    { id: "classic", label: "Classic" },
    { id: "box", label: "Box" },
];

function source(values: Partial<Source> = {}): Source {
    return {
        id: "src1",
        name: "1080p",
        container: "mkv",
        duration: 600,
        video: { index: 0, codec: "h264", width: 1920, height: 1080, range: "SDR", title: "1080p H264" },
        audio: [
            { index: 1, title: "English", codec: "aac", channels: 2, language: "eng" },
            { index: 2, title: "Commentary", codec: "dts", channels: 6, language: "eng" },
        ],
        default_audio: 1,
        subtitles: [
            { index: 3, title: "English", kind: "text" },
            { index: 4, title: "English (PGS)", kind: "bitmap" },
        ],
        problem: null,
        ...values,
    };
}

function set(state: ClipOptions, values: Partial<ClipOptions>): ClipOptions {
    return optionsReducer(state, { type: "set", values });
}

describe("initialOptions", () => {
    test("starts as a fast, horizontal clip with the default audio and first style", () => {
        const options = initialOptions(source(), STYLES);
        expect(options).toMatchObject({
            sourceIndex: 0,
            audioIndex: 1,
            subtitleIndex: null,
            subtitleStyle: "classic",
            layout: "horizontal",
            mode: "fast",
            maxHeight: 0,
        });
    });

    test("has no audio when the video has none", () => {
        expect(initialOptions(source({ audio: [], default_audio: null }), STYLES).audioIndex).toBe(-1);
    });
});

describe("optionsReducer", () => {
    const initial = initialOptions(source(), STYLES);

    test("subtitles and vertical clips force Precise mode", () => {
        expect(set(initial, { subtitleIndex: 3 }).mode).toBe("precise");
        expect(set(initial, { layout: "vertical" }).mode).toBe("precise");
        // Fast cannot be chosen while one of them is on.
        expect(set(set(initial, { layout: "vertical" }), { mode: "fast" }).mode).toBe("precise");
    });

    test("Precise stays chosen after the reason for it goes away", () => {
        const withSubtitles = set(initial, { subtitleIndex: 3 });
        const without = set(withSubtitles, { subtitleIndex: null });
        expect(needsPrecise(without)).toBe(false);
        expect(without.mode).toBe("precise");
        expect(set(without, { mode: "fast" }).mode).toBe("fast");
    });

    test("changing the shape resets the resolution to that shape's default", () => {
        const scaled = set(set(initial, { mode: "precise" }), { maxHeight: 720 });
        const vertical = set(scaled, { layout: "vertical" });
        expect(vertical.maxHeight).toBe(1920);
        expect(set(vertical, { maxHeight: 1280 }).maxHeight).toBe(1280);
        expect(set(vertical, { layout: "horizontal" }).maxHeight).toBe(0);
    });

    test("other changes leave the resolution alone", () => {
        const scaled = set(set(initial, { mode: "precise" }), { maxHeight: 720 });
        expect(set(scaled, { name: "My clip" }).maxHeight).toBe(720);
    });

    test("another version resets audio, subtitles and resolution but keeps the rest", () => {
        const before = set(set(initial, { subtitleIndex: 3, audioIndex: 2, name: "My clip" }), { maxHeight: 720 });
        const other = source({ id: "src2", default_audio: 5 });
        const after = optionsReducer(before, { type: "source", index: 1, source: other });
        expect(after).toMatchObject({
            sourceIndex: 1,
            audioIndex: 5,
            subtitleIndex: null,
            maxHeight: 0,
            name: "My clip",
            mode: "precise",
        });
    });
});

describe("heightChoices", () => {
    test("horizontal: the original and every smaller height", () => {
        expect(heightChoices(source(), "horizontal")).toEqual([
            { value: 0, label: "Original (1080p)" },
            { value: 720, label: "720p" },
            { value: 480, label: "480p" },
            { value: 360, label: "360p" },
        ]);
    });

    test("horizontal: every height when the source height is unknown", () => {
        const choices = heightChoices(source({ video: null }), "horizontal");
        expect(choices.map((choice) => choice.value)).toEqual([0, 2160, 1440, 1080, 720, 480, 360]);
        expect(choices[0]?.label).toBe("Original");
    });

    test("vertical: the phone sizes", () => {
        expect(heightChoices(source(), "vertical")).toEqual([
            { value: 1920, label: "1080 × 1920" },
            { value: 1280, label: "720 × 1280" },
            { value: 960, label: "540 × 960" },
        ]);
    });
});

describe("describeOutput", () => {
    const initial = initialOptions(source(), STYLES);

    test("fast: codecs that fit in MP4 are copied", () => {
        expect(describeOutput(source(), initial)).toBe("Output: original h264 video and aac audio, in an MP4 file.");
    });

    test("fast: other audio is converted", () => {
        expect(describeOutput(source(), set(initial, { audioIndex: 2 }))).toBe(
            "Output: original h264 video, dts audio converted to AAC, in an MP4 file.",
        );
    });

    test("fast: no audio", () => {
        expect(describeOutput(source(), set(initial, { audioIndex: -1 }))).toBe(
            "Output: original h264 video, in an MP4 file.",
        );
    });

    test("fast: video that does not fit in MP4 goes into MKV", () => {
        const vc1 = source({ video: { index: 0, codec: "VC1", width: 1920, height: 1080, range: null, title: null } });
        expect(describeOutput(vc1, initial)).toBe(
            "Output: original vc1 and aac audio in an MKV file (this codec does not fit in MP4). It will start on a keyframe.",
        );
    });

    test("precise", () => {
        expect(describeOutput(source(), set(initial, { mode: "precise" }))).toBe(
            "Output: H.264 video with stereo AAC audio in an MP4 file.",
        );
        expect(describeOutput(source(), set(initial, { layout: "vertical", subtitleIndex: 4 }))).toBe(
            "Output: vertical (9:16) H.264 video with stereo AAC audio in an MP4 file, with the subtitles burned in.",
        );
    });
});

describe("clipRequest", () => {
    const initial = initialOptions(source(), STYLES);

    test("fast mode never scales", () => {
        const options = set(set(initial, { mode: "precise" }), { maxHeight: 720 });
        expect(clipRequest("item1", source(), options, 1, 2).max_height).toBe(720);
        expect(clipRequest("item1", source(), set(options, { mode: "fast" }), 1, 2).max_height).toBe(0);
    });

    test("sends every choice", () => {
        const options = set(initial, { layout: "vertical", fit: "blur", cropX: 0.25, subtitleIndex: 3, name: "Clip" });
        expect(clipRequest("item1", source(), options, 12.5, 20)).toEqual({
            item_id: "item1",
            source_id: "src1",
            start: 12.5,
            end: 20,
            mode: "precise",
            audio_index: 1,
            max_height: 1920,
            name: "Clip",
            layout: "vertical",
            fit: "blur",
            crop_x: 0.25,
            subtitle_index: 3,
            subtitle_style: "classic",
        });
    });
});
