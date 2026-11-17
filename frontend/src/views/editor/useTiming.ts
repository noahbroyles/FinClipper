import type { RefObject } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import { initialTiming, withDuration, withEnd, withStart, type Timing } from "./timing";

export interface TimingControls {
    setStart(time: number): void;
    setEnd(time: number): void;
    // Another version of the video was chosen (null: its length is unknown).
    changeDuration(duration: number | null): void;
    // The length was unknown and has now been read from the stream.
    foundDuration(duration: number): void;
}

// The clip timing as state, to draw from, and as a ref that is current the
// moment a setter returns. Pointer, keyboard and video event handlers read
// the ref, since several of them can run before the next render.
export function useTiming(duration: number): [timing: Timing, ref: RefObject<Timing>, controls: TimingControls] {
    const [timing, setTiming] = useState(() => initialTiming(duration));
    const ref = useRef(timing);

    const controls = useMemo<TimingControls>(() => {
        const set = (next: Timing) => {
            ref.current = next;
            setTiming(next);
        };
        return {
            setStart: (time) => set(withStart(ref.current, time)),
            setEnd: (time) => set(withEnd(ref.current, time)),
            changeDuration: (next) => set(withDuration(ref.current, next)),
            foundDuration: (next) => set({ ...ref.current, duration: next, end: Math.min(next, 30) }),
        };
    }, []);

    return [timing, ref, controls];
}
