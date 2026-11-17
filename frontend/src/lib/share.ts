// Links to the page that plays one clip, and copying them.

// Address of a clip's watch page within the app: "#/watch/<id>". The Watch
// buttons open it in a new tab, so the list they are in stays as it was.
export function watchHref(clipId: string): string {
    return `#/watch/${clipId}`;
}

// The full address of a clip's watch page, to send to someone else. It
// only opens for people who can sign in here, and for another user's clip
// only while the clip is public.
export function watchUrl(clipId: string): string {
    return new URL(watchHref(clipId), window.location.href).href;
}

// Put text on the clipboard. Returns whether it worked.
export async function copyText(text: string): Promise<boolean> {
    // The clipboard API only exists on HTTPS pages (and localhost).
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Fall through to the older way.
        }
    }
    // Plain HTTP, as when the app is reached by its LAN address: select the
    // text in an off-screen field and ask the browser to copy the selection.
    const field = document.createElement("textarea");
    field.value = text;
    field.readOnly = true;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    let copied = false;
    try {
        copied = document.execCommand("copy");
    } catch {
        // Not allowed here either.
    }
    field.remove();
    return copied;
}
