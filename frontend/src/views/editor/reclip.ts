// What the editor starts with: the defaults for a video, or the settings
// of an earlier clip ("Re-clip"). Pure functions, so they can be unit
// tested with "bun test".
import { DEFAULT_CROP_WIDTH } from "../../constants";
import type { ItemDetails, Job, Source, SubtitleStyle } from "../../types";
import { heightChoices, initialOptions, needsPrecise, type ClipOptions } from "./options";
import { initialParts, withVideoDuration, type ClipParts } from "./parts";

export interface EditorStart {
    options: ClipOptions;
    parts: ClipParts;
    // When re-clipping: what could not be restored, in sentences for the user.
    caveats: string[];
}

function videoDuration(item: ItemDetails, source: Source): number {
    return source.duration || item.runtime || 0;
}

// sources are the versions of the video that can be clipped (at least one).
// clip is the clip to copy the settings of, or null for a fresh start.
export function editorStart(item: ItemDetails, sources: Source[], styles: SubtitleStyle[], clip: Job | null): EditorStart {
    const first = sources[0]!;
    if (!clip) {
        return { options: initialOptions(first, styles), parts: initialParts(videoDuration(item, first)), caveats: [] };
    }

    const caveats: string[] = [];
    const settings = clip.settings;
    // Clips made before settings were kept only know their time ranges and mode.
    const ranges = settings
        ? settings.parts.map((part) => ({ start: part.start, end: part.end, cropX: part.crop_x, cropWidth: part.crop_width }))
        : clip.parts.map((part) => ({ start: part.start, end: part.end, cropX: 0.5, cropWidth: DEFAULT_CROP_WIDTH }));
    if (!settings) {
        caveats.push("This clip was made before FinClipper kept clip settings, so only its time range, mode and name are restored.");
    }

    let sourceIndex = settings ? sources.findIndex((source) => source.id === settings.source_id) : 0;
    if (sourceIndex < 0) {
        sourceIndex = 0;
        caveats.push("The version the clip was made from is no longer available, so another version is used.");
    }
    const source = sources[sourceIndex]!;

    const options = { ...initialOptions(source, styles), sourceIndex, name: clip.name, mode: clip.mode, multiPart: ranges.length > 1 };
    if (settings) {
        options.layout = settings.layout;
        options.fit = settings.fit;
        if (settings.audio_index === -1 || source.audio.some((track) => track.index === settings.audio_index)) {
            options.audioIndex = settings.audio_index;
        } else {
            caveats.push("The audio track the clip used is no longer there, so the default track is selected.");
        }
        if (settings.subtitle_index !== null) {
            if (source.subtitles.some((track) => track.index === settings.subtitle_index)) {
                options.subtitleIndex = settings.subtitle_index;
            } else {
                caveats.push("The subtitles the clip used are no longer there, so none are selected.");
            }
        }
        if (styles.some((style) => style.id === settings.subtitle_style)) options.subtitleStyle = settings.subtitle_style;
        // Resolutions depend on the shape and on the version's height.
        const heights = heightChoices(source, options.layout).map((choice) => choice.value);
        options.maxHeight = heights.includes(settings.max_height) ? settings.max_height : heights[0]!;
    }
    if (needsPrecise(options)) options.mode = "precise";

    const parts: ClipParts = {
        list: ranges.map((range, index) => ({ id: index + 1, ...range })),
        selected: 0,
        duration: videoDuration(item, source),
    };
    // Pulls the parts back inside the video, should it have got shorter.
    return { options, parts: withVideoDuration(parts, parts.duration), caveats };
}
