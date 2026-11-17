// Hash based routing: the page shown is chosen by the part of the address
// after "#", for example "#/library/abc?kind=movies".
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

export interface Route {
    // Goes up by one on every navigation, including a repeat of the same
    // address. App uses it as the key of the current view, so each
    // navigation starts the view from scratch.
    nav: number;
    // Path segments, decoded: "#/series/abc" gives ["series", "abc"].
    parts: string[];
    // The query string after "?".
    params: URLSearchParams;
}

function decode(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        // A stray "%" in a hand-typed address.
        return part;
    }
}

export function parseHash(hash: string): Pick<Route, "parts" | "params"> {
    const [path = "", query = ""] = (hash.replace(/^#/, "") || "/").split("?");
    return {
        parts: path.split("/").filter(Boolean).map(decode),
        params: new URLSearchParams(query),
    };
}

// The current route, and a function that runs it again. Assigning the same
// address to location.hash fires no hashchange event, so callers use the
// function for that case (see navigate()).
export function useRoute(): [route: Route, rerun: () => void] {
    const [nav, setNav] = useState(1);
    const rerun = useCallback(() => setNav((count) => count + 1), []);
    useEffect(() => {
        window.addEventListener("hashchange", rerun);
        return () => window.removeEventListener("hashchange", rerun);
    }, [rerun]);
    const route = useMemo(() => ({ nav, ...parseHash(location.hash) }), [nav]);
    return [route, rerun];
}

// Go to a "#/..." address, running the route again if already there.
export function navigate(target: string, rerun: () => void): void {
    if (location.hash === target) rerun();
    else location.hash = target;
}
