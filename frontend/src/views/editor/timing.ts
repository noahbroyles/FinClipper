// The clip's start and end on the video's timeline. Pure functions, so
// they can be unit tested with "bun test".
import { clamp } from "../../lib/format";

// All times are in seconds of the source video.
export interface Timing {
    start: number;
    end: number;
    // Length of the video; 0 while it is not known yet.
    duration: number;
}

// Shortest clip the server accepts.
const MIN_CLIP_SECONDS = 0.5;

// Times are kept to the millisecond, the precision the server accepts.
function round(time: number): number {
    return Math.round(time * 1000) / 1000;
}

// A new video starts with its first 30 seconds selected.
export function initialTiming(duration: number): Timing {
    return { start: 0, end: Math.min(duration, 30), duration };
}

// Move the start. Moving it past the end pushes the end along, keeping the
// previous clip length where possible.
export function withStart(timing: Timing, time: number): Timing {
    const length = Math.max(timing.end - timing.start, 1);
    const limit = timing.duration || Math.max(time, 0);
    let start = round(clamp(time, 0, limit));
    let end = timing.end;
    if (end <= start) end = round(Math.min(limit, start + length));
    if (end <= start) start = round(Math.max(0, end - length));
    return { start, end, duration: timing.duration };
}

// Move the end. Moving it before the start pushes the start along.
export function withEnd(timing: Timing, time: number): Timing {
    const length = Math.max(timing.end - timing.start, 1);
    const limit = timing.duration || Math.max(time, 0);
    let end = round(clamp(time, 0, limit));
    let start = timing.start;
    if (end <= start) start = round(Math.max(0, end - length));
    if (end <= start) end = round(Math.min(limit, start + length));
    return { start, end, duration: timing.duration };
}

// Another version of the video was chosen; it can have a different length.
// The selection is kept, pulled back inside the video if needed.
export function withDuration(timing: Timing, duration: number | null): Timing {
    return withEnd({ ...timing, duration: duration || timing.duration }, timing.end);
}

// Why a clip with this timing cannot be made, or "" if it can.
export function timingProblem(timing: Timing, maxClipSeconds: number): "" | "long" | "short" {
    const length = timing.end - timing.start;
    if (maxClipSeconds > 0 && length > maxClipSeconds + 0.001) return "long";
    if (length < MIN_CLIP_SECONDS) return "short";
    return "";
}

// Where a time sits on the timeline, as a CSS percentage of its width.
export function timelinePercent(time: number, duration: number): string {
    if (!duration) return "0%";
    return `${clamp(time / duration, 0, 1) * 100}%`;
}
