import { describe, expect, test } from "bun:test";
import type { ClipSettings, ItemDetails, Job, Source } from "../../types";
import { editorStart } from "./reclip";

const STYLES = [
    { id: "classic", label: "Classic" },
    { id: "boxed", label: "Boxed" },
];

function source(values: Partial<Source> = {}): Source {
    return {
        id: "src1",
        name: "1080p",
        container: "mkv",
        duration: 600,
        video: { index: 0, codec: "h264", width: 1920, height: 1080, range: "SDR", title: "1080p" },
        audio: [
            { index: 1, title: "English", codec: "aac", channels: 2, language: "eng" },
            { index: 2, title: "French", codec: "aac", channels: 2, language: "fra" },
        ],
        default_audio: 1,
        subtitles: [{ index: 3, title: "English", kind: "text" }],
        problem: null,
        ...values,
    };
}

const item = { id: "item1", runtime: 600 } as ItemDetails;

function settings(values: Partial<ClipSettings> = {}): ClipSettings {
    return {
        source_id: "src2",
        mode: "precise",
        audio_index: 2,
        subtitle_index: 3,
        subtitle_style: "boxed",
        layout: "vertical",
        fit: "crop",
        max_height: 1280,
        parts: [
            { start: 50, end: 62.5, crop_x: 0.9, crop_width: 0.6 },
            { start: 10, end: 20, crop_x: 0.1, crop_width: 0 },
        ],
        ...values,
    };
}

function clip(values: Partial<Job> = {}): Job {
    return {
        id: "clip1",
        item_id: "item1",
        title: "Film",
        name: "Best bits",
        start: 10,
        end: 62.5,
        parts: [
            { start: 50, end: 62.5 },
            { start: 10, end: 20 },
        ],
        duration: 22.5,
        mode: "precise",
        description: "",
        filename: "Best bits.mp4",
        playable: true,
        settings: settings(),
        status: "done",
        public: false,
        phase: null,
        progress: 1,
        error: null,
        size: 1,
        created: 1,
        finished: 2,
        ...values,
    };
}

const sources = [source(), source({ id: "src2", name: "Alternate cut" })];

test("without a clip the editor starts with the defaults", () => {
    const start = editorStart(item, sources, STYLES, null);
    expect(start.options).toMatchObject({ sourceIndex: 0, mode: "fast", layout: "horizontal", name: "" });
    expect(start.parts.list).toEqual([{ id: 1, start: 0, end: 30, cropX: 0.5, cropWidth: 0.35 }]);
    expect(start.caveats).toEqual([]);
});

describe("re-clipping", () => {
    test("restores every choice and every part with its crop", () => {
        const start = editorStart(item, sources, STYLES, clip());
        expect(start.options).toEqual({
            sourceIndex: 1,
            audioIndex: 2,
            subtitleIndex: 3,
            subtitleStyle: "boxed",
            layout: "vertical",
            fit: "crop",
            multiPart: true,
            mode: "precise",
            maxHeight: 1280,
            name: "Best bits",
        });
        expect(start.parts).toEqual({
            list: [
                { id: 1, start: 50, end: 62.5, cropX: 0.9, cropWidth: 0.6 },
                { id: 2, start: 10, end: 20, cropX: 0.1, cropWidth: 0 },
            ],
            selected: 0,
            duration: 600,
        });
        expect(start.caveats).toEqual([]);
    });

    test("restores a plain fast clip without audio", () => {
        const plain = settings({
            source_id: "src1",
            mode: "fast",
            audio_index: -1,
            subtitle_index: null,
            layout: "horizontal",
            max_height: 0,
            parts: [{ start: 5, end: 9, crop_x: 0.5, crop_width: 0.35 }],
        });
        const start = editorStart(item, sources, STYLES, clip({ settings: plain, mode: "fast", name: "" }));
        expect(start.options).toMatchObject({ sourceIndex: 0, audioIndex: -1, subtitleIndex: null, mode: "fast", multiPart: false, name: "" });
        expect(start.caveats).toEqual([]);
    });

    test("says what is no longer there and falls back", () => {
        const changed = [source({ audio: [{ index: 1, title: "English", codec: "aac", channels: 2, language: "eng" }], subtitles: [] })];
        const start = editorStart(item, changed, STYLES, clip());
        expect(start.options).toMatchObject({ sourceIndex: 0, audioIndex: 1, subtitleIndex: null });
        expect(start.caveats).toHaveLength(3);
        expect(start.caveats.join(" ")).toContain("version");
        expect(start.caveats.join(" ")).toContain("audio track");
        expect(start.caveats.join(" ")).toContain("subtitles");
    });

    test("a resolution the version no longer offers goes back to the default", () => {
        const horizontal = settings({ layout: "horizontal", subtitle_index: null, max_height: 1440, parts: [{ start: 1, end: 5, crop_x: 0.5, crop_width: 0 }] });
        expect(editorStart(item, sources, STYLES, clip({ settings: horizontal })).options.maxHeight).toBe(0);
        const fine = { ...horizontal, max_height: 720 };
        expect(editorStart(item, sources, STYLES, clip({ settings: fine })).options.maxHeight).toBe(720);
    });

    test("a clip from before settings were kept restores its ranges, mode and name", () => {
        const start = editorStart(item, sources, STYLES, clip({ settings: null }));
        expect(start.parts.list).toEqual([
            { id: 1, start: 50, end: 62.5, cropX: 0.5, cropWidth: 0.35 },
            { id: 2, start: 10, end: 20, cropX: 0.5, cropWidth: 0.35 },
        ]);
        expect(start.options).toMatchObject({ sourceIndex: 0, layout: "horizontal", mode: "precise", multiPart: true, name: "Best bits" });
        expect(start.caveats).toHaveLength(1);
    });

    test("parts are pulled back inside a video that got shorter", () => {
        const short = [source({ id: "src2", duration: 55 })];
        const start = editorStart({ ...item, runtime: 55 }, short, STYLES, clip());
        expect(start.parts.list[0]).toMatchObject({ start: 50, end: 55 });
    });
});
