import { useState } from "preact/hooks";
import { ClipPlayer } from "../components/ClipPlayer";
import { LoadStatus, Notice, PageHead } from "../components/ui";
import { useLoad } from "../hooks/useLoad";
import { api, BASE } from "../lib/api";
import { errorMessage, fmtBytes, fmtRuntime } from "../lib/format";
import { publicRetentionText, useMe } from "../lib/me";
import { toast } from "../lib/toast";
import type { PublicClip, PublicClipList } from "../types";

// Clips other users (and you) have shared. The server only lists clips cut
// from videos your Jellyfin account can see.
export function PublicView() {
    const state = useLoad(() => api<PublicClipList>("/public-clips"));
    if (state.status !== "ready") return <LoadStatus state={state} />;
    return <PublicClips initial={state.data.items} canDownload={state.data.can_download} />;
}

function PublicClips({ initial, canDownload }: { initial: PublicClip[]; canDownload: boolean }) {
    const me = useMe();
    const [clips, setClips] = useState(initial);

    async function unshare(clip: PublicClip): Promise<void> {
        try {
            await api(`/clips/${clip.id}/public`, { method: "POST", body: { public: false } });
        } catch (error) {
            toast(errorMessage(error), true);
            return;
        }
        setClips((current) => current.filter((other) => other.id !== clip.id));
        toast(clip.mine ? "The clip is private again." : "The clip was taken down.");
    }

    const retention =
        "Clips shared by people on this server, from videos your Jellyfin account can see. " +
        publicRetentionText(
            me,
            "They stay here until the person who shared them makes them private.",
            "Shared clips are removed {hours} hours after they are shared.",
        );
    return (
        <>
            <PageHead title="Public clips" />
            <p class="muted">{retention}</p>
            {canDownload ? null : (
                <Notice>Your Jellyfin account is not allowed to download media, so you cannot watch or download clips.</Notice>
            )}
            <div class="jobs">
                {/* Owners can stop sharing; administrators can take down anyone's clip. */}
                {clips.length ? (
                    clips.map((clip) => (
                        <PublicClipRow
                            key={clip.id}
                            clip={clip}
                            canDownload={canDownload}
                            canUnshare={clip.mine || me.is_admin}
                            onUnshare={() => unshare(clip)}
                        />
                    ))
                ) : (
                    <div class="muted">
                        No public clips yet. Use "Make public" on one of your clips under My clips to share it.
                    </div>
                )}
            </div>
        </>
    );
}

interface RowProps {
    clip: PublicClip;
    canDownload: boolean;
    canUnshare: boolean;
    onUnshare(): void;
}

function PublicClipRow({ clip, canDownload, canUnshare, onUnshare }: RowProps) {
    const [watching, setWatching] = useState(false);
    const downloadUrl = `${BASE}api/public-clips/${clip.id}/download`;
    const itemTitle = <a href={`#/item/${clip.item_id}`}>{clip.title}</a>;
    const sharer = clip.mine ? "you" : clip.owner_name || "another user";
    let length = fmtRuntime(clip.duration) || "0s";
    if (clip.parts.length > 1) length = `${clip.parts.length} parts, ${length}`;
    return (
        <div class="job">
            {/* Same layout as "My clips": a named clip shows the video title below its name. */}
            <div class="job-title" title={clip.name || clip.title}>
                {clip.name || itemTitle}
            </div>
            {clip.name ? (
                <div class="job-meta job-item" title={clip.title}>
                    {itemTitle}
                </div>
            ) : null}
            <div class="job-meta">{`Shared by ${sharer} · ${length} · ${fmtBytes(clip.size)}`}</div>
            <div class="job-meta">{clip.description}</div>
            {watching ? <ClipPlayer src={`${downloadUrl}?inline=1`} /> : null}
            {canDownload || canUnshare ? (
                <div class="job-actions">
                    {/* Only MP4 clips can be watched; browsers rarely play MKV. */}
                    {canDownload && clip.playable ? (
                        <button class="btn small primary" type="button" onClick={() => setWatching(!watching)}>
                            Watch
                        </button>
                    ) : null}
                    {canDownload ? (
                        <a class="btn small" href={downloadUrl} download={clip.filename}>
                            Download
                        </a>
                    ) : null}
                    {canUnshare ? (
                        <button class="btn small danger" type="button" onClick={onUnshare}>
                            {clip.mine ? "Make private" : "Take down"}
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
