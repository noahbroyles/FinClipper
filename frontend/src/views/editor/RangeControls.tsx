import { useState } from "preact/hooks";
import { classes, fmtRuntime, fmtTime, parseTime } from "../../lib/format";
import { partsProblem, selectedPart, totalLength, type ClipParts } from "./parts";
import type { PreviewPlayer } from "./preview";
import type { PartsControls } from "./useParts";

interface Props {
    parts: ClipParts;
    controls: PartsControls;
    player: PreviewPlayer;
    // Longest clip allowed in seconds; 0 for no limit.
    maxClipSeconds: number;
}

// The start and end of the selected part as editable times, with buttons
// to fine tune them, and the length of the whole clip.
export function RangeControls({ parts, controls, player, maxClipSeconds }: Props) {
    const part = selectedPart(parts);
    const count = parts.list.length;
    return (
        <div class="range-controls">
            {count > 1 ? <div class="range-part muted">{`Part ${parts.selected + 1} of ${count}`}</div> : null}
            <RangeRow
                label="Start"
                value={part.start}
                parts={parts}
                setKey="I"
                jumpKey="["
                onSet={controls.setStart}
                onJump={() => player.seekToStart()}
                playheadTime={() => player.sourceTime()}
            />
            <RangeRow
                label="End"
                value={part.end}
                parts={parts}
                setKey="O"
                jumpKey="]"
                onSet={controls.setEnd}
                onJump={() => player.seekToEnd()}
                playheadTime={() => player.sourceTime()}
            />
            <div class="range-summary">
                <span class={classes("duration mono", partsProblem(parts, maxClipSeconds) && "over")}>
                    {`Clip length ${fmtTime(totalLength(parts))}`}
                </span>
                {count > 1 ? <span class="muted">{`${count} parts`}</span> : null}
                {maxClipSeconds ? <span class="muted">{`Maximum ${fmtRuntime(maxClipSeconds)}`}</span> : null}
                <button
                    class="btn small"
                    type="button"
                    title={count > 1 ? "Play the selected part from start to end (P)" : "Play from start to end (P)"}
                    onClick={() => player.playSelection()}
                >
                    {count > 1 ? "▶ Play part" : "▶ Play selection"}
                </button>
            </div>
        </div>
    );
}

interface RowProps {
    label: string;
    // The time this row edits (the start or the end of the selected part).
    value: number;
    parts: ClipParts;
    // Keyboard shortcuts for the two buttons, shown in their tooltips.
    setKey: string;
    jumpKey: string;
    onSet(time: number): void;
    onJump(): void;
    playheadTime(): number;
}

const NUDGES = [-1, -0.1, 0.1, 1];

function RangeRow({ label, value, parts, setKey, jumpKey, onSet, onJump, playheadTime }: RowProps) {
    const name = label.toLowerCase();
    return (
        <div class="range-row">
            <label>{label}</label>
            <TimeInput label={`${label} time`} value={value} parts={parts} onApply={onSet} />
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
    parts: ClipParts;
    onApply(time: number): void;
}

// A time as text ("00:01:23.500"). What is typed takes effect when the
// field is left or Enter is pressed; text that is not a time is marked.
function TimeInput({ label, value, parts, onApply }: TimeInputProps) {
    // What has been typed but not applied yet. It belongs to the state of
    // the parts it was typed against: any change (applying this edit, a
    // nudge, a drag on the timeline, selecting another part...) makes a new
    // state object (see useParts), which drops the edit and shows the real
    // value again.
    const [edit, setEdit] = useState<{ text: string; invalid: boolean; parts: ClipParts } | null>(null);
    const draft = edit?.parts === parts ? edit : null;

    return (
        <input
            type="text"
            class={classes("mono", draft?.invalid && "invalid")}
            spellcheck={false}
            autocomplete="off"
            aria-label={label}
            value={draft ? draft.text : fmtTime(value)}
            onInput={(event) => setEdit({ text: event.currentTarget.value, invalid: false, parts })}
            onChange={(event) => {
                const text = event.currentTarget.value;
                const time = parseTime(text);
                if (Number.isNaN(time)) setEdit({ text, invalid: true, parts });
                else onApply(time);
            }}
        />
    );
}
