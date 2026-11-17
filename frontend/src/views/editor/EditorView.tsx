import { LoadStatus, Notice } from "../../components/ui";
import { useLoad } from "../../hooks/useLoad";
import { api } from "../../lib/api";
import { useMe } from "../../lib/me";
import { toast } from "../../lib/toast";
import type { ItemDetails, ReclipSource } from "../../types";
import { Editor } from "./Editor";
import { EditorHeader } from "./EditorHeader";
import { editorStart } from "./reclip";

interface Props {
    itemId: string;
    // Id of the clip to start from ("Re-clip"), or "": one of the user's own
    // clips or someone else's public clip.
    reclipId: string;
}

// The clip to copy the settings of. It can be gone (deleted, expired or
// made private since the link was made), which is not worth failing the
// page over.
async function loadReclip(itemId: string, clipId: string): Promise<ReclipSource | null> {
    if (!clipId) return null;
    try {
        const clip = await api<ReclipSource>(`/reclip/${clipId}`);
        if (clip.item_id === itemId) return clip;
    } catch {
        // Reported below.
    }
    toast("The clip to copy the settings from is no longer available.", true);
    return null;
}

// How the note above the options names the clip the settings came from.
function describeReclip(clip: ReclipSource): string {
    const name = `"${clip.name || clip.title}"`;
    return clip.mine ? `your clip ${name}` : `the clip ${name} shared by ${clip.owner_name || "another user"}`;
}

// The page for one video: the clip editor, or the reason the video cannot
// be clipped.
export function EditorView({ itemId, reclipId }: Props) {
    const me = useMe();
    const state = useLoad(() => Promise.all([api<ItemDetails>(`/item/${itemId}`), loadReclip(itemId, reclipId)]));
    if (state.status !== "ready") return <LoadStatus state={state} />;

    const [item, clip] = state.data;
    const sources = item.sources.filter((source) => !source.problem);
    let problem = item.problem;
    if (!problem && !sources.length) problem = item.sources[0]?.problem || "No usable version of this video.";
    return (
        <>
            <EditorHeader item={item} />
            {problem ? (
                <Notice error>{problem}</Notice>
            ) : (
                <Editor
                    item={item}
                    sources={sources}
                    start={editorStart(item, sources, me.subtitle_styles, clip)}
                    reclipOf={clip ? describeReclip(clip) : undefined}
                />
            )}
        </>
    );
}
