import { useReducer, useState } from "preact/hooks";
import { JobList } from "../../components/JobList";
import { Notice } from "../../components/ui";
import { useClipJobs } from "../../hooks/useClipJobs";
import { api } from "../../lib/api";
import { errorMessage, fmtRuntime } from "../../lib/format";
import { useMe } from "../../lib/me";
import { toast } from "../../lib/toast";
import type { ItemDetails, Job, Source } from "../../types";
import { CropGuide } from "./CropGuide";
import { clipRequest, initialOptions, optionsReducer, type ClipOptions } from "./options";
import { OptionsPanel } from "./OptionsPanel";
import { usePreview } from "./preview";
import { RangeControls } from "./RangeControls";
import { ShortcutHelp } from "./ShortcutHelp";
import { Timeline } from "./Timeline";
import { timingProblem } from "./timing";
import { useShortcuts } from "./useShortcuts";
import { useTiming } from "./useTiming";

interface Props {
    item: ItemDetails;
    // The versions of the video that can be clipped; at least one.
    sources: Source[];
}

// The clip editor: preview player, timeline and time controls on one side,
// the options and the clips made from this video on the other.
export function Editor({ item, sources }: Props) {
    const me = useMe();
    const firstSource = sources[0]!;
    const [options, dispatch] = useReducer(optionsReducer, null, () => initialOptions(firstSource, me.subtitle_styles));
    const source = sources[options.sourceIndex]!;
    const [timing, timingRef, timingControls] = useTiming(firstSource.duration || item.runtime || 0);
    const { player, videoRef, error: previewError } = usePreview({
        itemId: item.id,
        source: firstSource,
        audioIndex: options.audioIndex,
        timingRef,
        onDuration: timingControls.foundDuration,
    });
    const clips = useClipJobs(item.id);
    const [creating, setCreating] = useState(false);
    useShortcuts(player, timingControls);

    function changeSource(index: number): void {
        const next = sources[index];
        if (!next) return;
        // Carry on from the same position in the new version.
        const resumeAt = player.sourceTime();
        dispatch({ type: "source", index, source: next });
        timingControls.changeDuration(next.duration);
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
            const { start, end } = timingRef.current;
            const job = await api<Job>("/clips", { method: "POST", body: clipRequest(item.id, source, options, start, end) });
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

    const problem = timingProblem(timing, me.max_clip_seconds);
    const createProblem =
        problem === "long"
            ? `Clips can be at most ${fmtRuntime(me.max_clip_seconds)} long`
            : problem === "short"
              ? "The clip must be at least half a second long"
              : "";
    const showCropGuide = options.layout === "vertical" && options.fit === "crop";

    return (
        <div class="editor">
            <div>
                <div class="player">
                    <video ref={videoRef} controls playsInline preload="auto" />
                    {showCropGuide ? <CropGuide videoRef={videoRef} cropX={options.cropX} cropWidth={options.cropWidth} /> : null}
                </div>
                {previewError ? <div class="notice error player-error">{previewError}</div> : null}
                <Timeline timing={timing} controls={timingControls} player={player} />
                <RangeControls
                    timing={timing}
                    controls={timingControls}
                    player={player}
                    maxClipSeconds={me.max_clip_seconds}
                />
                <ShortcutHelp />
            </div>
            <div>
                {me.can_clip ? null : (
                    <Notice error>
                        Your Jellyfin account is not allowed to download media, so you cannot create clips.
                    </Notice>
                )}
                <OptionsPanel
                    sources={sources}
                    options={options}
                    subtitleStyles={me.subtitle_styles}
                    onSourceChange={changeSource}
                    onAudioChange={changeAudio}
                    onChange={(values: Partial<ClipOptions>) => dispatch({ type: "set", values })}
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
