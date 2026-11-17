// FinClipper single page app: library browser, clip editor and clip list.
// Plain JavaScript, no build step. Views are chosen by the URL hash.
"use strict";

const BASE = document.body.dataset.base || "/";
const view = document.getElementById("view");

const app = {
    me: null,
    // Incremented on every navigation. Async views compare their copy with
    // the current value so a slow response never renders over a newer page.
    nav: 0,
    // Functions to run when leaving the current view (timers, players...).
    cleanups: [],
};

// Must match MP4_VIDEO_COPY / MP4_AUDIO_COPY in finclipper/media.py. Only
// used to describe the output format before the clip is created.
const MP4_VIDEO_COPY = new Set(["h264", "hevc", "av1", "vp9", "mpeg4", "mpeg2video"]);
const MP4_AUDIO_COPY = new Set(["aac", "mp3", "ac3", "eac3"]);

// Longest clip name. Must match MAX_CLIP_NAME_LENGTH in finclipper/media.py.
const CLIP_NAME_MAX = 100;

// Vertical (9:16) output sizes as [height, width]. The height is sent as
// max_height. Must match VERTICAL_SIZES in finclipper/media.py.
const VERTICAL_SIZES = [[1920, 1080], [1280, 720], [960, 540]];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Create a DOM element. Children may be nodes, strings or (nested) arrays.
// Text is always inserted as text nodes, so item names cannot inject HTML.
function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") node.className = value;
        else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
        else if (value === true) node.setAttribute(key, "");
        else node.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

// Call the FinClipper JSON API. Throws an Error with the server's message.
async function api(path, options = {}) {
    const init = { method: options.method || "GET", headers: {}, credentials: "same-origin" };
    if (options.body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
    }
    if (options.keepalive) init.keepalive = true;
    const response = await fetch(`${BASE}api${path}`, init);
    if (response.status === 401) {
        window.location.href = `${BASE}login`;
        throw new Error("Your session expired, please sign in again.");
    }
    if (response.status === 204) return null;
    let data = null;
    try {
        data = await response.json();
    } catch (error) {
        // Not JSON (for example a proxy error page).
    }
    if (!response.ok) throw new Error((data && data.error) || `Request failed (HTTP ${response.status})`);
    return data;
}

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

// 83.5 -> "00:01:23.500"
function fmtTime(seconds, withMillis = true) {
    const totalMs = Math.max(0, Math.round((seconds || 0) * 1000));
    const h = Math.floor(totalMs / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    const s = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;
    const text = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return withMillis ? `${text}.${String(ms).padStart(3, "0")}` : text;
}

// Parse "SS(.mmm)", "MM:SS(.mmm)" or "HH:MM:SS(.mmm)". Returns NaN if invalid.
// Mirrors parse_timestamp() in finclipper/media.py.
function parseTime(text) {
    const match = /^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(String(text).trim());
    if (!match) return NaN;
    const [, first, second, last] = match;
    let hours = 0;
    let minutes = 0;
    if (second === undefined) {
        minutes = Number(first || 0);
    } else {
        hours = Number(first);
        minutes = Number(second);
        if (minutes >= 60) return NaN;
    }
    if (first !== undefined && Number(last) >= 60) return NaN;
    return hours * 3600 + minutes * 60 + Number(last);
}

// 7384 -> "2h 3m", 95 -> "1m 35s"
function fmtRuntime(seconds) {
    if (!seconds) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h) return `${h}h ${m}m`;
    if (m) return s ? `${m}m ${s}s` : `${m}m`;
    return `${s}s`;
}

function fmtBytes(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// crypto.randomUUID only exists on HTTPS pages, but getRandomValues works
// on plain HTTP too, which matters for apps reached by LAN IP address.
function randomHex(bytes) {
    const values = new Uint8Array(bytes);
    crypto.getRandomValues(values);
    return Array.from(values, (b) => b.toString(16).padStart(2, "0")).join("");
}

let toastTimer = 0;
function toast(message, isError = false) {
    const box = document.getElementById("toast");
    box.textContent = message;
    box.classList.toggle("error", isError);
    box.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.add("hidden"), isError ? 6000 : 3000);
}

function imageUrl(item, height) {
    const params = new URLSearchParams({ h: String(height), tag: item.image_tag || "" });
    return `${BASE}api/image/${item.id}?${params}`;
}

// Replace the page content. Like el(), arrays are flattened and null,
// undefined and false are skipped. replaceChildren() does neither on its
// own: it would print an array as "[object HTMLElement]" and null as "null".
function show(...nodes) {
    const children = nodes.flat(Infinity).filter((node) => node !== null && node !== undefined && node !== false);
    view.replaceChildren(...children);
}

function spinner() {
    return el("div", { class: "spinner", "aria-label": "Loading" });
}

function notice(message, isError = false) {
    return el("div", { class: isError ? "notice error" : "notice" }, message);
}

function isCurrent(nav) {
    return nav === app.nav;
}

function onLeave(fn) {
    app.cleanups.push(fn);
}

