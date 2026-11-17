import { CardGrid } from "../components/ItemCard";
import { LoadStatus, Notice, PageHead } from "../components/ui";
import { useLoad } from "../hooks/useLoad";
import { api } from "../lib/api";
import type { ItemList } from "../types";

// Results are grouped by type so movies, shows and episodes are easy to scan.
const GROUPS = [
    { title: "Movies", types: ["Movie"] },
    { title: "Shows", types: ["Series"] },
    { title: "Episodes", types: ["Episode"] },
    { title: "Other videos", types: ["Video", "MusicVideo"] },
];

export function SearchView({ query }: { query: string }) {
    if (!query) return <Notice>Type something in the search box.</Notice>;
    return <SearchResults query={query} />;
}

function SearchResults({ query }: { query: string }) {
    const state = useLoad(() => api<ItemList>(`/items?${new URLSearchParams({ q: query, limit: "80" })}`));
    if (state.status !== "ready") return <LoadStatus state={state} />;

    const sections = GROUPS.map((group) => ({
        title: group.title,
        items: state.data.items.filter((item) => group.types.includes(item.type || "")),
    })).filter((section) => section.items.length);

    return (
        <>
            <PageHead title={`Results for "${query}"`} />
            {sections.length ? (
                sections.map((section) => (
                    <section key={section.title} style={{ marginBottom: "28px" }}>
                        <h3>{section.title}</h3>
                        <CardGrid items={section.items} />
                    </section>
                ))
            ) : (
                <Notice>Nothing found.</Notice>
            )}
        </>
    );
}
