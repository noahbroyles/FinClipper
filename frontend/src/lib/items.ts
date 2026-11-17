// How library items are linked and labelled in list views.
import type { Item } from "../types";
import { fmtRuntime } from "./format";

// Where clicking an item leads.
export function itemHref(item: Item): string {
    if (item.type === "Series") return `#/series/${item.id}`;
    if (item.type === "Season") return `#/series/${item.series_id}?season=${item.id}`;
    if (item.is_folder) {
        let kind = "";
        if (item.collection_type === "movies" || item.collection_type === "tvshows") kind = item.collection_type;
        const params = new URLSearchParams({ kind, name: item.name });
        return `#/library/${item.id}?${params}`;
    }
    return `#/item/${item.id}`;
}

// Episodes, videos and libraries have 16:9 thumbnails, the rest posters.
export function isWide(item: Item): boolean {
    if (item.aspect) return item.aspect > 1.1;
    return ["Episode", "Video", "MusicVideo", "CollectionFolder", "UserView"].includes(item.type || "");
}

// Use the wide layout when most items have landscape thumbnails.
export function mostlyWide(items: Item[]): boolean {
    return items.filter(isWide).length > items.length / 2;
}

export function itemSubtitle(item: Item): string {
    switch (item.type) {
        case "Episode": {
            const code = item.season != null && item.episode != null ? `S${item.season} E${item.episode}` : "";
            return [code, item.series_name].filter(Boolean).join(" · ");
        }
        case "Movie":
        case "Series":
            return item.year ? String(item.year) : "";
        case "Season":
            return "";
        default:
            if (item.is_folder) return "Folder";
            return fmtRuntime(item.runtime);
    }
}
