import { useEffect, useReducer, useState } from "preact/hooks";
import { JobList } from "../../components/JobList";
import { Notice } from "../../components/ui";
import { useClipJobs } from "../../hooks/useClipJobs";
import { api } from "../../lib/api";
import { errorMessage, fmtRuntime } from "../../lib/format";
import { useMe } from "../../lib/me";
import { toast } from "../../lib/toast";
import type { ItemDetails, Job, Source } from "../../types";
import { CropGuide } from "./CropGuide";
import { clipRequest, optionsReducer, type ClipOptions } from "./options";
import { OptionsPanel } from "./OptionsPanel";
import { partsProblem, selectedPart, selectedTiming } from "./parts";
import { PartsList } from "./PartsList";
import { usePreview } from "./preview";
import { RangeControls } from "./RangeControls";
import type { EditorStart } from "./reclip";
import { ShortcutHelp } from "./ShortcutHelp";
import { Timeline } from "./Timeline";
import { useParts } from "./useParts";
import { useShortcuts } from "./useShortcuts";

interface Props {
    item: ItemDetails;
    // The versions of the video that can be clipped; at least one.
    sources: Source[];
    // The options and parts to begin with: the defaults, or those of the
    // clip being re-clipped.
    start: EditorStart;
    // When re-clipping: which clip that is, for the note above the options
    // (for example: your clip "Best bits").
    reclipOf?: string;
}

// The clip editor: preview player, timeline, time controls and the list of
// parts on one side, the options and the clips made from this video on the
// other.
export function Editor({ item, sources, start, reclipOf }: Props) {
    const me = useMe();
    const [options, dispatch] = useReducer(optionsReducer, start.options);
    const source = sources[options.sourceIndex]!;
    const [parts, partsRef, partsControls] = useParts(start.parts);
    const { player, videoRef, error: previewError } = usePreview({
        itemId: item.id,
        source,
        audioIndex: options.audioIndex,
        // A re-clip opens where the clip begins.
        startAt: reclipOf === undefined ? 0 : (start.parts.list[0]?.start ?? 0),
        timing: () => selectedTiming(partsRef.current),
        onDuration: partsControls.foundDuration,
    });
    const clips = useClipJobs(item.id);
    const [creating, setCreating] = useState(false);
    useShortcuts(player, partsControls);

    // Joining several parts needs Precise mode; the options decide the mode.
    const multiPart = parts.list.length > 1;
    useEffect(() => dispatch({ type: "set", values: { multiPart } }), [multiPart]);

    function changeSource(index: number): void {
        const next = sources[index];
        if (!next) return;
        // Carry on from the same position in the new version.
        const resumeAt = player.sourceTime();
        dispatch({ type: "source", index, source: next });
        partsControls.changeDuration(next.duration);
        player.start(next, next.default_audio ?? -1, resumeAt);
    }

    function changeAudio(audioIndex: number): void {
        dispatch({ type: "set", values: { audioIndex } });
        if (audioIndex >= 0) {
            player.setMuted(false);
            player.start(source, audioIndex, player.sourceTime());
        } else {
            // "No audio" only affects the clip; mute the preview to match.
            player.setMuted(true);
        }
    }

    async function createClip(): Promise<void> {
        setCreating(true);
        try {
            const body = clipRequest(item.id, source, options, partsRef.current.list);
            const job = await api<Job>("/clips", { method: "POST", body });
            clips.add(job);
            // Clear the name so the next clip does not reuse it by accident.
            dispatch({ type: "set", values: { name: "" } });
            toast("Clip queued. It will appear below when it is ready.");
        } catch (error) {
            toast(errorMessage(error), true);
        } finally {
            setCreating(false);
        }
    }

    const problem = partsProblem(parts, me.max_clip_seconds);
    let createProblem = "";
    if (problem === "long") createProblem = `Clips can be at most ${fmtRuntime(me.max_clip_seconds)} long`;
    else if (problem === "short" && multiPart) createProblem = "Every part must be at least half a second long";
    else if (problem === "short") createProblem = "The clip must be at least half a second long";
    const showCropGuide = options.layout === "vertical" && options.fit === "crop";
    // The crop sliders and the guide on the preview belong to the selected part.
    const crop = selectedPart(parts);

    return (
        <div class="editor">
            <div>
                <div class="player">
                    <video ref={videoRef} controls playsInline preload="auto" />
                    {showCropGuide ? <CropGuide videoRef={videoRef} cropX={crop.cropX} cropWidth={crop.cropWidth} /> : null}
                </div>
                {previewError ? <div class="notice error player-error">{previewError}</div> : null}
                <Timeline parts={parts} controls={partsControls} player={player} />
                <RangeControls
                    parts={parts}
                    controls={partsControls}
                    player={player}
                    maxClipSeconds={me.max_clip_seconds}
                />
                <PartsList parts={parts} controls={partsControls} player={player} maxParts={me.max_clip_parts} />
                <ShortcutHelp />
            </div>
            <div>
                {me.can_clip ? null : (
                    <Notice error>
                        Your Jellyfin account is not allowed to download media, so you cannot create clips.
                    </Notice>
                )}
                {reclipOf === undefined ? null : (
                    <Notice>
                        {`These are the settings of ${reclipOf}. Change what you like and create a new clip; the original is kept. `}
                        {start.caveats.join(" ")}
                    </Notice>
                )}
                <OptionsPanel
                    sources={sources}
                    options={options}
                    subtitleStyles={me.subtitle_styles}
                    onSourceChange={changeSource}
                    onAudioChange={changeAudio}
                    onChange={(values: Partial<ClipOptions>) => dispatch({ type: "set", values })}
                    crop={crop}
                    cropPart={multiPart ? parts.selected + 1 : 0}
                    onCropChange={partsControls.setCrop}
                    onCreate={createClip}
                    createDisabled={!me.can_clip || problem !== "" || creating}
                    createProblem={createProblem}
                />
                <section class="panel">
                    <h3>Clips from this video</h3>
                    <JobList clips={clips} emptyText="Clips you make from this video appear here." />
                </section>
            </div>
        </div>
    );
}
