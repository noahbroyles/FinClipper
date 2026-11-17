import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { api, BASE, requestsSettled } from "../lib/api";
import { errorMessage } from "../lib/format";
import { MeContext } from "../lib/me";
import { navigate, useRoute, type Route } from "../lib/router";
import type { Me } from "../types";
import { BrowseView } from "../views/BrowseView";
import { ClipsView } from "../views/ClipsView";
import { EditorView } from "../views/editor/EditorView";
import { HomeView } from "../views/HomeView";
import { PublicView } from "../views/PublicView";
import { SearchView } from "../views/SearchView";
import { SeriesView } from "../views/SeriesView";
import { Toast } from "./Toast";
import { TopBar } from "./TopBar";
import { Notice } from "./ui";

// The whole single page app: top bar, the view for the current address,
// and toast messages.
export function App() {
    const route = useRoute();
    const [me, setMe] = useState<Me | null>(null);
    const [error, setError] = useState("");
    const [signingOut, setSigningOut] = useState(false);

    useEffect(() => {
        api<Me>("/me").then(setMe, (cause: unknown) => setError(errorMessage(cause)));
    }, []);

    // Every page starts at the top.
    useLayoutEffect(() => window.scrollTo(0, 0), [route.nav]);

    // Signing out first removes the current view (signingOut hides it),
    // which stops its polling and makes the editor tell Jellyfin to stop
    // the preview stream. This effect runs after that, and signs out once
    // those last requests have been answered (see requestsSettled).
    useEffect(() => {
        if (!signingOut) return;
        requestsSettled(3000)
            .then(() => api("/logout", { method: "POST", body: {} }))
            .catch(() => {})
            .finally(() => {
                window.location.href = `${BASE}login`;
            });
    }, [signingOut]);

    let content = null;
    if (error) {
        content = <Notice error>{error}</Notice>;
    } else if (me && !signingOut) {
        content = (
            <MeContext.Provider value={me}>
                {/* The key makes every navigation start its view from scratch. */}
                <RouteView key={route.nav} route={route} />
            </MeContext.Provider>
        );
    }
    return (
        <>
            <TopBar
                route={route}
                userName={me?.name ?? ""}
                onSearch={(query) => navigate(`#/search?${new URLSearchParams({ q: query })}`)}
                onSignOut={() => setSigningOut(true)}
            />
            <main>{content}</main>
            <Toast />
        </>
    );
}

// Picks the view for an address like "#/library/abc?kind=movies".
function RouteView({ route }: { route: Route }) {
    const [section, id = ""] = route.parts;
    const param = (name: string) => route.params.get(name) || "";
    switch (section) {
        case undefined:
            return <HomeView />;
        case "library":
            return <BrowseView parentId={id} kind={param("kind")} name={param("name")} sortParam={param("sort")} />;
        case "series":
            return <SeriesView seriesId={id} seasonId={param("season")} />;
        case "search":
            return <SearchView query={param("q")} />;
        case "item":
            return <EditorView itemId={id} reclipId={param("reclip")} />;
        case "clips":
            return <ClipsView />;
        case "public":
            return <PublicView />;
        default:
            return <Redirect to="#/" />;
    }
}

function Redirect({ to }: { to: string }) {
    useEffect(() => {
        location.hash = to;
    }, [to]);
    return null;
}
