import { useEffect, useRef, useState } from "preact/hooks";
import { CardGrid } from "../components/ItemCard";
import { Notice, PageHead, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { BROWSE_SORTS, isBrowseSort, pickBrowseSort, saveBrowseSort } from "../lib/browseSort";
import { errorMessage } from "../lib/format";
import { mostlyWide } from "../lib/items";
import { toast } from "../lib/toast";
import type { Item, ItemList } from "../types";

const PAGE_SIZE = 100;

interface Props {
    parentId: string;
    // "movies" or "tvshows" for a library of that kind, otherwise "".
    kind: string;
    name: string;
    // The "sort" value from the page address, possibly empty or invalid.
    sortParam: string;
}

interface Listing {
    items: Item[];
    total: number;
    // Landscape thumbnails or posters. The first page decides for the
    // whole view, so the layout does not jump when more is loaded.
    wide: boolean;
    hasMore: boolean;
}

// The contents of a library or folder, loaded a page at a time.
export function BrowseView({ parentId, kind, name, sortParam }: Props) {
    const sort = pickBrowseSort(sortParam);
    const [listing, setListing] = useState<Listing | null>(null);
    const [error, setError] = useState("");
    const [loadingMore, setLoadingMore] = useState(false);
    const mounted = useRef(true);

    async function loadPage(start: number): Promise<void> {
        const [sortBy = "", order = ""] = sort.split("-");
        const params = new URLSearchParams({
            parent_id: parentId,
            kind,
            sort: sortBy,
            order,
            start: String(start),
            limit: String(PAGE_SIZE),
        });
        const page = await api<ItemList>(`/items?${params}`);
        if (!mounted.current) return;
        setListing((previous) => ({
            items: previous ? [...previous.items, ...page.items] : page.items,
            total: page.total,
            wide: previous ? previous.wide : mostlyWide(page.items),
            hasMore: page.items.length > 0 && start + page.items.length < page.total,
        }));
    }

    useEffect(() => {
        loadPage(0).catch((cause: unknown) => {
            if (mounted.current) setError(errorMessage(cause));
        });
        return () => {
            mounted.current = false;
        };
    }, []);

    async function loadMore(): Promise<void> {
        if (!listing) return;
        setLoadingMore(true);
        try {
            await loadPage(listing.items.length);
        } catch (cause) {
            toast(errorMessage(cause), true);
        } finally {
            setLoadingMore(false);
        }
    }

    // Changing the sort puts it in the page address (so reloading keeps it)
    // and loads the page again. replace() avoids a history entry per change,
    // so Back still leaves the library.
    function changeSort(value: string): void {
        if (!isBrowseSort(value)) return;
        saveBrowseSort(value);
        const params = new URLSearchParams({ kind, name, sort: value });
        location.replace(`#/library/${encodeURIComponent(parentId)}?${params}`);
    }

    if (error) return <Notice error>{error}</Notice>;
    if (!listing) return <Spinner />;
    return (
        <>
            <PageHead title={name || "Library"}>
                <span class="muted">{`${listing.total} ${listing.total === 1 ? "item" : "items"}`}</span>
                <label class="sort">
                    Sort
                    <select aria-label="Sort by" value={sort} onChange={(event) => changeSort(event.currentTarget.value)}>
                        {BROWSE_SORTS.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </label>
            </PageHead>
            {listing.items.length ? (
                <CardGrid items={listing.items} wide={listing.wide} />
            ) : (
                <Notice>This folder is empty.</Notice>
            )}
            {listing.hasMore ? (
                <div class="load-more">
                    <button class="btn" type="button" disabled={loadingMore} onClick={loadMore}>
                        Load more
                    </button>
                </div>
            ) : null}
        </>
    );
}
