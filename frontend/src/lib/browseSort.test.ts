import { expect, test } from "bun:test";
import { pickBrowseSort } from "./browseSort";

test("pickBrowseSort: the address wins, then the saved choice, then name A to Z", () => {
    expect(pickBrowseSort("added-desc", "name-desc")).toBe("added-desc");
    expect(pickBrowseSort("", "name-desc")).toBe("name-desc");
    expect(pickBrowseSort("bogus", "name-desc")).toBe("name-desc");
    expect(pickBrowseSort("bogus", "also-bogus")).toBe("name-asc");
});
