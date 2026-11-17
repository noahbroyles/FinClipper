import { classes, fmtRuntime, fmtTime } from "../../lib/format";
import type { ClipParts } from "./parts";
import type { PreviewPlayer } from "./preview";
import type { PartsControls } from "./useParts";

interface Props {
    parts: ClipParts;
    controls: PartsControls;
    player: PreviewPlayer;
    // Most parts a clip may have.
    maxParts: number;
}

// The sections of the video the clip is spliced from, in the order they
// will be played. Clicking one selects it for the timeline handles, the
// time inputs and the crop sliders. With a single part there is no list,
// just the button that adds a second one.
export function PartsList({ parts, controls, player, maxParts }: Props) {
    const many = parts.list.length > 1;
    const full = parts.list.length >= maxParts;

    function select(index: number): void {
        controls.select(index);
        // Show where the part begins.
        player.seekToStart();
    }

    return (
        <div class="parts">
            {many ? (
                <ol class="parts-list">
                    {parts.list.map((part, index) => (
                        <li key={part.id} class={classes("part", index === parts.selected && "selected")}>
                            <button
                                class="part-select"
                                type="button"
                                title="Select this part to change it"
                                aria-pressed={index === parts.selected}
                                onClick={() => select(index)}
                            >
                                <span class="part-number">{index + 1}</span>
                                <span class="mono">{`${fmtTime(part.start)} → ${fmtTime(part.end)}`}</span>
                                <span class="muted">{fmtRuntime(part.end - part.start) || "0s"}</span>
                            </button>
                            <button
                                class="btn small"
                                type="button"
                                title="Play this part earlier"
                                aria-label={`Play part ${index + 1} earlier`}
                                disabled={index === 0}
                                onClick={() => controls.move(index, -1)}
                            >
                                ↑
                            </button>
                            <button
                                class="btn small"
                                type="button"
                                title="Play this part later"
                                aria-label={`Play part ${index + 1} later`}
                                disabled={index === parts.list.length - 1}
                                onClick={() => controls.move(index, 1)}
                            >
                                ↓
                            </button>
                            <button
                                class="btn small danger"
                                type="button"
                                aria-label={`Remove part ${index + 1}`}
                                onClick={() => controls.remove(index)}
                            >
                                Remove
                            </button>
                        </li>
                    ))}
                </ol>
            ) : null}
            <div class="parts-actions">
                <button
                    class="btn small"
                    type="button"
                    title={
                        full
                            ? `A clip can have at most ${maxParts} parts`
                            : "Add another section of the video, starting at the playhead. The parts are joined into one clip."
                    }
                    disabled={full}
                    onClick={() => controls.add(player.sourceTime())}
                >
                    + Add part
                </button>
                {many ? (
                    <button
                        class="btn small"
                        type="button"
                        title="Play the parts one after the other, as in the finished clip. The preview pauses briefly between parts; the clip will not."
                        onClick={() => player.playAll(parts.list, controls.select)}
                    >
                        ▶ Play all parts
                    </button>
                ) : null}
            </div>
        </div>
    );
}
