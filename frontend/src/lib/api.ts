// Client for the FinClipper JSON API.
import type { Item } from "../types";

// Path the app is served from: "/" or the reverse proxy prefix. Set by the
// page template so URLs still work behind a path prefix.
export const BASE = document.body.dataset.base || "/";

export interface ApiOptions {
    method?: string;
    // Sent as JSON.
    body?: unknown;
    // Let the request outlive the page (used when the tab is closing).
    keepalive?: boolean;
}

// Requests that have been sent and not answered yet.
const inFlight = new Set<Promise<unknown>>();

// Call the API. Throws an Error with the server's message.
export function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
    const request = send<T>(path, options);
    inFlight.add(request);
    const finished = () => inFlight.delete(request);
    request.then(finished, finished);
    return request;
}

// Resolves when every request that is under way has been answered, or
// after the timeout if some are slow.
//
// Signing out waits for this. The session lives in a cookie that the
// server sends again with every response, so the answer to an older
// request arriving after the answer to the sign out would put the session
// straight back.
export function requestsSettled(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, timeoutMs);
        void Promise.allSettled([...inFlight]).then(() => resolve());
    });
}

async function send<T>(path: string, options: ApiOptions): Promise<T> {
    const headers: Record<string, string> = {};
    const init: RequestInit = { method: options.method || "GET", headers, credentials: "same-origin" };
    if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
    }
    if (options.keepalive) init.keepalive = true;
    const response = await fetch(`${BASE}api${path}`, init);
    if (response.status === 401) {
        // The address after "#" is kept, to come back to the same page.
        window.location.href = `${BASE}login${window.location.hash}`;
        throw new Error("Your session expired, please sign in again.");
    }
    if (response.status === 204) return null as T;
    let data: unknown = null;
    try {
        data = await response.json();
    } catch {
        // Not JSON (for example a proxy error page).
    }
    if (!response.ok) {
        const message = data && typeof data === "object" && "error" in data ? data.error : null;
        throw new Error(message ? String(message) : `Request failed (HTTP ${response.status})`);
    }
    return data as T;
}

// URL of an item's artwork, scaled to the given height.
export function imageUrl(item: Item, height: number): string {
    const params = new URLSearchParams({ h: String(height), tag: item.image_tag || "" });
    return `${BASE}api/image/${item.id}?${params}`;
}
