import { useRef } from "preact/hooks";
import { useAnimationFrame } from "../../hooks/useAnimationFrame";
import { useLatest } from "../../hooks/useLatest";
import { clamp, classes, fmtTime } from "../../lib/format";
import type { ClipParts } from "./parts";
import type { PreviewPlayer } from "./preview";
import { timelinePercent } from "./timing";
import type { PartsControls } from "./useParts";

interface Props {
    parts: ClipParts;
    controls: PartsControls;
    player: PreviewPlayer;
}

// The full length of the video as a bar, with the clip's parts as blocks
// on it, a draggable handle at each end of the selected part, and the
// playback position.
export function Timeline({ parts, controls, player }: Props) {
    const track = useRef<HTMLDivElement>(null);
    const startHandle = useRef<HTMLDivElement>(null);
    const endHandle = useRef<HTMLDivElement>(null);
    const playhead = useRef<HTMLDivElement>(null);
    const playheadLabel = useRef<HTMLSpanElement>(null);
    const duration = useLatest(parts.duration);

    const at = (time: number) => timelinePercent(time, parts.duration);
    const selected = parts.list[parts.selected]!;
    const numbered = parts.list.length > 1;

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
    // start or end of the selected part; pressing anywhere else on the track
    // seeks the player, and on another part's block also selects that part.
    function onPointerDown(event: PointerEvent): void {
        const bar = track.current;
        if (!bar || !duration.current || event.button !== 0) return;
        event.preventDefault();
        const dragging =
            event.target === startHandle.current ? "start" : event.target === endHandle.current ? "end" : "playhead";
        const block = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-part]") : null;
        if (dragging === "playhead" && block) controls.select(Number(block.dataset.part));
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
                {parts.list.map((part, index) => (
                    <div
                        key={part.id}
                        class={classes("tl-range", index !== parts.selected && "other")}
                        data-part={index}
                        title={numbered ? `Part ${index + 1}` : undefined}
                        style={{ left: at(part.start), width: `calc(${at(part.end)} - ${at(part.start)})` }}
                    >
                        {numbered ? <span class="tl-number">{index + 1}</span> : null}
                    </div>
                ))}
                <div class="tl-handle" ref={startHandle} title="Drag to set the start" style={{ left: at(selected.start) }} />
                <div class="tl-handle" ref={endHandle} title="Drag to set the end" style={{ left: at(selected.end) }} />
                <div class="tl-playhead" ref={playhead} />
            </div>
            <div class="tl-labels">
                <span class="mono">{fmtTime(0, false)}</span>
                <span class="mono" ref={playheadLabel} />
                <span class="mono tl-total">{fmtTime(parts.duration, false)}</span>
            </div>
        </div>
    );
}
