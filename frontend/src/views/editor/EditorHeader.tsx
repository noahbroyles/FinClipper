import type { ComponentChild } from "preact";
import { fmtRuntime } from "../../lib/format";
import type { ItemDetails } from "../../types";

function goBack(): void {
    if (history.length > 1) history.back();
    else location.hash = "#/";
}

// Back button, the video's title, and a line with its show, year and length.
export function EditorHeader({ item }: { item: ItemDetails }) {
    const meta: ComponentChild[] = [];
    if (item.type === "Episode" && item.series_id) {
        meta.push(<a href={`#/series/${item.series_id}`}>{item.series_name || "Series"}</a>);
    }
    if (item.year && item.type !== "Episode") meta.push(String(item.year));
    if (item.runtime) meta.push(fmtRuntime(item.runtime));

    return (
        <div class="editor-head">
            <button class="btn small" type="button" title="Back" onClick={goBack}>
                ← Back
            </button>
            <div>
                <h1>{item.title || item.name}</h1>
                <div class="muted">{meta.flatMap((part, index) => (index ? [" · ", part] : [part]))}</div>
            </div>
        </div>
    );
}