function runCleanups() {
    for (const fn of app.cleanups.splice(0)) {
        try {
            fn();
        } catch (error) {
            console.error(error);
        }
    }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route() {
    runCleanups();
    const nav = ++app.nav;
    window.scrollTo(0, 0);

    const hash = location.hash.replace(/^#/, "") || "/";
    const [path, query = ""] = hash.split("?");
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(query);

    for (const link of document.querySelectorAll("[data-nav]")) {
        const active = (link.dataset.nav === "home" && parts.length === 0) || link.dataset.nav === parts[0];
        link.classList.toggle("active", active);
    }
    if (parts[0] !== "search") document.getElementById("search-input").value = "";

    try {
        switch (parts[0]) {
            case undefined:
                await viewHome(nav);
                break;
            case "library":
                await viewBrowse(nav, parts[1], params.get("kind") || "", params.get("name") || "", params.get("sort") || "");
                break;
            case "series":
                await viewSeries(nav, parts[1], params.get("season") || "");
                break;
            case "search":
                await viewSearch(nav, params.get("q") || "");
                break;
            case "item":
                await viewEditor(nav, parts[1]);
                break;
            case "clips":
                await viewClips(nav);
                break;
            case "public":
                await viewPublic(nav);
                break;
            default:
                location.hash = "#/";
        }
    } catch (error) {
        if (isCurrent(nav)) show(notice(error.message, true));
    }
}

// ---------------------------------------------------------------------------
// Library browsing
// ---------------------------------------------------------------------------

// Where clicking an item leads.
function itemHref(item) {
    if (item.type === "Series") return `#/series/${item.id}`;
    if (item.type === "Season") return `#/series/${item.series_id}?season=${item.id}`;
    if (item.is_folder) {
        let kind = "";
        if (item.collection_type === "movies" || item.collection_type === "tvshows") kind = item.collection_type;
        const params = new URLSearchParams({ kind, name: item.name });
        return `#/library/${item.id}?${params}`;
    }
    return `#/item/${item.id}`;
}

// Episodes, videos and libraries have 16:9 thumbnails, the rest posters.
function isWide(item) {
    if (item.aspect) return item.aspect > 1.1;
    return ["Episode", "Video", "MusicVideo", "CollectionFolder", "UserView"].includes(item.type);
}

function itemSubtitle(item) {
    switch (item.type) {
        case "Episode": {
            const code = item.season != null && item.episode != null ? `S${item.season} E${item.episode}` : "";
            return [code, item.series_name].filter(Boolean).join(" · ");
        }
        case "Movie":
        case "Series":
            return item.year ? String(item.year) : "";
        case "Season":
            return "";
        default:
            if (item.is_folder) return "Folder";
            return fmtRuntime(item.runtime);
    }
}

function itemCard(item, wide = isWide(item)) {
    const initials = (item.name || "?").trim().slice(0, 1).toUpperCase();
    const thumb = item.image_tag
        ? el("img", { src: imageUrl(item, wide ? 270 : 360), alt: "", loading: "lazy" })
        : el("div", { class: "placeholder" }, initials);
    return el(
        "a",
        { class: wide ? "card wide" : "card", href: itemHref(item), title: item.name },
        el("div", { class: "thumb" }, thumb),
        el("div", { class: "card-title" }, item.name),
        el("div", { class: "card-sub" }, itemSubtitle(item) || " "),
    );
}

function cardGrid(items) {
    // Use the wide layout when most items have landscape thumbnails.
    const wideCount = items.filter((item) => isWide(item)).length;
    const wide = wideCount > items.length / 2;
    return el("div", { class: wide ? "grid landscape" : "grid" }, items.map((item) => itemCard(item, wide)));
}

async function viewHome(nav) {
    show(spinner());
    const data = await api("/libraries");
    if (!isCurrent(nav)) return;
    show(
        el("div", { class: "page-head" }, el("h1", {}, "Libraries")),
        data.items.length ? cardGrid(data.items) : notice("No video libraries are available to your account."),
    );
}

// Sort orders offered when browsing a library or folder, as [value, label].
// A value is "<sort>-<order>", the sort and order parameters of /api/items.
const BROWSE_SORTS = [
    ["name-asc", "Name (A to Z)"],
    ["name-desc", "Name (Z to A)"],
    ["added-desc", "Date added (newest first)"],
    ["added-asc", "Date added (oldest first)"],
];
const BROWSE_SORT_KEY = "finclipper.browseSort";

// The sort last chosen while browsing, so other libraries open the same
// way. Storage can be unavailable (private windows, blocked site data).
function savedBrowseSort() {
    try {
        return localStorage.getItem(BROWSE_SORT_KEY) || "";
    } catch {
        return "";
    }
}

function saveBrowseSort(value) {
    try {
        localStorage.setItem(BROWSE_SORT_KEY, value);
    } catch {
        // Not remembered; the choice still applies to this page.
    }
}

function isBrowseSort(value) {
    return BROWSE_SORTS.some(([option]) => option === value);
}

// sortParam is the "sort" value from the page address. Without one, the
// last sort chosen is used, and name A to Z if there is none.
async function viewBrowse(nav, parentId, kind, name, sortParam) {
    show(spinner());
    const sort = [sortParam, savedBrowseSort()].find(isBrowseSort) || BROWSE_SORTS[0][0];
    const [sortBy, sortOrder] = sort.split("-");
    const pageSize = 100;
    let loaded = 0;
    let grid = null;
    const count = el("span", { class: "muted" });
    const moreButton = el("button", { class: "btn", type: "button" }, "Load more");
    const more = el("div", { class: "load-more hidden" }, moreButton);
    const container = el("div");

    async function loadPage() {
        const params = new URLSearchParams({
            parent_id: parentId,
            kind,
            sort: sortBy,
            order: sortOrder,
            start: String(loaded),
            limit: String(pageSize),
        });
        const data = await api(`/items?${params}`);
        if (!isCurrent(nav)) return;
        if (grid === null) {
            // The first page decides poster or wide layout for the whole view.
            grid = cardGrid(data.items);
            container.append(data.items.length ? grid : notice("This folder is empty."));
        } else {
            const wide = grid.classList.contains("landscape");
            grid.append(...data.items.map((item) => itemCard(item, wide)));
        }
        loaded += data.items.length;
        count.textContent = `${data.total} ${data.total === 1 ? "item" : "items"}`;
        more.classList.toggle("hidden", loaded >= data.total || data.items.length === 0);
    }

    moreButton.addEventListener("click", async () => {
        moreButton.disabled = true;
        try {
            await loadPage();
        } catch (error) {
            toast(error.message, true);
        } finally {
            moreButton.disabled = false;
        }
    });

    // Changing the sort puts it in the page address (so reloading keeps it)
    // and loads the page again. replace() avoids a history entry per change,
    // so Back still leaves the library.
    const sortSelect = el(
        "select",
        { "aria-label": "Sort by" },
        BROWSE_SORTS.map(([value, label]) => el("option", { value }, label)),
    );
    sortSelect.value = sort;
    sortSelect.addEventListener("change", () => {
        saveBrowseSort(sortSelect.value);
        const params = new URLSearchParams({ kind, name, sort: sortSelect.value });
        location.replace(`#/library/${encodeURIComponent(parentId)}?${params}`);
    });

    await loadPage();
    if (!isCurrent(nav)) return;
    show(
        el("div", { class: "page-head" }, el("h1", {}, name || "Library"), count, el("label", { class: "sort" }, "Sort", sortSelect)),
        container,
        more,
    );
}

async function viewSeries(nav, seriesId, seasonId) {
    show(spinner());
    const [series, seasons] = await Promise.all([api(`/item/${seriesId}`), api(`/series/${seriesId}/seasons`)]);
    if (!isCurrent(nav)) return;

    const selected = seasonId || (seasons.items[0] && seasons.items[0].id) || "";
    const params = new URLSearchParams(selected ? { season_id: selected } : {});
    const episodes = await api(`/series/${seriesId}/episodes?${params}`);
    if (!isCurrent(nav)) return;

    const tabs = el(
        "div",
        { class: "tabs" },
        seasons.items.map((season) =>
            el(
                "a",
                { href: `#/series/${seriesId}?season=${season.id}`, class: season.id === selected ? "active" : "" },
                season.name,
            ),
        ),
    );
    show(
        el("div", { class: "page-head" }, el("h1", {}, series.name), series.year ? el("span", { class: "muted" }, series.year) : null),
        seasons.items.length > 1 ? tabs : null,
        episodes.items.length
            ? el("div", { class: "grid landscape" }, episodes.items.map((episode) => itemCard(episode, true)))
            : notice("No episodes found."),
    );
}

async function viewSearch(nav, query) {
    document.getElementById("search-input").value = query;
    if (!query) {
        show(notice("Type something in the search box."));
        return;
    }
    show(spinner());
    const data = await api(`/items?${new URLSearchParams({ q: query, limit: "80" })}`);
    if (!isCurrent(nav)) return;

    // Group results by type so movies, shows and episodes are easy to scan.
    const groups = [
        ["Movies", ["Movie"]],
        ["Shows", ["Series"]],
        ["Episodes", ["Episode"]],
        ["Other videos", ["Video", "MusicVideo"]],
    ];
    const sections = [];
    for (const [title, types] of groups) {
        const items = data.items.filter((item) => types.includes(item.type));
        if (items.length) {
            sections.push(el("section", { style: "margin-bottom: 28px" }, el("h3", {}, title), cardGrid(items)));
        }
    }
    show(
        el("div", { class: "page-head" }, el("h1", {}, `Results for "${query}"`)),
        sections.length ? sections : notice("Nothing found."),
    );
}

// ---------------------------------------------------------------------------
// Clip jobs (shared by the editor and the "My clips" page)
// ---------------------------------------------------------------------------

function jobStatusText(job) {
    switch (job.status) {
        case "queued":
            return "Waiting in queue...";
        case "running":
            // "preparing" is the subtitle download before ffmpeg starts.
            if (job.phase === "preparing") return "Preparing subtitles...";
            return `Cutting... ${Math.round(job.progress * 100)}%`;
        case "done":
            return `Ready · ${fmtBytes(job.size)}`;
        case "failed":
            return `Failed: ${job.error || "unknown error"}`;
        case "cancelled":
            return "Cancelled";
        default:
            return job.status;
    }
}

// A self-refreshing list of clip jobs. Polls once a second while any job
// is queued or running, and stops polling when everything is finished.
function createJobList(itemId, { showItemLink = false, emptyText = "No clips yet." } = {}) {
    const element = el("div", { class: "jobs" });
    let jobs = [];
    let timer = 0;
    // The clip whose name is being edited, as { id, value } (value is what
    // has been typed so far), or null when no rename form is open.
    let editing = null;

    function isActive(job) {
        return job.status === "queued" || job.status === "running";
    }

    function schedule(delay = 1000) {
        clearTimeout(timer);
        if (jobs.some(isActive)) timer = setTimeout(refresh, delay);
    }

    async function refresh() {
        try {
            const params = itemId ? `?${new URLSearchParams({ item_id: itemId })}` : "";
            const data = await api(`/clips${params}`);
            jobs = data.items;
            render();
            schedule();
        } catch (error) {
            // Keep the last known state and retry a little later.
            schedule(3000);
        }
    }

    async function action(promise, failureMessage) {
        try {
            await promise;
        } catch (error) {
            toast(error.message || failureMessage, true);
        }
        await refresh();
    }

    // Close the rename form and show the list as it is now.
    function stopRename() {
        editing = null;
        render(true);
        schedule();
    }

    function startRename(job) {
        editing = { id: job.id, value: job.name };
        render(true);
        const input = element.querySelector(".job-rename input");
        if (input) {
            input.focus();
            input.select();
        }
    }

    // Inline form that replaces the title of the clip being renamed.
    function renameForm(job) {
        const input = el("input", {
            type: "text",
            maxlength: String(CLIP_NAME_MAX),
            placeholder: job.title,
            spellcheck: "false",
            autocomplete: "off",
            "aria-label": "Clip name",
        });
        input.value = editing.value;
        input.addEventListener("input", () => (editing.value = input.value));
        input.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                stopRename();
            }
        });
        const save = el("button", { class: "btn small primary", type: "submit" }, "Save");
        const form = el(
            "form",
            { class: "job-rename" },
            input,
            save,
            el("button", { class: "btn small", type: "button", onclick: stopRename }, "Cancel"),
        );
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            save.disabled = true;
            try {
                const updated = await api(`/clips/${job.id}/rename`, { method: "POST", body: { name: input.value } });
                jobs = jobs.map((other) => (other.id === updated.id ? updated : other));
            } catch (error) {
                // Keep the form open so the typed name is not lost.
                toast(error.message, true);
                save.disabled = false;
                return;
            }
            stopRename();
        });
        return form;
    }

    function row(job) {
        const actions = [];
        if (job.status === "done") {
            actions.push(
                el("a", { class: "btn small primary", href: `${BASE}api/clips/${job.id}/download`, download: job.filename }, "Download"),
            );
        }
        actions.push(el("button", { class: "btn small", type: "button", onclick: () => startRename(job) }, "Rename"));
        if (job.status === "done") {
            // Sharing puts the clip under "Public clips" for other users.
            const share = async () => {
                await api(`/clips/${job.id}/public`, { method: "POST", body: { public: !job.public } });
                toast(job.public
                    ? "The clip is private again."
                    : "Shared. Other users who can see this video in Jellyfin will find it under Public clips.");
            };
            actions.push(
                el("button", { class: "btn small", type: "button", onclick: () => action(share(), "Could not change sharing") },
                    job.public ? "Make private" : "Make public"),
            );
        }
        if (isActive(job)) {
            actions.push(
                el("button", {
                    class: "btn small",
                    type: "button",
                    onclick: () => action(api(`/clips/${job.id}/cancel`, { method: "POST", body: {} }), "Cancel failed"),
                }, "Cancel"),
            );
        } else {
            actions.push(
                el("button", {
                    class: "btn small danger",
                    type: "button",
                    onclick: () => action(api(`/clips/${job.id}`, { method: "DELETE" }), "Delete failed"),
                }, "Delete"),
            );
        }
        // A named clip shows its name as the heading and the video title
        // underneath; an unnamed clip just shows the video title.
        const itemTitle = showItemLink ? el("a", { href: `#/item/${job.item_id}` }, job.title) : job.title;
        let heading;
        if (editing && editing.id === job.id) heading = renameForm(job);
        else heading = el("div", { class: "job-title", title: job.name || job.title }, job.name || itemTitle);
        return el(
            "div",
            { class: "job" },
            heading,
            job.name ? el("div", { class: "job-meta job-item", title: job.title }, itemTitle) : null,
            el("div", { class: "job-meta mono" }, `${fmtTime(job.start)} → ${fmtTime(job.end)}  (${fmtRuntime(job.duration) || "0s"})`),
            el("div", { class: "job-meta" }, job.description),
            el("div", { class: `job-status ${job.status}` }, jobStatusText(job), job.public ? el("span", { class: "badge" }, "Public") : null),
            isActive(job) ? el("div", { class: "progress" }, el("div", { style: `width: ${Math.round(job.progress * 100)}%` })) : null,
            el("div", { class: "job-actions" }, actions),
        );
    }

    // Rebuild the list. The once-a-second refresh skips this while focus is
    // inside the rename form, because rebuilding would move the caret and
    // blur the input mid-typing; force skips that check.
    function render(force = false) {
        if (!force && editing && document.activeElement && document.activeElement.closest(".job-rename")) return;
        // Forget a rename whose clip has been deleted or has expired.
        if (editing && !jobs.some((job) => job.id === editing.id)) editing = null;
        element.replaceChildren(...(jobs.length ? jobs.map(row) : [el("div", { class: "muted" }, emptyText)]));
    }

    function add(job) {
        jobs.unshift(job);
        render();
        schedule();
    }

    onLeave(() => clearTimeout(timer));
    return { element, refresh, add };
}

