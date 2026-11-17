import { CardGrid } from "../components/ItemCard";
import { LoadStatus, Notice, PageHead } from "../components/ui";
import { useLoad } from "../hooks/useLoad";
import { api } from "../lib/api";
import type { Item } from "../types";

// The start page: the video libraries of the Jellyfin account.
export function HomeView() {
    const state = useLoad(() => api<{ items: Item[] }>("/libraries"));
    if (state.status !== "ready") return <LoadStatus state={state} />;
    const { items } = state.data;
    return (
        <>
            <PageHead title="Libraries" />
            {items.length ? <CardGrid items={items} /> : <Notice>No video libraries are available to your account.</Notice>}
        </>
    );
}
