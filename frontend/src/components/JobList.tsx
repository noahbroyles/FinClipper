// The list of the user's own clips, with their progress and actions.
// Shared by the editor and the "My clips" page.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { CLIP_NAME_MAX } from "../constants";
import { isActive, type ClipJobs } from "../hooks/useClipJobs";
import { api, BASE } from "../lib/api";
import { errorMessage, fmtBytes, fmtRuntime, fmtTime } from "../lib/format";
import { navigate } from "../lib/router";
import { toast } from "../lib/toast";
import { ClipPlayer } from "./ClipPlayer";
import type { ClipRange, Job } from "../types";

export function jobStatusText(job: Job): string {
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

interface ListProps {
    clips: ClipJobs;
    // Link each clip to the video it was cut from.
    showItemLink?: boolean;
    emptyText?: string;
}

export function JobList({ clips, showItemLink = false, emptyText = "No clips yet." }: ListProps) {
    // Id of the clip whose rename form is open, if any.
    const [renaming, setRenaming] = useState<string | null>(null);

    // Run an action on a clip. A failure is reported, and either way the
    // list is fetched again to show the result.
    async function run(action: () => Promise<unknown>, failureMessage: string): Promise<void> {
        try {
            await action();
        } catch (error) {
            toast(errorMessage(error) || failureMessage, true);
        }
        await clips.refresh();
    }

    if (!clips.jobs.length) {
        return (
            <div class="jobs">
                <div class="muted">{emptyText}</div>
            </div>
        );
    }
    return (
        <div class="jobs">
            {clips.jobs.map((job) => (
                <JobRow
                    key={job.id}
                    job={job}
                    showItemLink={showItemLink}
                    renaming={renaming === job.id}
                    onRenameStart={() => setRenaming(job.id)}
                    onRenameCancel={() => setRenaming(null)}
                    onRenamed={(updated) => {
                        clips.replace(updated);
                        setRenaming(null);
                    }}
                    run={run}
                />
            ))}
        </div>
    );
}

interface RowProps {
    job: Job;
    showItemLink: boolean;
    renaming: boolean;
    onRenameStart(): void;
    onRenameCancel(): void;
    onRenamed(updated: Job): void;
    run(action: () => Promise<unknown>, failureMessage: string): Promise<void>;
}

function JobRow({ job, showItemLink, renaming, onRenameStart, onRenameCancel, onRenamed, run }: RowProps) {
    const [watching, setWatching] = useState(false);
    const active = isActive(job);
    const downloadUrl = `${BASE}api/clips/${job.id}/download`;
    // Opens the editor for the clip's video with this clip's settings.
    const reclipUrl = `#/item/${job.item_id}?${new URLSearchParams({ reclip: job.id })}`;
    const percent = `${Math.round(job.progress * 100)}%`;
    const itemTitle = showItemLink ? <a href={`#/item/${job.item_id}`}>{job.title}</a> : job.title;

    // Sharing puts the clip under "Public clips" for other users.
    async function toggleShared(): Promise<void> {
        await api(`/clips/${job.id}/public`, { method: "POST", body: { public: !job.public } });
        toast(
            job.public
                ? "The clip is private again."
                : "Shared. Other users who can see this video in Jellyfin will find it under Public clips.",
        );
    }

    return (
        <div class="job">
            {/* A named clip shows its name as the heading and the video title
                underneath; an unnamed clip just shows the video title. */}
            {renaming ? (
                <RenameForm job={job} onRenamed={onRenamed} onCancel={onRenameCancel} />
            ) : (
                <div class="job-title" title={job.name || job.title}>
                    {job.name || itemTitle}
                </div>
            )}
            {job.name ? (
                <div class="job-meta job-item" title={job.title}>
                    {itemTitle}
                </div>
            ) : null}
            <ClipRanges parts={job.parts} duration={job.duration} />
            <div class="job-meta">{job.description}</div>
            <div class={`job-status ${job.status}`}>
                {jobStatusText(job)}
                {job.public ? <span class="badge">Public</span> : null}
            </div>
            {active ? (
                <div class="progress">
                    <div style={{ width: percent }} />
                </div>
            ) : null}
            {watching && job.status === "done" ? <ClipPlayer src={`${downloadUrl}?inline=1`} /> : null}
            <div class="job-actions">
                {job.status === "done" ? (
                    <a class="btn small primary" href={downloadUrl} download={job.filename}>
                        Download
                    </a>
                ) : null}
                {/* Only MP4 clips can be watched; browsers rarely play MKV. */}
                {job.status === "done" && job.playable ? (
                    <button class="btn small" type="button" aria-pressed={watching} onClick={() => setWatching(!watching)}>
                        Watch
                    </button>
                ) : null}
                <button class="btn small" type="button" onClick={onRenameStart}>
                    Rename
                </button>
                {job.status === "done" ? (
                    <button class="btn small" type="button" onClick={() => run(toggleShared, "Could not change sharing")}>
                        {job.public ? "Make private" : "Make public"}
                    </button>
                ) : null}
                <a
                    class="btn small"
                    href={reclipUrl}
                    title="Open the editor with this clip's settings, to make a changed copy"
                    onClick={(event) => {
                        event.preventDefault();
                        navigate(reclipUrl);
                    }}
                >
                    Re-clip
                </a>
                {active ? (
                    <button
                        class="btn small"
                        type="button"
                        onClick={() => run(() => api(`/clips/${job.id}/cancel`, { method: "POST", body: {} }), "Cancel failed")}
                    >
                        Cancel
                    </button>
                ) : (
                    <button
                        class="btn small danger"
                        type="button"
                        onClick={() => run(() => api(`/clips/${job.id}`, { method: "DELETE" }), "Delete failed")}
                    >
                        Delete
                    </button>
                )}
            </div>
        </div>
    );
}

// The time range of a clip and its length, or for a multi-part clip the
// number of parts, the total length, and then each part's range.
export function ClipRanges({ parts, duration }: { parts: ClipRange[]; duration: number }) {
    const length = fmtRuntime(duration) || "0s";
    const range = (part: ClipRange) => `${fmtTime(part.start)} → ${fmtTime(part.end)}`;
    const only = parts.length === 1 ? parts[0] : undefined;
    if (only) return <div class="job-meta mono">{`${range(only)}  (${length})`}</div>;
    return (
        <div class="job-meta mono">
            {`${parts.length} parts  (${length})`}
            <ol class="job-parts">
                {parts.map((part, index) => (
                    <li key={index}>{range(part)}</li>
                ))}
            </ol>
        </div>
    );
}

interface RenameProps {
    job: Job;
    onRenamed(updated: Job): void;
    onCancel(): void;
}

// Inline form that replaces the title of the clip being renamed. What has
// been typed is this component's own state, so the list refreshing once a
// second around it does not disturb the typing.
function RenameForm({ job, onRenamed, onCancel }: RenameProps) {
    const [name, setName] = useState(job.name);
    const [saving, setSaving] = useState(false);
    const input = useRef<HTMLInputElement>(null);

    // A layout effect, so the field has focus before the next key press.
    useLayoutEffect(() => {
        input.current?.focus();
        input.current?.select();
    }, []);

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setSaving(true);
        try {
            onRenamed(await api<Job>(`/clips/${job.id}/rename`, { method: "POST", body: { name } }));
        } catch (error) {
            // Keep the form open so the typed name is not lost.
            toast(errorMessage(error), true);
            setSaving(false);
        }
    }

    return (
        <form class="job-rename" onSubmit={submit}>
            <input
                ref={input}
                type="text"
                maxLength={CLIP_NAME_MAX}
                placeholder={job.title}
                spellcheck={false}
                autocomplete="off"
                aria-label="Clip name"
                value={name}
                onInput={(event) => setName(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        event.preventDefault();
                        onCancel();
                    }
                }}
            />
            <button class="btn small primary" type="submit" disabled={saving}>
                Save
            </button>
            <button class="btn small" type="button" onClick={onCancel}>
                Cancel
            </button>
        </form>
    );
}