async function viewClips(nav) {
    show(spinner());
    const list = createJobList(null, {
        showItemLink: true,
        emptyText: "You have no clips. Open a movie or episode to make one.",
    });
    await list.refresh();
    if (!isCurrent(nav)) return;
    show(
        el("div", { class: "page-head" }, el("h1", {}, "My clips")),
        el(
            "p",
            { class: "muted" },
            `Finished clips are deleted ${app.me.clip_retention_hours} hours after they are made (or after you make them private), so download the ones you want to keep. `,
            publicRetentionText("Public clips stay until you make them private.", "Public clips are deleted {hours} hours after you share them."),
        ),
        list.element,
    );
}

// How long public clips last, from PUBLIC_CLIP_RETENTION_HOURS (0 means
// until they are made private). "{hours}" in the second text is replaced.
function publicRetentionText(forever, limited) {
    const hours = app.me.public_clip_retention_hours;
    return hours ? limited.replace("{hours}", String(hours)) : forever;
}

// Clips other users (and you) have shared. The server only lists clips cut
// from videos your Jellyfin account can see.
async function viewPublic(nav) {
    show(spinner());
    const data = await api("/public-clips");
    if (!isCurrent(nav)) return;

    let clips = data.items;
    const list = el("div", { class: "jobs" });
    const players = [];

    // Show or hide an inline player for a clip (MP4 only; browsers rarely play MKV).
    function togglePlayer(box, clip) {
        const existing = box.querySelector("video");
        if (existing) {
            existing.pause();
            existing.removeAttribute("src");
            existing.load();
            box.replaceChildren();
            box.classList.add("hidden");
            return;
        }
        const player = el("video", {
            controls: true,
            autoplay: true,
            playsinline: true,
            src: `${BASE}api/public-clips/${clip.id}/download?inline=1`,
        });
        players.push(player);
        box.replaceChildren(player);
        box.classList.remove("hidden");
    }

    async function unshare(clip) {
        try {
            await api(`/clips/${clip.id}/public`, { method: "POST", body: { public: false } });
        } catch (error) {
            toast(error.message, true);
            return;
        }
        clips = clips.filter((other) => other.id !== clip.id);
        render();
        toast(clip.mine ? "The clip is private again." : "The clip was taken down.");
    }

    function row(clip) {
        const playerBox = el("div", { class: "public-player hidden" });
        const actions = [];
        if (data.can_download) {
            if (clip.playable) {
                actions.push(el("button", { class: "btn small primary", type: "button", onclick: () => togglePlayer(playerBox, clip) }, "Watch"));
            }
            actions.push(
                el("a", { class: "btn small", href: `${BASE}api/public-clips/${clip.id}/download`, download: clip.filename }, "Download"),
            );
        }
        // Owners can stop sharing; administrators can take down anyone's clip.
        if (clip.mine || app.me.is_admin) {
            actions.push(
                el("button", { class: "btn small danger", type: "button", onclick: () => unshare(clip) }, clip.mine ? "Make private" : "Take down"),
            );
        }
        // Same layout as "My clips": a named clip shows the video title below its name.
        const itemTitle = el("a", { href: `#/item/${clip.item_id}` }, clip.title);
        const sharer = clip.mine ? "you" : clip.owner_name || "another user";
        return el(
            "div",
            { class: "job" },
            el("div", { class: "job-title", title: clip.name || clip.title }, clip.name || itemTitle),
            clip.name ? el("div", { class: "job-meta job-item", title: clip.title }, itemTitle) : null,
            el("div", { class: "job-meta" }, `Shared by ${sharer} · ${fmtRuntime(clip.duration) || "0s"} · ${fmtBytes(clip.size)}`),
            el("div", { class: "job-meta" }, clip.description),
            playerBox,
            actions.length ? el("div", { class: "job-actions" }, actions) : null,
        );
    }

    function render() {
        list.replaceChildren(
            ...(clips.length
                ? clips.map(row)
                : [el("div", { class: "muted" }, "No public clips yet. Use \"Make public\" on one of your clips under My clips to share it.")]),
        );
    }

    // Stop any playing clip when leaving the page.
    onLeave(() => players.forEach((player) => player.pause()));

    render();
    show(
        el("div", { class: "page-head" }, el("h1", {}, "Public clips")),
        el(
            "p",
            { class: "muted" },
            "Clips shared by people on this server, from videos your Jellyfin account can see. ",
            publicRetentionText(
                "They stay here until the person who shared them makes them private.",
                "Shared clips are removed {hours} hours after they are shared.",
            ),
        ),
        data.can_download ? null : notice("Your Jellyfin account is not allowed to download media, so you cannot watch or download clips."),
        list,
    );
}

