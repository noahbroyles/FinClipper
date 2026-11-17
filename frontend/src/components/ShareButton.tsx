import { copyText, watchUrl } from "../lib/share";
import { toast } from "../lib/toast";

// Copies the address of a public clip's watch page, to send to someone.
export function ShareButton({ clipId }: { clipId: string }) {
    async function share(): Promise<void> {
        const url = watchUrl(clipId);
        if (await copyText(url)) toast("Link to this clip copied.");
        // Shown instead, so it can still be copied by hand.
        else toast(`Could not copy the link. It is: ${url}`, true);
    }

    return (
        <button class="btn small icon" type="button" title="share" aria-label="Share: copy a link to this clip" onClick={share}>
            <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
            >
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
                <line x1="15.4" y1="6.5" x2="8.6" y2="10.5" />
            </svg>
        </button>
    );
}
