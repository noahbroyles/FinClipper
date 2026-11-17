import { useState } from "preact/hooks";
import { classes, fmtRuntime, fmtTime, parseTime } from "../../lib/format";
import type { PreviewPlayer } from "./preview";
import { timingProblem, type Timing } from "./timing";
import type { TimingControls } from "./useTiming";

interface Props {
    timing: Timing;
    controls: TimingControls;
    player: PreviewPlayer;
    // Longest clip allowed in seconds; 0 for no limit.
    maxClipSeconds: number;
}

// The start and end of the clip as editable times, with buttons to fine
// tune them, and the resulting clip length.
export function RangeControls({ timing, controls, player, maxClipSeconds }: Props) {
    return (
        <div class="range-controls">
            <RangeRow
                label="Start"
                value={timing.start}
                timing={timing}
                setKey="I"
                jumpKey="["
                onSet={controls.setStart}
                onJump={() => player.seekToStart()}
                playheadTime={() => player.sourceTime()}
            />
            <RangeRow
                label="End"
                value={timing.end}
                timing={timing}
                setKey="O"
                jumpKey="]"
                onSet={controls.setEnd}
                onJump={() => player.seekToEnd()}
                playheadTime={() => player.sourceTime()}
            />
            <div class="range-summary">
                <span class={classes("duration mono", timingProblem(timing, maxClipSeconds) && "over")}>
                    {`Clip length ${fmtTime(timing.end - timing.start)}`}
                </span>
                {maxClipSeconds ? <span class="muted">{`Maximum ${fmtRuntime(maxClipSeconds)}`}</span> : null}
                <button class="btn small" type="button" title="Play from start to end (P)" onClick={() => player.playSelection()}>
                    ▶ Play selection
                </button>
            </div>
        </div>
    );
}

interface RowProps {
    label: string;
    // The time this row edits (the start or the end).
    value: number;
    timing: Timing;
    // Keyboard shortcuts for the two buttons, shown in their tooltips.
    setKey: string;
    jumpKey: string;
    onSet(time: number): void;
    onJump(): void;
    playheadTime(): number;
}

const NUDGES = [-1, -0.1, 0.1, 1];

function RangeRow({ label, value, timing, setKey, jumpKey, onSet, onJump, playheadTime }: RowProps) {
    const name = label.toLowerCase();
    return (
        <div class="range-row">
            <label>{label}</label>
            <TimeInput label={`${label} time`} value={value} timing={timing} onApply={onSet} />
            <button
                class="btn small"
                type="button"
                title={`Set the ${name} to the current playback position (${setKey})`}
                onClick={() => onSet(playheadTime())}
            >
                Set to playhead
            </button>
            <button class="btn small" type="button" title={`Jump to the ${name} (${jumpKey})`} onClick={onJump}>
                Go to
            </button>
            <div class="nudges">
                {NUDGES.map((delta) => (
                    <button key={delta} class="btn small mono" type="button" onClick={() => onSet(value + delta)}>
                        {`${delta > 0 ? "+" : "-"}${Math.abs(delta)}s`}
                    </button>
                ))}
            </div>
        </div>
    );
}

interface TimeInputProps {
    label: string;
    value: number;
    timing: Timing;
    onApply(time: number): void;
}

// A time as text ("00:01:23.500"). What is typed takes effect when the
// field is left or Enter is pressed; text that is not a time is marked.
function TimeInput({ label, value, timing, onApply }: TimeInputProps) {
    // What has been typed but not applied yet. It belongs to the timing it
    // was typed against: any change to the range (applying this edit, a
    // nudge, a drag on the timeline...) makes a new timing object, which
    // drops the edit and shows the real value again.
    const [edit, setEdit] = useState<{ text: string; invalid: boolean; timing: Timing } | null>(null);
    const draft = edit?.timing === timing ? edit : null;

    return (
        <input
            type="text"
            class={classes("mono", draft?.invalid && "invalid")}
            spellcheck={false}
            autocomplete="off"
            aria-label={label}
            value={draft ? draft.text : fmtTime(value)}
            onInput={(event) => setEdit({ text: event.currentTarget.value, invalid: false, timing })}
            onChange={(event) => {
                const text = event.currentTarget.value;
                const time = parseTime(text);
                if (Number.isNaN(time)) setEdit({ text, invalid: true, timing });
                else onApply(time);
            }}
        />
    );
}
