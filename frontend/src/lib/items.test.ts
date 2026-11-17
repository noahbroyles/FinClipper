import { describe, expect, test } from "bun:test";
import type { Item } from "../types";
import { isWide, itemHref, itemSubtitle, mostlyWide } from "./items";

function item(values: Partial<Item>): Item {
    return {
        id: "id1",
        name: "Name",
        type: "Movie",
        is_folder: false,
        collection_type: null,
        year: null,
        series_id: null,
        series_name: null,
        season: null,
        episode: null,
        runtime: null,
        image_tag: null,
        aspect: null,
        ...values,
    };
}

describe("itemHref", () => {
    test("videos open the editor", () => {
        expect(itemHref(item({ type: "Movie" }))).toBe("#/item/id1");
        expect(itemHref(item({ type: "Episode" }))).toBe("#/item/id1");
    });

    test("shows and seasons open the series page", () => {
        expect(itemHref(item({ type: "Series", is_folder: true }))).toBe("#/series/id1");
        expect(itemHref(item({ type: "Season", is_folder: true, series_id: "show" }))).toBe("#/series/show?season=id1");
    });

    test("libraries and folders open the browser, with the kind of a movie or show library", () => {
        const library = item({ type: "CollectionFolder", is_folder: true, collection_type: "movies", name: "My Movies" });
        expect(itemHref(library)).toBe("#/library/id1?kind=movies&name=My+Movies");
        const folder = item({ type: "Folder", is_folder: true, collection_type: "homevideos", name: "Trips" });
        expect(itemHref(folder)).toBe("#/library/id1?kind=&name=Trips");
    });
});

test("isWide prefers the image's own shape", () => {
    expect(isWide(item({ type: "Movie", aspect: 1.78 }))).toBe(true);
    expect(isWide(item({ type: "Episode", aspect: 0.67 }))).toBe(false);
    expect(isWide(item({ type: "Episode" }))).toBe(true);
    expect(isWide(item({ type: "Movie" }))).toBe(false);
});

test("mostlyWide needs more than half", () => {
    const wide = item({ type: "Episode" });
    const tall = item({ type: "Movie" });
    expect(mostlyWide([wide, wide, tall])).toBe(true);
    expect(mostlyWide([wide, tall])).toBe(false);
    expect(mostlyWide([])).toBe(false);
});

test("itemSubtitle", () => {
    expect(itemSubtitle(item({ type: "Episode", season: 1, episode: 2, series_name: "Show" }))).toBe("S1 E2 · Show");
    expect(itemSubtitle(item({ type: "Episode", series_name: "Show" }))).toBe("Show");
    expect(itemSubtitle(item({ type: "Movie", year: 1999 }))).toBe("1999");
    expect(itemSubtitle(item({ type: "Season", is_folder: true }))).toBe("");
    expect(itemSubtitle(item({ type: "Folder", is_folder: true }))).toBe("Folder");
    expect(itemSubtitle(item({ type: "Video", runtime: 95 }))).toBe("1m 35s");
});
