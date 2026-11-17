import { JobList } from "../components/JobList";
import { PageHead, Spinner } from "../components/ui";
import { useClipJobs } from "../hooks/useClipJobs";
import { publicRetentionText, useMe } from "../lib/me";

// "My clips": every clip the signed in user has made.
export function ClipsView() {
    const me = useMe();
    const clips = useClipJobs(null);
    if (!clips.loaded) return <Spinner />;

    const retention =
        `Finished clips are deleted ${me.clip_retention_hours} hours after they are made ` +
        "(or after you make them private), so download the ones you want to keep. " +
        publicRetentionText(
            me,
            "Public clips stay until you make them private.",
            "Public clips are deleted {hours} hours after you share them.",
        );
    return (
        <>
            <PageHead title="My clips" />
            <p class="muted">{retention}</p>
            <JobList clips={clips} showItemLink emptyText="You have no clips. Open a movie or episode to make one." />
        </>
    );
}
