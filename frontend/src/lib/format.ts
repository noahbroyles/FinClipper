// Formatting and parsing of times and sizes. No DOM access, so these can be
// unit tested with "bun test".

export function clamp(value: number, low: number, high: number): number {
    return Math.min(high, Math.max(low, value));
}

// 83.5 -> "00:01:23.500"
export function fmtTime(seconds: number, withMillis = true): string {
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
export function parseTime(text: string): number {
    const match = /^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(text.trim());
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
export function fmtRuntime(seconds: number | null | undefined): string {
    if (!seconds) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h) return `${h}h ${m}m`;
    if (m) return s ? `${m}m ${s}s` : `${m}m`;
    return `${s}s`;
}

export function fmtBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// crypto.randomUUID only exists on HTTPS pages, but getRandomValues works
// on plain HTTP too, which matters for apps reached by LAN IP address.
export function randomHex(bytes: number): string {
    const values = new Uint8Array(bytes);
    crypto.getRandomValues(values);
    return Array.from(values, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Join class names, skipping the ones that are switched off.
export function classes(...names: Array<string | false | null | undefined>): string {
    return names.filter(Boolean).join(" ");
}

// The message of something caught by a catch block.
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
