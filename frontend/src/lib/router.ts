// Hash based routing: the page shown is chosen by the part of the address
// after "#", for example "#/library/abc?kind=movies".
import { useEffect, useMemo, useState } from "preact/hooks";

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

// The current route. It changes on every hashchange event, including the
// ones navigate() sends for a repeat of the same address.
export function useRoute(): Route {
    const [nav, setNav] = useState(1);
    useEffect(() => {
        const onChange = () => setNav((count) => count + 1);
        window.addEventListener("hashchange", onChange);
        return () => window.removeEventListener("hashchange", onChange);
    }, []);
    return useMemo(() => ({ nav, ...parseHash(location.hash) }), [nav]);
}

// Go to a "#/..." address. Assigning the address the page is already at to
// location.hash fires no hashchange event, so in that case one is sent by
// hand: the view then starts again from scratch (searching for the same
// thing again, re-clipping the same clip again).
export function navigate(target: string): void {
    if (location.hash === target) window.dispatchEvent(new HashChangeEvent("hashchange"));
    else location.hash = target;
}
