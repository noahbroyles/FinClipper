// Sort orders offered when browsing a library or folder. A value is
// "<sort>-<order>", the sort and order parameters of /api/items.
export const BROWSE_SORTS = [
    { value: "name-asc", label: "Name (A to Z)" },
    { value: "name-desc", label: "Name (Z to A)" },
    { value: "added-desc", label: "Date added (newest first)" },
    { value: "added-asc", label: "Date added (oldest first)" },
] as const;

export type BrowseSort = (typeof BROWSE_SORTS)[number]["value"];

const STORAGE_KEY = "finclipper.browseSort";

export function isBrowseSort(value: string): value is BrowseSort {
    return BROWSE_SORTS.some((option) => option.value === value);
}

// The sort last chosen while browsing, so other libraries open the same
// way. Storage can be unavailable (private windows, blocked site data).
export function savedBrowseSort(): string {
    try {
        return localStorage.getItem(STORAGE_KEY) || "";
    } catch {
        return "";
    }
}

export function saveBrowseSort(value: BrowseSort): void {
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Not remembered; the choice still applies to this page.
    }
}

// The sort to use: the one in the page address if there is one, then the
// last one chosen, then name A to Z.
export function pickBrowseSort(fromAddress: string, saved = savedBrowseSort()): BrowseSort {
    return [fromAddress, saved].find(isBrowseSort) || BROWSE_SORTS[0].value;
}
