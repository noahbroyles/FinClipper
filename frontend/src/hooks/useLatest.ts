import type { RefObject } from "preact";
import { useRef } from "preact/hooks";

// A ref that always holds the value from the latest render, for callbacks
// that are set up once (timers, event listeners) but need current values.
export function useLatest<T>(value: T): RefObject<T> {
    const ref = useRef(value);
    ref.current = value;
    return ref;
}