// ---------------------------------------------------------------------------
// Clip editor
// ---------------------------------------------------------------------------

function editorHeader(item) {
    const meta = [];
    if (item.type === "Episode" && item.series_id) {
        meta.push(el("a", { href: `#/series/${item.series_id}` }, item.series_name || "Series"));
    }
    if (item.year && item.type !== "Episode") meta.push(String(item.year));
    if (item.runtime) meta.push(fmtRuntime(item.runtime));
    const back = el(
        "button",
        {
            class: "btn small",
            type: "button",
            title: "Back",
            onclick: () => (history.length > 1 ? history.back() : (location.hash = "#/")),
        },
        "← Back",
    );
    return el(
        "div",
        { class: "editor-head" },
        back,
        el(
            "div",
            {},
            el("h1", {}, item.title || item.name),
            el("div", { class: "muted" }, meta.flatMap((part, i) => (i ? [" · ", part] : [part]))),
        ),
    );
}

async function viewEditor(nav, itemId) {
    show(spinner());
    const item = await api(`/item/${itemId}`);
    if (!isCurrent(nav)) return;

    if (item.problem) {
        show(editorHeader(item), notice(item.problem, true));
        return;
    }
    const sources = item.sources.filter((source) => !source.problem);
    if (!sources.length) {
        show(editorHeader(item), notice((item.sources[0] && item.sources[0].problem) || "No usable version of this video.", true));
        return;
    }

    const maxClip = app.me.max_clip_seconds;
    const ed = {
        source: sources[0],
        audioIndex: sources[0].default_audio ?? -1,
        duration: sources[0].duration || item.runtime || 0,
        start: 0,
        end: 0,
        stopAt: null, // when playing the selection, pause at this time
        hls: null,
        playSession: null,
        recoveredMediaError: false,
        // Player time minus source time. Jellyfin's HLS segments start the
        // video a little after the audio (the H.264 B-frame delay, usually
        // two frames), and hls.js puts the earliest sample at zero, so every
        // frame shows up slightly late on the player's clock. All editor
        // times (start, end, playhead) are source times, so the clip matches
        // exactly what was on screen. Measured from the first fragment.
        offset: 0,
        offsetMeasured: false,
        // Shape of the clip: "horizontal" (like the source) or "vertical"
        // (9:16). fit says how the picture fills a vertical frame and cropX
        // (0 = left edge, 1 = right edge) where a crop sits.
        layout: "horizontal",
        fit: "crop",
        cropX: 0.5,
        // Stream index of the subtitles to burn in, or null for none.
        subtitleIndex: null,
    };
    ed.end = Math.min(ed.duration, 30);

    // ----- player -----

    const video = el("video", { controls: true, playsinline: true, preload: "auto" });
    const playerError = el("div", { class: "notice error player-error hidden" });

    function showPlayerError(message) {
        playerError.textContent = message;
        playerError.classList.remove("hidden");
    }

    // The preview is Jellyfin's own HLS stream, proxied through FinClipper.
    // H.264/AAC is requested so every browser can play it; Jellyfin copies
    // the original streams when they already fit. resumeAt is a source time.
    function startPreview(resumeAt = 0) {
        stopPreview();
        ed.playSession = randomHex(16);
        ed.recoveredMediaError = false;
        const params = new URLSearchParams({
            MediaSourceId: ed.source.id,
            PlaySessionId: ed.playSession,
            VideoCodec: "h264",
            AudioCodec: "aac",
            TranscodingMaxAudioChannels: "2",
            VideoBitRate: "10000000",
            AudioBitRate: "192000",
            MaxWidth: "1920",
            MaxHeight: "1080",
            SegmentContainer: "ts",
        });
        if (ed.audioIndex >= 0) params.set("AudioStreamIndex", String(ed.audioIndex));
        const url = `${BASE}api/stream/${item.id}/master.m3u8?${params}`;
        playerError.classList.add("hidden");

        if (window.Hls && Hls.isSupported()) {
            const hls = new Hls({ startPosition: resumeAt > 0 ? resumeAt + ed.offset : -1, maxBufferLength: 30 });
            ed.hls = hls;
            hls.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
                // The first segment starts at source time 0, so the start
                // PTS of its video is exactly the offset. Later reloads (audio
                // track changes) keep the value measured here.
                const frag = data.frag;
                if (ed.offsetMeasured || frag.type !== "main" || frag.sn !== 0) return;
                const videoInfo = frag.elementaryStreams && frag.elementaryStreams.video;
                if (!videoInfo || !Number.isFinite(videoInfo.startPTS)) return;
                ed.offsetMeasured = true;
                const offset = videoInfo.startPTS - frag.start;
                // Anything over half a second is not a decoder delay; ignore it.
                if (offset > 0 && offset < 0.5) ed.offset = offset;
            });
            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (!data.fatal) return;
                if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !ed.recoveredMediaError) {
                    ed.recoveredMediaError = true;
                    hls.recoverMediaError();
                    return;
                }
                showPlayerError(
                    `The preview could not be played (${data.details}). You can still type the start and end times and create the clip.`,
                );
            });
            hls.loadSource(url);
            hls.attachMedia(video);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
            // Safari on iOS has no MediaSource support but plays HLS natively.
            video.src = url;
            if (resumeAt > 0) {
                video.addEventListener("loadedmetadata", () => (video.currentTime = resumeAt), { once: true });
            }
        } else {
            showPlayerError("This browser cannot play the preview stream.");
        }
    }

    // Stop the player and tell Jellyfin to stop transcoding for it.
    function stopPreview() {
        if (ed.hls) {
            ed.hls.destroy();
            ed.hls = null;
        }
        if (video.getAttribute("src")) {
            video.removeAttribute("src");
            video.load();
        }
        if (ed.playSession) {
            const playSessionId = ed.playSession;
            ed.playSession = null;
            api("/stream/stop", { method: "POST", body: { play_session_id: playSessionId }, keepalive: true }).catch(() => {});
        }
    }

    video.addEventListener("loadedmetadata", () => {
        // Jellyfin did not report a runtime; fall back to the stream length.
        if (!ed.duration && Number.isFinite(video.duration)) {
            ed.duration = video.duration;
            ed.end = Math.min(ed.duration, 30);
            updateRange();
        }
    });

    // Current playback position as a source time.
    function sourceTime() {
        return Math.max(0, video.currentTime - ed.offset);
    }

    // Seek the player to a source time.
    function seek(time) {
        const limit = ed.duration || video.duration || time;
        video.currentTime = clamp(time, 0, limit) + ed.offset;
    }

    function playSelection() {
        ed.stopAt = ed.end;
        seek(ed.start);
        video.play().catch(() => {});
    }

    video.addEventListener("pause", () => (ed.stopAt = null));
    video.addEventListener("seeking", () => {
        // A manual seek outside the selection ends "play selection" mode.
        const now = sourceTime();
        if (ed.stopAt !== null && (now < ed.start - 0.5 || now > ed.stopAt)) ed.stopAt = null;
    });

    // ----- timeline -----

    const range = el("div", { class: "tl-range" });
    const startHandle = el("div", { class: "tl-handle", title: "Drag to set the start" });
    const endHandle = el("div", { class: "tl-handle", title: "Drag to set the end" });
    const playhead = el("div", { class: "tl-playhead" });
    const track = el("div", { class: "tl-track" }, range, startHandle, endHandle, playhead);
    const playheadLabel = el("span", { class: "mono" });
    const timeline = el(
        "div",
        { class: "timeline" },
        track,
        el("div", { class: "tl-labels" }, el("span", { class: "mono" }, fmtTime(0, false)), playheadLabel, el("span", { class: "mono tl-total" })),
    );

    function percent(time) {
        if (!ed.duration) return "0%";
        return `${clamp(time / ed.duration, 0, 1) * 100}%`;
    }

    function timeAt(clientX) {
        const rect = track.getBoundingClientRect();
        return clamp((clientX - rect.left) / rect.width, 0, 1) * ed.duration;
    }

    // Pointer events cover mouse, touch and pen. Dragging a handle moves the
    // start or end; pressing anywhere else on the track seeks the player.
    track.addEventListener("pointerdown", (event) => {
        if (!ed.duration || event.button !== 0) return;
        event.preventDefault();
        const which = event.target === startHandle ? "start" : event.target === endHandle ? "end" : "seek";
        track.setPointerCapture(event.pointerId);

        const apply = (clientX) => {
            const time = timeAt(clientX);
            if (which === "start") setStart(time);
            else if (which === "end") setEnd(time);
            else playhead.style.left = percent(time);
        };
        apply(event.clientX);

        const onMove = (moveEvent) => apply(moveEvent.clientX);
        const onUp = (upEvent) => {
            track.removeEventListener("pointermove", onMove);
            track.removeEventListener("pointerup", onUp);
            track.removeEventListener("pointercancel", onUp);
            // Seek once at the end of the drag; seeking on every move would
            // flood Jellyfin with segment requests.
            if (which === "start") seek(ed.start);
            else if (which === "end") seek(ed.end);
            else seek(timeAt(upEvent.clientX));
        };
        track.addEventListener("pointermove", onMove);
        track.addEventListener("pointerup", onUp);
        track.addEventListener("pointercancel", onUp);
    });

    // ----- range inputs -----

    function timeInput(label, apply) {
        const input = el("input", { type: "text", class: "mono", spellcheck: "false", autocomplete: "off", "aria-label": label });
        input.addEventListener("input", () => input.classList.remove("invalid"));
        input.addEventListener("change", () => {
            const time = parseTime(input.value);
            if (Number.isNaN(time)) {
                input.classList.add("invalid");
                return;
            }
            apply(time);
        });
        return input;
    }

    const startInput = timeInput("Start time", (time) => setStart(time));
    const endInput = timeInput("End time", (time) => setEnd(time));
    const durationLabel = el("span", { class: "duration mono" });
    const limitLabel = el("span", { class: "muted" }, maxClip ? `Maximum ${fmtRuntime(maxClip)}` : "");

    function rangeRow(label, input, which) {
        const nudge = (delta) => (which === "start" ? setStart(ed.start + delta) : setEnd(ed.end + delta));
        return el(
            "div",
            { class: "range-row" },
            el("label", {}, label),
            input,
            el("button", {
                class: "btn small",
                type: "button",
                title: `Set the ${label.toLowerCase()} to the current playback position (${which === "start" ? "I" : "O"})`,
                onclick: () => (which === "start" ? setStart(sourceTime()) : setEnd(sourceTime())),
            }, "Set to playhead"),
            el("button", {
                class: "btn small",
                type: "button",
                title: `Jump to the ${label.toLowerCase()} (${which === "start" ? "[" : "]"})`,
                onclick: () => seek(which === "start" ? ed.start : ed.end),
            }, "Go to"),
            el(
                "div",
                { class: "nudges" },
                [-1, -0.1, 0.1, 1].map((delta) =>
                    el("button", { class: "btn small mono", type: "button", onclick: () => nudge(delta) }, `${delta > 0 ? "+" : "-"}${Math.abs(delta)}s`),
                ),
            ),
        );
    }

    // Times are kept to the millisecond, the precision the server accepts.
    function round(time) {
        return Math.round(time * 1000) / 1000;
    }

    // Moving the start past the end (or the end before the start) pushes the
    // other side along, keeping the previous clip length where possible.
    function setStart(time) {
        const length = Math.max(ed.end - ed.start, 1);
        const limit = ed.duration || time;
        ed.start = round(clamp(time, 0, limit));
        if (ed.end <= ed.start) ed.end = round(Math.min(limit, ed.start + length));
        if (ed.end <= ed.start) ed.start = round(Math.max(0, ed.end - length));
        updateRange();
    }

    function setEnd(time) {
        const length = Math.max(ed.end - ed.start, 1);
        const limit = ed.duration || time;
        ed.end = round(clamp(time, 0, limit));
        if (ed.end <= ed.start) ed.start = round(Math.max(0, ed.end - length));
        if (ed.end <= ed.start) ed.end = round(Math.min(limit, ed.start + length));
        updateRange();
    }

    // ----- options -----

    const versionSelect = el(
        "select",
        {},
        sources.map((source, i) => el("option", { value: String(i) }, source.name)),
    );
    const audioSelect = el("select", {});
    const modeName = `mode-${randomHex(4)}`;
    const fastRadio = el("input", { type: "radio", name: modeName, value: "fast", checked: true });
    const preciseRadio = el("input", { type: "radio", name: modeName, value: "precise" });
    const heightSelect = el("select", {});
    const heightField = el("label", { class: "field hidden" }, el("span", {}, "Resolution"), heightSelect);
    // Shown when Fast mode is unavailable because of the options below.
    const modeNote = el(
        "p",
        { class: "output-note hidden" },
        "Fast mode copies the video as it is, so it cannot add subtitles or change the shape. Precise mode is used.",
    );

    const subtitleSelect = el("select", {});
    const styleSelect = el(
        "select",
        {},
        app.me.subtitle_styles.map((style) => el("option", { value: style.id }, style.label)),
    );
    const styleField = el("label", { class: "field hidden" }, el("span", {}, "Subtitle style"), styleSelect);
    const subtitleNote = el("p", { class: "output-note hidden" });

    const layoutName = `layout-${randomHex(4)}`;
    const horizontalRadio = el("input", { type: "radio", name: layoutName, value: "horizontal", checked: true });
    const verticalRadio = el("input", { type: "radio", name: layoutName, value: "vertical" });
    const fitSelect = el(
        "select",
        {},
        el("option", { value: "crop" }, "Crop to fill the screen"),
        el("option", { value: "blur" }, "Whole picture, blurred background"),
        el("option", { value: "bars" }, "Whole picture, black bars"),
    );
    const fitField = el("label", { class: "field hidden" }, el("span", {}, "Framing"), fitSelect);
    const cropSlider = el("input", { type: "range", min: "0", max: "100", step: "1", value: "50" });
    const cropField = el(
        "label",
        { class: "field hidden" },
        el("span", {}, "Crop position (shown on the preview)"),
        cropSlider,
    );
    const outputNote = el("p", { class: "output-note" });
    // Optional clip name. Left empty, the clip is named after the video.
    const nameInput = el("input", {
        type: "text",
        maxlength: String(CLIP_NAME_MAX),
        placeholder: "Optional, defaults to the video title",
        spellcheck: "false",
        autocomplete: "off",
    });
    const createButton = el("button", { class: "btn primary create", type: "button" }, "Create clip");

    function fillAudioOptions() {
        const options = ed.source.audio.map((track) =>
            el("option", { value: String(track.index), selected: track.index === ed.audioIndex }, track.title),
        );
        options.push(el("option", { value: "-1", selected: ed.audioIndex === -1 }, "No audio"));
        audioSelect.replaceChildren(...options);
    }

    // Horizontal clips offer a maximum height (never above the source);
    // vertical clips offer fixed phone screen sizes.
    function fillHeightOptions() {
        if (ed.layout === "vertical") {
            heightSelect.replaceChildren(
                ...VERTICAL_SIZES.map(([height, width]) => el("option", { value: String(height) }, `${width} × ${height}`)),
            );
            return;
        }
        const sourceHeight = (ed.source.video && ed.source.video.height) || 0;
        const options = [el("option", { value: "0" }, sourceHeight ? `Original (${sourceHeight}p)` : "Original")];
        for (const height of [2160, 1440, 1080, 720, 480, 360]) {
            if (!sourceHeight || height < sourceHeight) options.push(el("option", { value: String(height) }, `${height}p`));
        }
        heightSelect.replaceChildren(...options);
    }

    // Subtitle tracks of the selected version. Indexes differ between
    // versions, so switching version resets the choice to none.
    function fillSubtitleOptions() {
        ed.subtitleIndex = null;
        const tracks = ed.source.subtitles || [];
        const options = [el("option", { value: "" }, tracks.length ? "None" : "None (this video has no subtitles)")];
        for (const track of tracks) {
            options.push(el("option", { value: String(track.index) }, track.kind === "bitmap" ? `${track.title} (picture)` : track.title));
        }
        subtitleSelect.replaceChildren(...options);
        subtitleSelect.disabled = !tracks.length;
    }

    function selectedSubtitle() {
        return (ed.source.subtitles || []).find((track) => track.index === ed.subtitleIndex) || null;
    }

    function selectedMode() {
        return preciseRadio.checked ? "precise" : "fast";
    }

    // Show the fields that apply to the current choices, and switch to
    // Precise mode when subtitles or a vertical shape are chosen, since Fast
    // mode copies the video untouched and can do neither.
    function updateOptions() {
        const subtitle = selectedSubtitle();
        const needsPrecise = ed.layout === "vertical" || subtitle !== null;
        if (needsPrecise) preciseRadio.checked = true;
        fastRadio.disabled = needsPrecise;
        modeNote.classList.toggle("hidden", !needsPrecise);

        styleField.classList.toggle("hidden", !subtitle || subtitle.kind !== "text");
        subtitleNote.classList.toggle("hidden", !subtitle);
        if (subtitle) {
            subtitleNote.textContent = subtitle.kind === "bitmap"
                ? "Picture subtitles keep their original look. The preview player does not show subtitles."
                : "The preview player does not show subtitles.";
        }
        fitField.classList.toggle("hidden", ed.layout !== "vertical");
        cropField.classList.toggle("hidden", ed.layout !== "vertical" || ed.fit !== "crop");
        updateCropGuide();
        updateOutputNote();
    }

    // Describe the output before it is made (mirrors plan_output in media.py).
    function updateOutputNote() {
        const precise = selectedMode() === "precise";
        heightField.classList.toggle("hidden", !precise);
        if (precise) {
            const shape = ed.layout === "vertical" ? "vertical (9:16) " : "";
            const subtitles = selectedSubtitle() ? ", with the subtitles burned in" : "";
            outputNote.textContent = `Output: ${shape}H.264 video with stereo AAC audio in an MP4 file${subtitles}.`;
            return;
        }
        const videoCodec = ((ed.source.video && ed.source.video.codec) || "").toLowerCase();
        const audioTrack = ed.source.audio.find((track) => track.index === ed.audioIndex);
        const audioCodec = audioTrack ? (audioTrack.codec || "").toLowerCase() : "";
        if (MP4_VIDEO_COPY.has(videoCodec)) {
            let text = `Output: original ${videoCodec} video`;
            if (audioTrack) {
                text += MP4_AUDIO_COPY.has(audioCodec) ? ` and ${audioCodec} audio` : `, ${audioCodec} audio converted to AAC`;
            }
            outputNote.textContent = `${text}, in an MP4 file.`;
        } else {
            outputNote.textContent = `Output: original ${videoCodec || "video"}${audioTrack ? ` and ${audioCodec} audio` : ""} in an MKV file (this codec does not fit in MP4). It will start on a keyframe.`;
        }
    }

    versionSelect.addEventListener("change", () => {
        const resumeAt = sourceTime();
        ed.source = sources[Number(versionSelect.value)];
        ed.audioIndex = ed.source.default_audio ?? -1;
        if (ed.source.duration) ed.duration = ed.source.duration;
        setEnd(ed.end);
        fillAudioOptions();
        fillHeightOptions();
        fillSubtitleOptions();
        updateOptions();
        startPreview(resumeAt);
    });

    audioSelect.addEventListener("change", () => {
        ed.audioIndex = Number(audioSelect.value);
        updateOutputNote();
        if (ed.audioIndex >= 0) {
            video.muted = false;
            startPreview(sourceTime());
        } else {
            // "No audio" only affects the clip; mute the preview to match.
            video.muted = true;
        }
    });

    fastRadio.addEventListener("change", updateOutputNote);
    preciseRadio.addEventListener("change", updateOutputNote);

    subtitleSelect.addEventListener("change", () => {
        ed.subtitleIndex = subtitleSelect.value === "" ? null : Number(subtitleSelect.value);
        updateOptions();
    });

    for (const radio of [horizontalRadio, verticalRadio]) {
        radio.addEventListener("change", () => {
            ed.layout = verticalRadio.checked ? "vertical" : "horizontal";
            fillHeightOptions();
            updateOptions();
        });
    }

    fitSelect.addEventListener("change", () => {
        ed.fit = fitSelect.value;
        updateOptions();
    });

    cropSlider.addEventListener("input", () => {
        ed.cropX = Number(cropSlider.value) / 100;
        updateCropGuide();
    });

    // ----- crop guide -----

    // Outline of the 9:16 area a vertical crop keeps, drawn over the preview
    // with the rest dimmed. It ignores the pointer so the video controls
    // underneath keep working.
    const cropWindow = el("div", { class: "crop-window" });
    const cropGuide = el("div", { class: "crop-guide hidden" }, cropWindow);

    function updateCropGuide() {
        const visible = ed.layout === "vertical" && ed.fit === "crop";
        cropGuide.classList.toggle("hidden", !visible);
        if (!visible) return;
        // Where the picture is drawn inside the video element, which keeps
        // the picture's shape and centres it (16:9 until the stream loads).
        const boxW = video.clientWidth;
        const boxH = video.clientHeight;
        const sourceW = video.videoWidth || 16;
        const sourceH = video.videoHeight || 9;
        const scale = Math.min(boxW / sourceW, boxH / sourceH);
        const picW = sourceW * scale;
        const picH = sourceH * scale;
        cropGuide.style.left = `${(boxW - picW) / 2}px`;
        cropGuide.style.top = `${(boxH - picH) / 2}px`;
        cropGuide.style.width = `${picW}px`;
        cropGuide.style.height = `${picH}px`;
        // Same as the crop filter in media.py: the largest 9:16 area,
        // placed by cropX, and centred vertically in taller pictures.
        const cropW = Math.min(picW, (picH * 9) / 16);
        const cropH = Math.min(picH, (picW * 16) / 9);
        cropWindow.style.width = `${cropW}px`;
        cropWindow.style.height = `${cropH}px`;
        cropWindow.style.left = `${(picW - cropW) * ed.cropX}px`;
        cropWindow.style.top = `${(picH - cropH) / 2}px`;
    }

    video.addEventListener("loadedmetadata", updateCropGuide);
    // The player resizes with the window and the layout.
    const resizeObserver = new ResizeObserver(updateCropGuide);
    resizeObserver.observe(video);
    onLeave(() => resizeObserver.disconnect());

    // ----- range display and validation -----

    function updateRange() {
        startInput.value = fmtTime(ed.start);
        endInput.value = fmtTime(ed.end);
        startInput.classList.remove("invalid");
        endInput.classList.remove("invalid");
        range.style.left = percent(ed.start);
        range.style.width = `calc(${percent(ed.end)} - ${percent(ed.start)})`;
        startHandle.style.left = percent(ed.start);
        endHandle.style.left = percent(ed.end);
        timeline.querySelector(".tl-total").textContent = fmtTime(ed.duration, false);

        const length = ed.end - ed.start;
        const tooLong = maxClip > 0 && length > maxClip + 0.001;
        const tooShort = length < 0.5;
        durationLabel.textContent = `Clip length ${fmtTime(length)}`;
        durationLabel.classList.toggle("over", tooLong || tooShort);
        limitLabel.classList.toggle("hidden", !maxClip);
        createButton.disabled = !app.me.can_clip || tooLong || tooShort || createButton.dataset.busy === "1";
        createButton.title = tooLong
            ? `Clips can be at most ${fmtRuntime(maxClip)} long`
            : tooShort
              ? "The clip must be at least half a second long"
              : "";
    }

    // ----- create -----

    const jobList = createJobList(item.id, { emptyText: "Clips you make from this video appear here." });

    createButton.addEventListener("click", async () => {
        createButton.dataset.busy = "1";
        updateRange();
        try {
            const job = await api("/clips", {
                method: "POST",
                body: {
                    item_id: item.id,
                    source_id: ed.source.id,
                    start: ed.start,
                    end: ed.end,
                    mode: selectedMode(),
                    audio_index: ed.audioIndex,
                    max_height: selectedMode() === "precise" ? Number(heightSelect.value) : 0,
                    name: nameInput.value,
                    layout: ed.layout,
                    fit: ed.fit,
                    crop_x: ed.cropX,
                    subtitle_index: ed.subtitleIndex,
                    subtitle_style: styleSelect.value,
                },
            });
            jobList.add(job);
            // Clear the name so the next clip does not reuse it by accident.
            nameInput.value = "";
            toast("Clip queued. It will appear below when it is ready.");
        } catch (error) {
            toast(error.message, true);
        } finally {
            createButton.dataset.busy = "";
            updateRange();
        }
    });

    // ----- keyboard shortcuts -----

    function onKey(event) {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        // The target can be the document itself, which has no closest().
        const target = event.target instanceof Element ? event.target : document.body;
        if (target.closest("input, select, textarea")) return;
        // Let the native video controls handle their own keys when focused.
        const onVideo = target === video;
        switch (event.key) {
            case "i":
            case "I":
                setStart(sourceTime());
                break;
            case "o":
            case "O":
                setEnd(sourceTime());
                break;
            case "[":
                seek(ed.start);
                break;
            case "]":
                seek(ed.end);
                break;
            case "p":
            case "P":
                playSelection();
                break;
            case " ":
                if (onVideo || target.closest("button, a")) return;
                if (video.paused) video.play().catch(() => {});
                else video.pause();
                break;
            case "ArrowLeft":
                if (onVideo) return;
                seek(sourceTime() - (event.shiftKey ? 1 : 5));
                break;
            case "ArrowRight":
                if (onVideo) return;
                seek(sourceTime() + (event.shiftKey ? 1 : 5));
                break;
            case ",":
                seek(sourceTime() - 0.1);
                break;
            case ".":
                seek(sourceTime() + 0.1);
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    document.addEventListener("keydown", onKey);
    onLeave(() => document.removeEventListener("keydown", onKey));

    // Animation loop: moves the playhead and ends "play selection" precisely
    // (timeupdate events only fire about four times a second).
    let frame = 0;
    function tick() {
        const now = sourceTime();
        if (ed.stopAt !== null && !video.paused && now >= ed.stopAt) {
            video.pause();
            ed.stopAt = null;
        }
        playhead.style.left = percent(now);
        playheadLabel.textContent = `Playhead ${fmtTime(now)}`;
        frame = requestAnimationFrame(tick);
    }

    // ----- assemble the page -----

    const permissionNote = app.me.can_clip
        ? null
        : notice("Your Jellyfin account is not allowed to download media, so you cannot create clips.", true);

    const optionsPanel = el(
        "section",
        { class: "panel" },
        el("h3", {}, "Options"),
        sources.length > 1 ? el("label", { class: "field" }, el("span", {}, "Version"), versionSelect) : null,
        el("label", { class: "field" }, el("span", {}, "Audio track"), audioSelect),
        el("label", { class: "field" }, el("span", {}, "Burn in subtitles"), subtitleSelect),
        styleField,
        subtitleNote,
        el(
            "div",
            { class: "field" },
            el("span", {}, "Shape"),
            el(
                "div",
                { class: "segmented" },
                el("label", {}, horizontalRadio, el("span", {}, "Horizontal")),
                el("label", {}, verticalRadio, el("span", {}, "Vertical (phone)")),
            ),
        ),
        fitField,
        cropField,
        el(
            "div",
            { class: "field" },
            el("span", {}, "Mode"),
            el(
                "div",
                { class: "modes" },
                el(
                    "label",
                    { class: "mode" },
                    fastRadio,
                    el(
                        "div",
                        {},
                        el("strong", {}, "Fast"),
                        el("small", {}, "Copies the original video without re-encoding. Done in seconds at full quality, but the cut has to begin on a keyframe, so some players show a few extra frames before your start point."),
                    ),
                ),
                el(
                    "label",
                    { class: "mode" },
                    preciseRadio,
                    el(
                        "div",
                        {},
                        el("strong", {}, "Precise"),
                        el("small", {}, "Re-encodes to H.264 MP4. Frame accurate and plays everywhere, but takes longer. HDR is converted to SDR."),
                    ),
                ),
            ),
        ),
        modeNote,
        heightField,
        el("label", { class: "field" }, el("span", {}, "Clip name"), nameInput),
        outputNote,
        createButton,
    );

    show(
        editorHeader(item),
        el(
            "div",
            { class: "editor" },
            el(
                "div",
                {},
                el("div", { class: "player" }, video, cropGuide),
                playerError,
                timeline,
                el(
                    "div",
                    { class: "range-controls" },
                    rangeRow("Start", startInput, "start"),
                    rangeRow("End", endInput, "end"),
                    el(
                        "div",
                        { class: "range-summary" },
                        durationLabel,
                        limitLabel,
                        el("button", { class: "btn small", type: "button", title: "Play from start to end (P)", onclick: playSelection }, "▶ Play selection"),
                    ),
                ),
                el(
                    "div",
                    { class: "shortcuts" },
                    "Shortcuts: ",
                    el("kbd", {}, "I"), " / ", el("kbd", {}, "O"), " set start / end at the playhead, ",
                    el("kbd", {}, "["), " / ", el("kbd", {}, "]"), " jump to start / end, ",
                    el("kbd", {}, "P"), " play selection, ",
                    el("kbd", {}, "Space"), " play / pause, ",
                    el("kbd", {}, "←"), " ", el("kbd", {}, "→"), " 5 s (", el("kbd", {}, "Shift"), " 1 s), ",
                    el("kbd", {}, ","), " ", el("kbd", {}, "."), " 0.1 s.",
                ),
            ),
            el(
                "div",
                {},
                permissionNote,
                optionsPanel,
                el("section", { class: "panel" }, el("h3", {}, "Clips from this video"), jobList.element),
            ),
        ),
    );

    fillAudioOptions();
    fillHeightOptions();
    fillSubtitleOptions();
    updateOptions();
    updateRange();
    startPreview(0);
    jobList.refresh();
    frame = requestAnimationFrame(tick);

    // Stop the Jellyfin transcode when leaving the editor or closing the tab.
    window.addEventListener("pagehide", stopPreview);
    onLeave(() => {
        cancelAnimationFrame(frame);
        window.removeEventListener("pagehide", stopPreview);
        stopPreview();
    });
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

async function start() {
    document.getElementById("search-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const query = document.getElementById("search-input").value.trim();
        if (!query) return;
        const target = `#/search?${new URLSearchParams({ q: query })}`;
        // Searching for the same thing again does not change the hash, so no
        // hashchange event fires; re-run the route directly instead.
        if (location.hash === target) route();
        else location.hash = target;
    });

    document.getElementById("logout").addEventListener("click", async () => {
        runCleanups();
        try {
            await api("/logout", { method: "POST", body: {} });
        } finally {
            window.location.href = `${BASE}login`;
        }
    });

    try {
        app.me = await api("/me");
    } catch (error) {
        show(notice(error.message, true));
        return;
    }
    document.getElementById("user-name").textContent = app.me.name;
    window.addEventListener("hashchange", route);
    route();
}

start();
