// The parts a clip is spliced from. Pure functions, so they can be unit
// tested with "bun test".
import { DEFAULT_CROP_WIDTH } from "../../constants";
import { clamp } from "../../lib/format";
import { timingProblem, withDuration, withEnd, withStart, type Timing } from "./timing";

// One section of the video. A plain clip has one; a multi-part clip plays
// several, one after the other.
export interface Part {
    // Stays the same while the part is edited or moved (a key for lists).
    id: number;
    // In seconds of the source video.
    start: number;
    end: number;
    // Vertical crops only, so each part can follow its subject. Where the
    // crop sits: 0 is the left edge, 1 the right edge.
    cropX: number;
    // How wide the crop is: 0 is the narrowest cut, which fills the screen,
    // and 1 the whole width. Wider cuts get black bars above and below.
    cropWidth: number;
}

export interface ClipParts {
    // In the order they are played, which need not be their order in the
    // video. Never empty.
    list: Part[];
    // Index of the part the timeline handles, time inputs and crop sliders
    // are editing.
    selected: number;
    // Length of the video; 0 while it is not known yet.
    duration: number;
}

// How long a part added with "Add part" starts out.
const NEW_PART_SECONDS = 10;

// A new video starts with one part: its first 30 seconds.
export function initialParts(duration: number): ClipParts {
    const first = { id: 1, start: 0, end: Math.min(duration, 30), cropX: 0.5, cropWidth: DEFAULT_CROP_WIDTH };
    return { list: [first], selected: 0, duration };
}

export function selectedPart(parts: ClipParts): Part {
    return parts.list[parts.selected]!;
}

function timingOf(part: Part, duration: number): Timing {
    return { start: part.start, end: part.end, duration };
}

function withPart(parts: ClipParts, index: number, change: (part: Part) => Part): ClipParts {
    return { ...parts, list: parts.list.map((part, at) => (at === index ? change(part) : part)) };
}

// Move the start or end of the selected part (see withStart and withEnd).
export function withSelectedStart(parts: ClipParts, time: number): ClipParts {
    return withPart(parts, parts.selected, (part) => {
        const { start, end } = withStart(timingOf(part, parts.duration), time);
        return { ...part, start, end };
    });
}

export function withSelectedEnd(parts: ClipParts, time: number): ClipParts {
    return withPart(parts, parts.selected, (part) => {
        const { start, end } = withEnd(timingOf(part, parts.duration), time);
        return { ...part, start, end };
    });
}

// Reframe the vertical crop of the selected part.
export function withSelectedCrop(parts: ClipParts, crop: { cropX?: number; cropWidth?: number }): ClipParts {
    return withPart(parts, parts.selected, (part) => ({ ...part, ...crop }));
}

export function withSelection(parts: ClipParts, index: number): ClipParts {
    return { ...parts, selected: clamp(index, 0, parts.list.length - 1) };
}

// Add a part that starts at the given time (normally the playhead), to be
// played last, and select it. It is framed like the part selected before.
export function withPartAdded(parts: ClipParts, at: number): ClipParts {
    const limit = parts.duration || Math.max(at, 0) + NEW_PART_SECONDS;
    let start = clamp(at, 0, limit);
    const end = Math.min(limit, start + NEW_PART_SECONDS);
    // Too close to the end of the video: reach back instead.
    if (end - start < 1) start = Math.max(0, end - NEW_PART_SECONDS);
    const { cropX, cropWidth } = selectedPart(parts);
    const part = {
        id: Math.max(...parts.list.map((other) => other.id)) + 1,
        start: Math.round(start * 1000) / 1000,
        end: Math.round(end * 1000) / 1000,
        cropX,
        cropWidth,
    };
    return { ...parts, list: [...parts.list, part], selected: parts.list.length };
}

// Remove a part; the last one left cannot be removed. The selection stays
// on the same part where it can.
export function withPartRemoved(parts: ClipParts, index: number): ClipParts {
    if (parts.list.length < 2 || !parts.list[index]) return parts;
    const list = parts.list.filter((_, at) => at !== index);
    const selected = parts.selected > index ? parts.selected - 1 : Math.min(parts.selected, list.length - 1);
    return { ...parts, list, selected };
}

// Play a part earlier (by = -1) or later (by = 1). It stays selected if it was.
export function withPartMoved(parts: ClipParts, index: number, by: -1 | 1): ClipParts {
    const to = index + by;
    const part = parts.list[index];
    const other = parts.list[to];
    if (!part || !other) return parts;
    const list = [...parts.list];
    list[index] = other;
    list[to] = part;
    let selected = parts.selected;
    if (selected === index) selected = to;
    else if (selected === to) selected = index;
    return { ...parts, list, selected };
}

// Another version of the video was chosen; it can have a different length.
// The parts are kept, pulled back inside the video if needed.
export function withVideoDuration(parts: ClipParts, duration: number | null): ClipParts {
    const next = duration || parts.duration;
    const list = parts.list.map((part) => {
        const { start, end } = withDuration(timingOf(part, parts.duration), next);
        return { ...part, start, end };
    });
    return { ...parts, list, duration: next };
}

// The video's length was unknown and has now been read from the stream.
// An untouched first part becomes the first 30 seconds, as in initialParts.
export function withFoundDuration(parts: ClipParts, duration: number): ClipParts {
    const [first, ...rest] = parts.list;
    const list = first && !rest.length ? [{ ...first, end: Math.min(duration, 30) }] : parts.list;
    return { ...parts, list, duration };
}

// Start and end of the selected part with the video's length, for the code
// that edits one range (timeline handles, time inputs, the player).
export function selectedTiming(parts: ClipParts): Timing {
    return timingOf(selectedPart(parts), parts.duration);
}

// Length of the finished clip: all parts together.
export function totalLength(parts: ClipParts): number {
    return parts.list.reduce((sum, part) => sum + (part.end - part.start), 0);
}

// Why a clip of these parts cannot be made, or "" if it can: the whole clip
// is too "long", or a part is too "short".
export function partsProblem(parts: ClipParts, maxClipSeconds: number): "" | "long" | "short" {
    if (maxClipSeconds > 0 && totalLength(parts) > maxClipSeconds + 0.001) return "long";
    const tooShort = parts.list.some((part) => timingProblem(timingOf(part, parts.duration), 0) === "short");
    return tooShort ? "short" : "";
}
