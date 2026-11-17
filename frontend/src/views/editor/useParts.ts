import type { RefObject } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import {
    withFoundDuration,
    withPartAdded,
    withPartMoved,
    withPartRemoved,
    withSelectedCrop,
    withSelectedEnd,
    withSelectedStart,
    withSelection,
    withVideoDuration,
    type ClipParts,
} from "./parts";

export interface PartsControls {
    // Move the start or end of the selected part.
    setStart(time: number): void;
    setEnd(time: number): void;
    // Reframe the vertical crop of the selected part.
    setCrop(crop: { cropX?: number; cropWidth?: number }): void;
    select(index: number): void;
    // Add a part starting at the given time, played last, and select it.
    add(at: number): void;
    remove(index: number): void;
    // Play a part earlier (-1) or later (1).
    move(index: number, by: -1 | 1): void;
    // Another version of the video was chosen (null: its length is unknown).
    changeDuration(duration: number | null): void;
    // The length was unknown and has now been read from the stream.
    foundDuration(duration: number): void;
}

// The clip's parts as state, to draw from, and as a ref that is current
// the moment a control returns. Pointer, keyboard and video event handlers
// read the ref, since several of them can run before the next render.
//
// Every call of a control makes a new state object, even when nothing
// changed. The time inputs rely on that to know an edit has been applied.
export function useParts(initial: ClipParts): [parts: ClipParts, ref: RefObject<ClipParts>, controls: PartsControls] {
    const [parts, setParts] = useState(initial);
    const ref = useRef(parts);

    const controls = useMemo<PartsControls>(() => {
        const set = (next: ClipParts) => {
            // A copy, in case the change returned the same object.
            ref.current = next === ref.current ? { ...next } : next;
            setParts(ref.current);
        };
        return {
            setStart: (time) => set(withSelectedStart(ref.current, time)),
            setEnd: (time) => set(withSelectedEnd(ref.current, time)),
            setCrop: (crop) => set(withSelectedCrop(ref.current, crop)),
            select: (index) => set(withSelection(ref.current, index)),
            add: (at) => set(withPartAdded(ref.current, at)),
            remove: (index) => set(withPartRemoved(ref.current, index)),
            move: (index, by) => set(withPartMoved(ref.current, index, by)),
            changeDuration: (next) => set(withVideoDuration(ref.current, next)),
            foundDuration: (next) => set(withFoundDuration(ref.current, next)),
        };
    }, []);

    return [parts, ref, controls];
}
