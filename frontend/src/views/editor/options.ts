// The choices in the editor's Options panel and what follows from them.
// They apply to the whole clip; what differs per part is in parts.ts.
// Pure functions, so they can be unit tested with "bun test".
import { HORIZONTAL_HEIGHTS, MP4_AUDIO_COPY, MP4_VIDEO_COPY, VERTICAL_SIZES } from "../../constants";
import type { ClipFit, ClipLayout, ClipMode, Source, SubtitleStyle, SubtitleTrack } from "../../types";
import type { Part } from "./parts";

export interface ClipOptions {
    // Which version of the video, as an index into the usable sources.
    sourceIndex: number;
    // Stream index of the audio track, or -1 for no audio.
    audioIndex: number;
    // Stream index of the subtitles to burn in, or null for none.
    subtitleIndex: number | null;
    subtitleStyle: string;
    // Shape of the clip: like the source, or vertical (9:16).
    layout: ClipLayout;
    // How the picture fills a vertical frame.
    fit: ClipFit;
    // Whether the clip is spliced from more than one part. Kept here, in
    // step with the parts by the editor, because it decides the mode.
    multiPart: boolean;
    mode: ClipMode;
    // Precise mode only. Horizontal: the largest height, 0 for the
    // original. Vertical: the output height (see VERTICAL_SIZES).
    maxHeight: number;
    // Optional clip name. Left empty, the clip is named after the video.
    name: string;
}

export type OptionsAction =
    // Another version was chosen.
    | { type: "source"; index: number; source: Source }
    // Any other change.
    | { type: "set"; values: Partial<Omit<ClipOptions, "sourceIndex">> };

function defaultHeight(layout: ClipLayout): number {
    return layout === "vertical" ? VERTICAL_SIZES[0]![0] : 0;
}

export function initialOptions(source: Source, styles: SubtitleStyle[]): ClipOptions {
    return {
        sourceIndex: 0,
        audioIndex: source.default_audio ?? -1,
        subtitleIndex: null,
        subtitleStyle: styles[0]?.id ?? "",
        layout: "horizontal",
        fit: "crop",
        multiPart: false,
        mode: "fast",
        maxHeight: 0,
        name: "",
    };
}

// Fast mode copies the video untouched, so it can neither burn in
// subtitles nor change the shape, and it can only cut on keyframes, which
// would show unwanted frames where parts are joined. Those choices need
// Precise mode.
export function needsPrecise(options: ClipOptions): boolean {
    return options.layout === "vertical" || options.subtitleIndex !== null || options.multiPart;
}

export function optionsReducer(state: ClipOptions, action: OptionsAction): ClipOptions {
    let next: ClipOptions;
    if (action.type === "source") {
        next = {
            ...state,
            sourceIndex: action.index,
            audioIndex: action.source.default_audio ?? -1,
            // Stream indexes differ between versions, so the subtitle
            // choice goes back to none, and the resolution to the default
            // because the choices depend on the version's height.
            subtitleIndex: null,
            maxHeight: defaultHeight(state.layout),
        };
    } else {
        next = { ...state, ...action.values };
        // Each shape has its own list of resolutions.
        if (next.layout !== state.layout) next.maxHeight = defaultHeight(next.layout);
    }
    if (needsPrecise(next)) next.mode = "precise";
    return next;
}

export function selectedSubtitle(source: Source, options: ClipOptions): SubtitleTrack | null {
    return source.subtitles.find((track) => track.index === options.subtitleIndex) ?? null;
}

// Resolutions offered in Precise mode. Horizontal clips get a maximum
// height (never above the source); vertical clips fixed phone screen sizes.
export function heightChoices(source: Source, layout: ClipLayout): Array<{ value: number; label: string }> {
    if (layout === "vertical") {
        return VERTICAL_SIZES.map(([height, width]) => ({ value: height, label: `${width} × ${height}` }));
    }
    const sourceHeight = source.video?.height || 0;
    const choices = [{ value: 0, label: sourceHeight ? `Original (${sourceHeight}p)` : "Original" }];
    for (const height of HORIZONTAL_HEIGHTS) {
        if (!sourceHeight || height < sourceHeight) choices.push({ value: height, label: `${height}p` });
    }
    return choices;
}

// Describe the output before it is made (mirrors plan_output in media.py).
export function describeOutput(source: Source, options: ClipOptions): string {
    if (options.mode === "precise") {
        const shape = options.layout === "vertical" ? "vertical (9:16) " : "";
        const subtitles = selectedSubtitle(source, options) ? ", with the subtitles burned in" : "";
        return `Output: ${shape}H.264 video with stereo AAC audio in an MP4 file${subtitles}.`;
    }
    const videoCodec = (source.video?.codec || "").toLowerCase();
    const audioTrack = source.audio.find((track) => track.index === options.audioIndex);
    const audioCodec = (audioTrack?.codec || "").toLowerCase();
    if (MP4_VIDEO_COPY.has(videoCodec)) {
        let text = `Output: original ${videoCodec} video`;
        if (audioTrack) {
            text += MP4_AUDIO_COPY.has(audioCodec) ? ` and ${audioCodec} audio` : `, ${audioCodec} audio converted to AAC`;
        }
        return `${text}, in an MP4 file.`;
    }
    const audio = audioTrack ? ` and ${audioCodec} audio` : "";
    return `Output: original ${videoCodec || "video"}${audio} in an MKV file (this codec does not fit in MP4). It will start on a keyframe.`;
}

// The body of the "create clip" request for these choices and parts.
export function clipRequest(itemId: string, source: Source, options: ClipOptions, parts: Part[]) {
    return {
        item_id: itemId,
        source_id: source.id,
        parts: parts.map((part) => ({
            start: part.start,
            end: part.end,
            crop_x: part.cropX,
            crop_width: part.cropWidth,
        })),
        mode: options.mode,
        audio_index: options.audioIndex,
        max_height: options.mode === "precise" ? options.maxHeight : 0,
        name: options.name,
        layout: options.layout,
        fit: options.fit,
        subtitle_index: options.subtitleIndex,
        subtitle_style: options.subtitleStyle,
    };
}
