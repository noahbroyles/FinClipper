import { useEffect } from "preact/hooks";
import { useLatest } from "./useLatest";

// Call the function before every repaint for as long as the component is
// shown. For things that follow video playback, where timeupdate events
// (about four a second) are too coarse.
export function useAnimationFrame(callback: () => void): void {
    const latest = useLatest(callback);
    useEffect(() => {
        let frame = requestAnimationFrame(function tick() {
            latest.current();
            frame = requestAnimationFrame(tick);
        });
        return () => cancelAnimationFrame(frame);
    }, []);
}
