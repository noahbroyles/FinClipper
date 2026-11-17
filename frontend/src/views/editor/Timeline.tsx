import { useRef } from "preact/hooks";
import { useAnimationFrame } from "../../hooks/useAnimationFrame";
import { useLatest } from "../../hooks/useLatest";
import { clamp, fmtTime } from "../../lib/format";
import type { PreviewPlayer } from "./preview";
import { timelinePercent, type Timing } from "./timing";
import type { TimingControls } from "./useTiming";

interface Props {
    timing: Timing;
    controls: TimingControls;
    player: PreviewPlayer;
}

// The full length of the video as a bar, with the selected range, a
// draggable handle at each end of it and the playback position.
export function Timeline({ timing, controls, player }: Props) {
    const track = useRef<HTMLDivElement>(null);
    const startHandle = useRef<HTMLDivElement>(null);
    const endHandle = useRef<HTMLDivElement>(null);
    const playhead = useRef<HTMLDivElement>(null);
    const playheadLabel = useRef<HTMLSpanElement>(null);
    const duration = useLatest(timing.duration);

    const startAt = timelinePercent(timing.start, timing.duration);
    const endAt = timelinePercent(timing.end, timing.duration);

    function movePlayhead(time: number): void {
        if (playhead.current) playhead.current.style.left = timelinePercent(time, duration.current);
    }

    // The playhead follows playback on every frame. It is moved directly
    // rather than through state, which would redraw the editor 60 times a
    // second.
    useAnimationFrame(() => {
        const now = player.sourceTime();
        movePlayhead(now);
        if (playheadLabel.current) playheadLabel.current.textContent = `Playhead ${fmtTime(now)}`;
    });

    // Pointer events cover mouse, touch and pen. Dragging a handle moves the
    // start or end; pressing anywhere else on the track seeks the player.
    function onPointerDown(event: PointerEvent): void {
        const bar = track.current;
        if (!bar || !duration.current || event.button !== 0) return;
        event.preventDefault();
        const dragging =
            event.target === startHandle.current ? "start" : event.target === endHandle.current ? "end" : "playhead";
        bar.setPointerCapture(event.pointerId);

        const timeAt = (clientX: number) => {
            const rect = bar.getBoundingClientRect();
            return clamp((clientX - rect.left) / rect.width, 0, 1) * duration.current;
        };
        const apply = (clientX: number) => {
            const time = timeAt(clientX);
            if (dragging === "start") controls.setStart(time);
            else if (dragging === "end") controls.setEnd(time);
            else movePlayhead(time);
        };
        apply(event.clientX);

        const onMove = (moveEvent: PointerEvent) => apply(moveEvent.clientX);
        const onUp = (upEvent: PointerEvent) => {
            bar.removeEventListener("pointermove", onMove);
            bar.removeEventListener("pointerup", onUp);
            bar.removeEventListener("pointercancel", onUp);
            // Seek once at the end of the drag; seeking on every move would
            // flood Jellyfin with segment requests.
            if (dragging === "start") player.seekToStart();
            else if (dragging === "end") player.seekToEnd();
            else player.seek(timeAt(upEvent.clientX));
        };
        bar.addEventListener("pointermove", onMove);
        bar.addEventListener("pointerup", onUp);
        bar.addEventListener("pointercancel", onUp);
    }

    return (
        <div class="timeline">
            <div class="tl-track" ref={track} onPointerDown={onPointerDown}>
                <div class="tl-range" style={{ left: startAt, width: `calc(${endAt} - ${startAt})` }} />
                <div class="tl-handle" ref={startHandle} title="Drag to set the start" style={{ left: startAt }} />
                <div class="tl-handle" ref={endHandle} title="Drag to set the end" style={{ left: endAt }} />
                <div class="tl-playhead" ref={playhead} />
            </div>
            <div class="tl-labels">
                <span class="mono">{fmtTime(0, false)}</span>
                <span class="mono" ref={playheadLabel} />
                <span class="mono tl-total">{fmtTime(timing.duration, false)}</span>
            </div>
        </div>
    );
}
