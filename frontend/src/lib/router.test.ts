import { expect, test } from "bun:test";
import { parseHash } from "./router";

test("an empty hash is the home page", () => {
    expect(parseHash("").parts).toEqual([]);
    expect(parseHash("#/").parts).toEqual([]);
});

test("splits the path into decoded parts", () => {
    expect(parseHash("#/series/abc123").parts).toEqual(["series", "abc123"]);
    expect(parseHash("#/library/a%20b").parts).toEqual(["library", "a b"]);
});

test("reads the query string", () => {
    const { parts, params } = parseHash("#/library/abc?kind=movies&name=My+Movies&sort=added-desc");
    expect(parts).toEqual(["library", "abc"]);
    expect(params.get("kind")).toBe("movies");
    expect(params.get("name")).toBe("My Movies");
    expect(params.get("sort")).toBe("added-desc");
    expect(params.get("missing")).toBeNull();
});

test("survives a malformed escape", () => {
    expect(parseHash("#/search/100%").parts).toEqual(["search", "100%"]);
});
