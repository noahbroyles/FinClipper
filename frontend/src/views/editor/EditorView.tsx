import { LoadStatus, Notice } from "../../components/ui";
import { useLoad } from "../../hooks/useLoad";
import { api } from "../../lib/api";
import { useMe } from "../../lib/me";
import { toast } from "../../lib/toast";
import type { ItemDetails, Job } from "../../types";
import { Editor } from "./Editor";
import { EditorHeader } from "./EditorHeader";
import { editorStart } from "./reclip";

interface Props {
    itemId: string;
    // Id of one of the user's clips to start from ("Re-clip"), or "".
    reclipId: string;
}

// The clip to copy the settings of. It can be gone (deleted or expired
// since the link was made), which is not worth failing the page over.
async function loadReclip(itemId: string, clipId: string): Promise<Job | null> {
    if (!clipId) return null;
    try {
        const clip = await api<Job>(`/clips/${clipId}`);
        if (clip.item_id === itemId) return clip;
    } catch {
        // Reported below.
    }
    toast("The clip to copy the settings from no longer exists.", true);
    return null;
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
                    reclipOf={clip ? clip.name || clip.title : undefined}
                />
            )}
        </>
    );
}
