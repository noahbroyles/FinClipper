import { CardGrid } from "../components/ItemCard";
import { LoadStatus, Notice, PageHead } from "../components/ui";
import { useLoad } from "../hooks/useLoad";
import { api } from "../lib/api";
import type { Item, ItemDetails, ItemList } from "../types";

interface Props {
    seriesId: string;
    // The season to show; empty for the first one.
    seasonId: string;
}

interface SeriesData {
    series: ItemDetails;
    seasons: Item[];
    // Id of the season whose episodes are listed.
    selected: string;
    episodes: Item[];
}

async function loadSeries(seriesId: string, seasonId: string): Promise<SeriesData> {
    const [series, seasons] = await Promise.all([
        api<ItemDetails>(`/item/${seriesId}`),
        api<ItemList>(`/series/${seriesId}/seasons`),
    ]);
    const selected = seasonId || seasons.items[0]?.id || "";
    const params = new URLSearchParams(selected ? { season_id: selected } : {});
    const episodes = await api<ItemList>(`/series/${seriesId}/episodes?${params}`);
    return { series, seasons: seasons.items, selected, episodes: episodes.items };
}

// A show: its seasons as tabs and the episodes of the selected season.
export function SeriesView({ seriesId, seasonId }: Props) {
    const state = useLoad(() => loadSeries(seriesId, seasonId));
    if (state.status !== "ready") return <LoadStatus state={state} />;
    const { series, seasons, selected, episodes } = state.data;
    return (
        <>
            <PageHead title={series.name}>{series.year ? <span class="muted">{series.year}</span> : null}</PageHead>
            {seasons.length > 1 ? (
                <div class="tabs">
                    {seasons.map((season) => (
                        <a
                            key={season.id}
                            href={`#/series/${seriesId}?season=${season.id}`}
                            class={season.id === selected ? "active" : undefined}
                        >
                            {season.name}
                        </a>
                    ))}
                </div>
            ) : null}
            {episodes.length ? <CardGrid items={episodes} wide /> : <Notice>No episodes found.</Notice>}
        </>
    );
}
