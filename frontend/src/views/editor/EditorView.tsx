import { LoadStatus, Notice } from "../../components/ui";
import { useLoad } from "../../hooks/useLoad";
import { api } from "../../lib/api";
import type { ItemDetails } from "../../types";
import { Editor } from "./Editor";
import { EditorHeader } from "./EditorHeader";

// The page for one video: the clip editor, or the reason the video cannot
// be clipped.
export function EditorView({ itemId }: { itemId: string }) {
    const state = useLoad(() => api<ItemDetails>(`/item/${itemId}`));
    if (state.status !== "ready") return <LoadStatus state={state} />;

    const item = state.data;
    const sources = item.sources.filter((source) => !source.problem);
    let problem = item.problem;
    if (!problem && !sources.length) problem = item.sources[0]?.problem || "No usable version of this video.";
    return (
        <>
            <EditorHeader item={item} />
            {problem ? <Notice error>{problem}</Notice> : <Editor item={item} sources={sources} />}
        </>
    );
}
