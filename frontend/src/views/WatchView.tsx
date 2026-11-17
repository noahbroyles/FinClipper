import { ClipPlayer } from "../components/ClipPlayer";
import { ReclipLink } from "../components/ReclipLink";
import { ShareButton } from "../components/ShareButton";
import { LoadStatus, Notice } from "../components/ui";
import { useLoad } from "../hooks/useLoad";
import { api, BASE } from "../lib/api";
import { fmtBytes, fmtRuntime } from "../lib/format";
import { useMe } from "../lib/me";
import type { WatchClip } from "../types";

// The page for one clip: a player, with a link that can be shared. It opens
// for the user's own clips and for public clips of videos their Jellyfin
// account can see; the server answers "not available" for anything else.
export function WatchView({ clipId }: { clipId: string }) {
    const me = useMe();
    const state = useLoad(() => api<WatchClip>(`/watch/${clipId}`));
    if (state.status !== "ready") {
        return (
            <>
                {state.status === "error" ? <BackLink mine={false} /> : null}
                <LoadStatus state={state} />
            </>
        );
    }

    const clip = state.data;
    // The owner's own address works whether or not the clip is public.
    const downloadUrl = `${BASE}api/${clip.mine ? "clips" : "public-clips"}/${clip.id}/download`;
    let length = fmtRuntime(clip.duration) || "0s";
    if (clip.parts.length > 1) length = `${clip.parts.length} parts, ${length}`;
    const sharer = clip.mine ? "you" : clip.owner_name || "another user";

    return (
        <div class="watch">
            <BackLink mine={clip.mine} />
            <h1>{clip.name || clip.title}</h1>
            <div class="muted">
                From <a href={`#/item/${clip.item_id}`}>{clip.title}</a>
                {` · ${clip.public ? `Shared by ${sharer}` : "Private"} · ${length} · ${fmtBytes(clip.size)}`}
            </div>
            {!clip.can_download ? (
                <Notice>Your Jellyfin account is not allowed to download media, so you cannot watch or download clips.</Notice>
            ) : clip.playable ? (
                <ClipPlayer src={`${downloadUrl}?inline=1`} />
            ) : (
                <Notice>Browsers cannot play this kind of clip (MKV). Download it to watch it.</Notice>
            )}
            <div class="job-meta">{clip.description}</div>
            <div class="job-actions">
                {clip.can_download ? (
                    <a class="btn small primary" href={downloadUrl} download={clip.filename}>
                        Download
                    </a>
                ) : null}
                {clip.public ? <ShareButton clipId={clip.id} /> : null}
                {me.can_clip ? <ReclipLink itemId={clip.item_id} clipId={clip.id} /> : null}
            </div>
            {clip.public ? null : (
                <p class="muted">
                    This clip is private, so only you can open this page. Use "Make public" under My clips to share it.
                </p>
            )}
        </div>
    );
}

function BackLink({ mine }: { mine: boolean }) {
    return (
        <a class="watch-back" href={mine ? "#/clips" : "#/public"}>
            {mine ? "← My clips" : "← Public clips"}
        </a>
    );
}
