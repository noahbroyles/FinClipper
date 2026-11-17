import { useLayoutEffect, useState } from "preact/hooks";
import { BASE } from "../lib/api";
import type { Route } from "../lib/router";

interface Props {
    route: Route;
    userName: string;
    onSearch(query: string): void;
    onSignOut(): void;
}

const NAV_LINKS = [
    { section: undefined, href: "#/", label: "Libraries" },
    { section: "clips", href: "#/clips", label: "My clips" },
    { section: "public", href: "#/public", label: "Public clips" },
];

// The bar at the top of every page: logo, page links, search and sign out.
export function TopBar({ route, userName, onSearch, onSignOut }: Props) {
    const section = route.parts[0];
    const [query, setQuery] = useState("");

    // On the search page the box shows what was searched for; going
    // anywhere else empties it. (A layout effect, so it cannot run late
    // and wipe out something typed right after the navigation.)
    useLayoutEffect(() => {
        setQuery(section === "search" ? route.params.get("q") || "" : "");
    }, [route.nav]);

    function submit(event: SubmitEvent) {
        event.preventDefault();
        const trimmed = query.trim();
        if (trimmed) onSearch(trimmed);
    }

    return (
        <header class="topbar">
            <a class="brand" href="#/">
                <img src={`${BASE}static/favicon.svg`} alt="" />
                <span>FinClipper</span>
            </a>
            <nav>
                {NAV_LINKS.map((link) => (
                    <a key={link.href} href={link.href} class={link.section === section ? "active" : undefined}>
                        {link.label}
                    </a>
                ))}
            </nav>
            <form class="search" role="search" onSubmit={submit}>
                <input
                    type="search"
                    placeholder="Search movies and shows"
                    aria-label="Search"
                    value={query}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                />
            </form>
            <div class="user">
                <span class="name">{userName}</span>
                <button class="btn small" type="button" onClick={onSignOut}>
                    Sign out
                </button>
            </div>
        </header>
    );
}
